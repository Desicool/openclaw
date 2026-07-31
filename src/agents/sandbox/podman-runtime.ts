import os from "node:os";
import path from "node:path";
import { isPathInside } from "../../infra/path-guards.js";
import { splitSandboxBindSpec } from "./bind-spec.js";
import {
  execContainer,
  PODMAN_SANDBOX_ENGINE,
  type SandboxContainerEngine,
  type SandboxContainerEngineTarget,
} from "./container-engine.js";
import { hashTextSha256 } from "./hash.js";
import { resolveSandboxHostPathViaExistingAncestor } from "./host-paths.js";
import type { SandboxConfig, SandboxDockerConfig, SandboxWorkspaceAccess } from "./types.js";
import type { ReadOnlyWorkspaceSkillMount } from "./workspace-mounts.js";

const SANDBOX_ENGINE_PROBE_TIMEOUT_MS = 5_000;
const PODMAN_INIT_PATH = "/run/podman-init";

export type PodmanSandboxRuntimeInfo = {
  machine: boolean;
  rootless: boolean;
  target: SandboxContainerEngineTarget;
};

function hashPodmanTarget(kind: "machine" | "socket", ...parts: string[]): string {
  return `${kind}:${hashTextSha256(parts.join("\0")).slice(0, 32)}`;
}

function invalidPodmanConfig(message: string): Error {
  return Object.assign(new Error(message), { code: "INVALID_CONFIG" });
}

function resolvePodmanKeepIdMode(user: string | undefined): string {
  const normalized = user?.trim();
  if (!normalized) {
    return "keep-id";
  }
  const match = /^(\d+)(?::(\d+))?$/u.exec(normalized);
  if (!match) {
    throw invalidPodmanConfig(
      `Rootless Podman sandbox user "${normalized}" must be a numeric UID or UID:GID so keep-id can preserve bind-mount ownership.`,
    );
  }
  const [, uid, gid] = match;
  if (uid === "0" || gid === "0") {
    throw invalidPodmanConfig(
      `Rootless Podman sandbox user "${normalized}" cannot use UID or GID 0 while preserving workspace bind ownership. Bake root-required setup into the image or use rootful Podman.`,
    );
  }
  return gid ? `keep-id:uid=${uid},gid=${gid}` : `keep-id:uid=${uid}`;
}

