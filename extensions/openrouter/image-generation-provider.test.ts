// Openrouter tests cover image generation provider plugin behavior.
import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenRouterImageGenerationProvider } from "./image-generation-provider.js";

const { postJsonRequestMock, resolveApiKeyForProviderMock, resolveProviderHttpRequestConfigMock } =
  getProviderHttpMocks();

installProviderHttpMockCleanup();

function requirePostJsonRequest(): {
  url: string;
  timeoutMs?: number;
  body: Record<string, unknown>;
  headers: Headers;
  allowPrivateNetwork?: boolean;
  dispatcherPolicy?: unknown;
} {
  const request = postJsonRequestMock.mock.calls[0]?.[0];
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("expected OpenRouter image generation request");
  }
  return request as {
    url: string;
    timeoutMs?: number;
    body: Record<string, unknown>;
    headers: Headers;
    allowPrivateNetwork?: boolean;
    dispatcherPolicy?: unknown;
  };
}

function requireConfigRequest() {
  const request = resolveProviderHttpRequestConfigMock.mock.calls[0]?.[0];
  if (!request) {
    throw new Error("expected OpenRouter image request config");
  }
  return request;
}

describe("openrouter image generation provider", () => {
  beforeEach(() => {
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: "openrouter-key" });
  });

  it("declares dedicated image generation and edit capabilities", () => {
    const provider = buildOpenRouterImageGenerationProvider();

    expect(provider.id).toBe("openrouter");
    expect(provider.label).toBe("OpenRouter");
    expect(provider.defaultModel).toBe("google/gemini-3.1-flash-image-preview");
    expect(provider.models).toEqual([
      "google/gemini-3.1-flash-image-preview",
      "google/gemini-3-pro-image-preview",
      "openai/gpt-5.4-image-2",
    ]);
    expect(provider.defaultTimeoutMs).toBe(180_000);
    expect(provider.capabilities.generate.maxCount).toBe(4);
    expect(provider.capabilities.edit).toMatchObject({
      enabled: true,
      maxCount: 4,
      maxInputImages: 5,
    });
  });

  it("sends Gemini generation requests to the dedicated endpoint", async () => {
    const release = vi.fn(async () => {});
    postJsonRequestMock.mockResolvedValue({
      response: Response.json({
        data: [{ b64_json: Buffer.from("png-one").toString("base64") }],
      }),
      release,
    });

    const result = await buildOpenRouterImageGenerationProvider().generateImage({
      provider: "openrouter",
      model: "google/gemini-3.1-flash-image-preview",
      prompt: "draw a sticker",
      aspectRatio: "16:9",
      resolution: "2K",
      count: 1,
      timeoutMs: 12_345,
      ssrfPolicy: { allowRfc2544BenchmarkRange: true },
      cfg: {
        models: {
          providers: {
            openrouter: {
              baseUrl: "https://custom.openrouter.test/api/v1",
              models: [],
            },
          },
        },
      },
    });

    expect(requireConfigRequest()).toEqual({
      baseUrl: "https://custom.openrouter.test/api/v1",
      defaultBaseUrl: "https://openrouter.ai/api/v1",
      allowPrivateNetwork: false,
      request: undefined,
      defaultHeaders: {
        Authorization: "Bearer openrouter-key",
        "HTTP-Referer": "https://openclaw.ai",
        "X-OpenRouter-Title": "OpenClaw",
      },
      provider: "openrouter",
      capability: "image",
      transport: "http",
    });
    const request = requirePostJsonRequest();
    expect(request.url).toBe("https://custom.openrouter.test/api/v1/images");
    expect(Object.fromEntries(request.headers.entries())).toEqual({
      authorization: "Bearer openrouter-key",
      "content-type": "application/json",
      "http-referer": "https://openclaw.ai",
      "x-openrouter-title": "OpenClaw",
    });
    expect(request.body).toEqual({
      model: "google/gemini-3.1-flash-image-preview",
      prompt: "draw a sticker",
      n: 1,
      aspect_ratio: "16:9",
      resolution: "2K",
    });
    expect(request).toMatchObject({
      timeoutMs: 180_000,
      allowPrivateNetwork: false,
      ssrfPolicy: { allowRfc2544BenchmarkRange: true },
      dispatcherPolicy: undefined,
    });
    expect(result.images[0]?.buffer.toString()).toBe("png-one");
    expect(result.model).toBe("google/gemini-3.1-flash-image-preview");
    expect(release).toHaveBeenCalledOnce();
  });

  it("preserves configured request transport without weakening private-network policy", async () => {
    const requestPolicy = {
      allowPrivateNetwork: true,
      headers: { "X-OpenRouter-Trace": "image-trace" },
      auth: { mode: "authorization-bearer" as const, token: "override-image-token" },
      proxy: { mode: "explicit-proxy" as const, url: "http://proxy.example.test:8443" },
      tls: { ca: "synthetic-provider-ca", serverName: "provider.example.test" },
    };
    const dispatcherPolicy = {
      mode: "explicit-proxy" as const,
      proxyUrl: requestPolicy.proxy.url,
    };
    resolveProviderHttpRequestConfigMock.mockImplementationOnce((params) => {
      const headers = new Headers(params.defaultHeaders);
      for (const [name, value] of Object.entries(params.request?.headers ?? {})) {
        headers.set(name, value);
      }
      if (params.request?.auth?.mode === "authorization-bearer") {
        headers.set("Authorization", `Bearer ${params.request.auth.token}`);
      }
      return {
        baseUrl: params.baseUrl ?? params.defaultBaseUrl,
        allowPrivateNetwork: params.allowPrivateNetwork === true,
        headers,
        dispatcherPolicy,
      };
    });
    postJsonRequestMock.mockResolvedValue({
      response: Response.json({
        data: [{ b64_json: Buffer.from("png").toString("base64") }],
      }),
      release: vi.fn(async () => {}),
    });

    const result = await buildOpenRouterImageGenerationProvider().generateImage({
      provider: "openrouter",
      model: "google/gemini-3.1-flash-image-preview",
      prompt: "draw through configured transport",
      cfg: {
        models: {
          providers: {
            openrouter: {
              baseUrl: "https://custom.openrouter.test/api/v1",
              request: requestPolicy,
              models: [],
            },
          },
        },
      },
    });

    expect(requireConfigRequest()).toMatchObject({
      baseUrl: "https://custom.openrouter.test/api/v1",
      allowPrivateNetwork: false,
      request: requestPolicy,
    });
    const request = requirePostJsonRequest();
    expect(request.headers.get("authorization")).toBe("Bearer override-image-token");
    expect(request.headers.get("http-referer")).toBe("https://openclaw.ai");
    expect(request.headers.get("x-openrouter-title")).toBe("OpenClaw");
    expect(request.headers.get("x-openrouter-trace")).toBe("image-trace");
    expect(request).toMatchObject({
      url: "https://custom.openrouter.test/api/v1/images",
      allowPrivateNetwork: false,
      dispatcherPolicy,
    });
    expect(result.images[0]?.buffer.toString()).toBe("png");
  });

  it("uses the default endpoint and operation timeout", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: Response.json({
        data: [{ b64_json: Buffer.from("png-one").toString("base64") }],
      }),
      release: vi.fn(async () => {}),
    });

    await buildOpenRouterImageGenerationProvider().generateImage({
      provider: "openrouter",
      model: "google/gemini-3.1-flash-image-preview",
      prompt: "draw a sticker",
      cfg: {},
    });

    expect(requirePostJsonRequest()).toMatchObject({
      url: "https://openrouter.ai/api/v1/images",
      timeoutMs: 180_000,
    });
  });

  it("passes reference images as input_references and reads media_type", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: Response.json({
        data: [
          {
            b64_json: Buffer.from("webp-one").toString("base64"),
            media_type: "image/webp",
          },
        ],
      }),
      release: vi.fn(async () => {}),
    });

    const result = await buildOpenRouterImageGenerationProvider().generateImage({
      provider: "openrouter",
      model: "google/gemini-3.1-flash-image-preview",
      prompt: "turn this into watercolor",
      inputImages: [{ buffer: Buffer.from("source-image"), mimeType: "image/png" }],
      cfg: {},
    });

    expect(requirePostJsonRequest().body.input_references).toEqual([
      {
        type: "image_url",
        image_url: {
          url: `data:image/png;base64,${Buffer.from("source-image").toString("base64")}`,
        },
      },
    ]);
    expect(result.images[0]?.buffer.toString()).toBe("webp-one");
    expect(result.images[0]?.mimeType).toBe("image/webp");
  });

  it("sniffs the MIME type when media_type is absent", async () => {
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    postJsonRequestMock.mockResolvedValue({
      response: Response.json({
        data: [{ b64_json: jpegBytes.toString("base64") }],
      }),
      release: vi.fn(async () => {}),
    });

    const result = await buildOpenRouterImageGenerationProvider().generateImage({
      provider: "openrouter",
      model: "google/gemini-3.1-flash-image-preview",
      prompt: "photo",
      cfg: {},
    });

    expect(result.images[0]?.mimeType).toBe("image/jpeg");
  });

  it("omits Gemini-only geometry fields for other models", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: Response.json({
        data: [{ b64_json: Buffer.from("img").toString("base64") }],
      }),
      release: vi.fn(async () => {}),
    });

    await buildOpenRouterImageGenerationProvider().generateImage({
      provider: "openrouter",
      model: "openai/gpt-5.4-image-2",
      prompt: "draw something",
      aspectRatio: "16:9",
      resolution: "2K",
      cfg: {},
    });

    expect(requirePostJsonRequest().body).toEqual({
      model: "openai/gpt-5.4-image-2",
      prompt: "draw something",
      n: 1,
    });
  });
});
