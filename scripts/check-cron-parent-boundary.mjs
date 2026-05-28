#!/usr/bin/env node
// Enforces the cron parent/child boundary (see Phase 2 plan §3): cron scheduler
// modules must not statically import delivery-side code that belongs to the
// child runner. Violations escape capability isolation at the parent.
//
// Wired into the `check:import-cycles` lane so the existing architecture gate
// fails on any new violation.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SOURCE_PATTERNS = [
  /^src\/cron\/service\/.+\.(?:ts|tsx)$/,
  /^src\/cron\/store\.ts$/,
  /^src\/cron\/active-jobs\.ts$/,
  /^src\/cron\/schedule\.ts$/,
];

const FORBIDDEN_TARGET_PATTERNS = [
  /^src\/channels(\/|$)/,
  /^src\/cli\/run-cron-job(\/|$)/,
  /^src\/cron\/isolated-agent\/delivery-dispatch(\.|$)/,
];

const IGNORED_PATH_PART = /(^|\/)(node_modules|dist|build|coverage|\.artifacts|\.git)(\/|$)/;
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];
// Matches: side-effect imports (`import "x"`), default/named/namespace imports
// (`import ... from "x"`), and re-exports (`export ... from "x"`). Both static
// import forms are needed; dynamic `import("x")` is out of scope for this gate.
const IMPORT_SPEC_REGEX =
  /(?:^|\n)\s*(?:import\s+(?:(?:type\s+)?[^"';\n]*?from\s*)?|export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s*from\s*)["']([^"']+)["']/g;

function isSourceFile(repoPath) {
  return (
    SOURCE_EXTENSIONS.some((extension) => repoPath.endsWith(extension)) &&
    !repoPath.endsWith(".d.ts")
  );
}

function normalizeRepoPath(absolute) {
  return path.relative(repoRoot, absolute).split(path.sep).join("/");
}

function walk(absoluteRoot) {
  const repoPath = normalizeRepoPath(absoluteRoot);
  if (IGNORED_PATH_PART.test(repoPath)) {
    return [];
  }
  const stats = statSync(absoluteRoot);
  if (stats.isFile()) {
    return isSourceFile(repoPath) ? [repoPath] : [];
  }
  if (!stats.isDirectory()) {
    return [];
  }
  return readdirSync(absoluteRoot, { withFileTypes: true }).flatMap((entry) =>
    walk(path.join(absoluteRoot, entry.name)),
  );
}

function fileMatchesSource(repoPath) {
  return SOURCE_PATTERNS.some((pattern) => pattern.test(repoPath));
}

function resolveSpecifierToRepoPath(importerRepoPath, specifier) {
  if (!specifier.startsWith(".")) {
    return null;
  }
  const importerDir = path.posix.dirname(importerRepoPath);
  const base = path.posix.normalize(path.posix.join(importerDir, specifier));
  const stripped = base.replace(/\.js$/, "");
  return stripped;
}

function targetIsForbidden(targetRepoPath) {
  return FORBIDDEN_TARGET_PATTERNS.some((pattern) => pattern.test(targetRepoPath));
}

function collectStaticSpecifiers(fileContent) {
  const specs = [];
  for (const match of fileContent.matchAll(IMPORT_SPEC_REGEX)) {
    specs.push(match[1]);
  }
  return specs;
}

function main() {
  const sourceFiles = walk(path.join(repoRoot, "src"));
  const violations = [];
  for (const repoPath of sourceFiles) {
    if (!fileMatchesSource(repoPath)) {
      continue;
    }
    const absolute = path.join(repoRoot, repoPath);
    const content = readFileSync(absolute, "utf8");
    for (const specifier of collectStaticSpecifiers(content)) {
      const resolved = resolveSpecifierToRepoPath(repoPath, specifier);
      if (resolved && targetIsForbidden(resolved)) {
        violations.push({ from: repoPath, to: resolved, specifier });
      }
    }
  }

  console.log(`Cron parent/child boundary check: ${violations.length} violation(s).`);
  if (violations.length === 0) {
    return 0;
  }
  console.error("\nForbidden imports from cron scheduler into child-runtime / channel surface:");
  for (const violation of violations) {
    console.error(`  ${violation.from} -> ${violation.to}  (specifier: ${violation.specifier})`);
  }
  console.error(
    "\nMove the call across the parent/child boundary or extract a generic seam under src/cron/.",
  );
  return 1;
}

process.exitCode = main();