async function assertSupportedPodmanConnection(remoteSocketPath: string): Promise<{
  machine: boolean;
  target: SandboxContainerEngineTarget;
}> {
  const result = await execContainer(
    PODMAN_SANDBOX_ENGINE,
    ["system", "connection", "list", "--format", "json"],
    {
      allowFailure: true,
      signal: AbortSignal.timeout(SANDBOX_ENGINE_PROBE_TIMEOUT_MS),
    },
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
    throw new Error(`Failed to inspect the active Podman connection: ${detail}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error("Podman returned invalid connection metadata", { cause: error });
  }
  const connections = Array.isArray(parsed)
    ? parsed.filter(
        (entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null,
      )
    : [];
  const configuredUri = process.env.CONTAINER_HOST?.trim();
  const configuredName = process.env.CONTAINER_CONNECTION?.trim();
  let selected: Record<string, unknown> | undefined;
  // Podman resolves the explicit URL/CONTAINER_HOST before named or saved destinations.
  if (configuredUri) {
    selected = connections.find((entry) => entry.URI === configuredUri);
  } else if (configuredName) {
    selected = connections.find((entry) => entry.Name === configuredName);
  } else {
    // OpenClaw supplies no Podman global connection flag, so Podman's documented
    // selection order reaches the saved default after the env overrides above.
    selected = connections.find((entry) => entry.Default === true);
  }
  const selectedUri =
    configuredUri ||
    (typeof selected?.URI === "string" ? selected.URI : "") ||
    (remoteSocketPath ? `unix://${remoteSocketPath}` : "");
  const unsupportedRemoteError = () =>
    invalidPodmanConfig(
      "Podman sandboxing supports a local Podman engine or Podman Machine, but the active Podman connection is remote or could not be identified. Use the SSH sandbox backend for a remote host.",
    );
  if (!configuredUri && configuredName && !selected) {
    throw unsupportedRemoteError();
  }
  if (!selectedUri) {
    throw unsupportedRemoteError();
  }
  if (selectedUri && !selectedUri.startsWith("unix://")) {
    if (selected?.IsMachine === true) {
      const identity =
        process.env.CONTAINER_SSHKEY?.trim() ||
        (typeof selected.Identity === "string" ? selected.Identity : "");
      return {
        machine: true,
        target: {
          key: hashPodmanTarget("machine", selectedUri, identity),
          globalArgs: ["--url", selectedUri, ...(identity ? ["--identity", identity] : [])],
        },
      };
    }
    throw unsupportedRemoteError();
  }
  return {
    machine: false,
    target: {
      key: hashPodmanTarget("socket", selectedUri),
      globalArgs: ["--url", selectedUri],
    },
  };
}

export async function resolvePodmanSandboxRuntimeInfo(): Promise<PodmanSandboxRuntimeInfo> {
  const result = await execContainer(
    PODMAN_SANDBOX_ENGINE,
    [
      "info",
      "--format",
      "{{.Host.Security.Rootless}}\t{{.Host.ServiceIsRemote}}\t{{.Host.RemoteSocket.Path}}",
    ],
    {
      allowFailure: true,
      signal: AbortSignal.timeout(SANDBOX_ENGINE_PROBE_TIMEOUT_MS),
    },
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
    throw new Error(`Failed to inspect Podman user namespace mode: ${detail}`);
  }
  const [rootless = "", serviceIsRemote = "", remoteSocketPath = ""] = result.stdout
    .trim()
    .split("\t", 3);
  let machine = false;
  let target: SandboxContainerEngineTarget = { key: "local", globalArgs: [] };
  if (serviceIsRemote === "true") {
    ({ machine, target } = await assertSupportedPodmanConnection(remoteSocketPath));
  }
  return { machine, rootless: rootless === "true", target };
}

export async function validateSandboxContainerEngineTarget(
  engine: SandboxContainerEngine,
  expectedTarget?: SandboxContainerEngineTarget,
): Promise<void> {
  if (engine.id === "podman") {
    // Podman resolves its active connection for every invocation. Validate once
    // at the start of each lifecycle sequence so context changes cannot reuse stale approval.
    const runtimeInfo = await resolvePodmanSandboxRuntimeInfo();
    assertPodmanSandboxTarget(expectedTarget, runtimeInfo.target);
  }
}

export function assertPodmanSandboxTarget(
  expectedTarget: SandboxContainerEngineTarget | undefined,
  actualTarget: SandboxContainerEngineTarget,
): void {
  if (
    expectedTarget &&
    (actualTarget.key !== expectedTarget.key ||
      actualTarget.globalArgs.length !== expectedTarget.globalArgs.length ||
      actualTarget.globalArgs.some((arg, index) => arg !== expectedTarget.globalArgs[index]))
  ) {
    throw invalidPodmanConfig(
      "The active Podman connection changed after this sandbox runtime was created. Restore the original Podman target before inspecting, executing, or removing the runtime.",
    );
  }
}

export function bindPodmanSandboxEngine(
  target: SandboxContainerEngineTarget,
): SandboxContainerEngine {
  return {
    ...PODMAN_SANDBOX_ENGINE,
    globalArgs: target.globalArgs,
  };
}

function mountTargetCoversPodmanInit(target: string): boolean {
  const normalizedTarget = path.posix.normalize(target.trim());
  return (
    normalizedTarget === "/" ||
    normalizedTarget === PODMAN_INIT_PATH ||
    PODMAN_INIT_PATH.startsWith(`${normalizedTarget}/`) ||
    normalizedTarget.startsWith(`${PODMAN_INIT_PATH}/`)
  );
}

function assertPodmanMachineBindSourcesSupported(params: {
  cfg: SandboxDockerConfig;
  workspaceDir: string;
  workspaceAccess: SandboxWorkspaceAccess;
  agentWorkspaceDir: string;
  readOnlyWorkspaceSkillMounts: readonly ReadOnlyWorkspaceSkillMount[];
}): void {
  const hostHome = resolveSandboxHostPathViaExistingAncestor(path.resolve(os.homedir()));
  const sources = new Set<string>([params.workspaceDir]);
  if (params.workspaceAccess !== "none" && params.workspaceDir !== params.agentWorkspaceDir) {
    sources.add(params.agentWorkspaceDir);
  }
  for (const mount of params.readOnlyWorkspaceSkillMounts) {
    sources.add(mount.hostPath);
  }
  for (const bind of params.cfg.binds ?? []) {
    const source = splitSandboxBindSpec(bind)?.host.trim();
    if (source) {
      sources.add(source);
    }
  }

  for (const source of sources) {
    const canonicalSource = resolveSandboxHostPathViaExistingAncestor(path.resolve(source));
    if (isPathInside(hostHome, canonicalSource)) {
      continue;
    }
    throw invalidPodmanConfig(
      `Podman Machine sandbox bind source "${source}" is outside the default host home share "${os.homedir()}". Move the workspace or bind under the host home directory, or use Docker or the SSH sandbox backend.`,
    );
  }
}

export function resolvePodmanSandboxCreatePolicy(params: {
  cfg: SandboxDockerConfig;
  dockerTmpfsSource: SandboxConfig["dockerTmpfsSource"];
  workspaceDir: string;
  workspaceAccess: SandboxWorkspaceAccess;
  agentWorkspaceDir: string;
  readOnlyWorkspaceSkillMounts: readonly ReadOnlyWorkspaceSkillMount[];
  runtimeInfo: PodmanSandboxRuntimeInfo;
}): {
  cfg: SandboxDockerConfig;
  extraCreateArgs: string[];
} {
  const cfg =
    params.dockerTmpfsSource === "default"
      ? {
          ...params.cfg,
          // The shared default includes bare /run, but Podman mounts its init there.
          // Read-only roots get Podman's native /run tmpfs below; writable roots use /run directly.
          tmpfs: params.cfg.tmpfs.filter((entry) => entry.trim() !== "/run"),
        }
      : params.cfg;
  const hasInitMountConflict =
    // workdir is also the managed workspace bind target, not only the process cwd.
    mountTargetCoversPodmanInit(params.cfg.workdir) ||
    cfg.tmpfs.some((entry) => mountTargetCoversPodmanInit(entry.split(":", 1)[0]?.trim() || "")) ||
    params.cfg.binds?.some((bind) => {
      const target = splitSandboxBindSpec(bind)?.container.trim();
      return target ? mountTargetCoversPodmanInit(target) : false;
    }) === true;
  if (hasInitMountConflict) {
    throw invalidPodmanConfig(
      "Podman sandbox configuration would cover Podman's init path at /run/podman-init. Remove the conflicting tmpfs or bind mount so orphaned sandbox processes can be reaped.",
    );
  }
  if (params.runtimeInfo.machine) {
    assertPodmanMachineBindSourcesSupported(params);
  }

  const extraCreateArgs = ["--http-proxy=false"];
  if (params.cfg.readOnlyRoot) {
    extraCreateArgs.push("--read-only-tmpfs=true");
  }
  if (params.runtimeInfo.rootless) {
    // Map the invoking engine user to the selected container identity. Plain
    // keep-id is insufficient when docker.user differs from the host UID/GID.
    extraCreateArgs.push("--userns", resolvePodmanKeepIdMode(params.cfg.user));
  }
  return { cfg, extraCreateArgs };
}

export function resolvePodmanSandboxConfigHash(params: {
  genericConfigHash: string;
  configuredUser: boolean;
  dockerTmpfsSource: SandboxConfig["dockerTmpfsSource"];
}): string {
  const userMode = params.configuredUser ? "configured-user" : "keep-id";
  return `${params.genericConfigHash}:podman-runtime-v8:${userMode}:${params.dockerTmpfsSource}`;
}

export function resolvePodmanSandboxContainerPrefix(containerPrefix: string): string {
  return `${containerPrefix}podman-`;
}
