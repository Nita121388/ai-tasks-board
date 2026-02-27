import type AiTasksBoardPlugin from "./main";

export type RuntimeHttpMeta = {
  request_id: string;
  url: string;
  method: string;
  latency_ms: number;
  http_status: number | null;
  ok: boolean;
  response_text_len: number;
  response_snip: string;
};

export class RuntimeHttpError extends Error {
  meta: RuntimeHttpMeta;
  constructor(message: string, meta: RuntimeHttpMeta) {
    super(message);
    this.name = "RuntimeHttpError";
    this.meta = meta;
  }
}

function snip(text: string, maxLen: number): string {
  const t = (text || "").trim();
  if (t.length <= maxLen) return t;
  return t.slice(0, maxLen) + "...[truncated]";
}

export function randomRequestId(): string {
  const c = (globalThis as unknown as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Fallback (good enough for correlation ids; no deps).
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = Math.floor(Math.random() * 16);
    const v = ch === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/g, "") + path;
}

export async function runtimeRequestJson<T>(
  plugin: AiTasksBoardPlugin,
  opts: {
    path: string;
    method?: "GET" | "POST";
    body?: unknown;
    timeout_ms?: number;
    request_id?: string;
  }
): Promise<{ json: T; text: string; meta: RuntimeHttpMeta }> {
  const url = joinUrl(plugin.settings.runtimeUrl, opts.path);
  const method = opts.method ?? (opts.body === undefined ? "GET" : "POST");
  const requestId = (opts.request_id || "").trim() || randomRequestId();
  const started = Date.now();

  const controller = new AbortController();
  const timeoutMs = Math.max(1, opts.timeout_ms ?? 180_000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = { "X-Request-ID": requestId };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";

    const resp = await fetch(url, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: controller.signal,
    });

    const text = await resp.text().catch(() => "");
    const meta: RuntimeHttpMeta = {
      request_id: requestId,
      url,
      method,
      latency_ms: Math.max(0, Date.now() - started),
      http_status: resp.status,
      ok: false,
      response_text_len: text.length,
      response_snip: snip(text, 800),
    };

    if (!resp.ok) {
      throw new RuntimeHttpError(`Runtime error (${resp.status}): ${snip(text, 400)}`, meta);
    }

    try {
      const json = JSON.parse(text) as T;
      meta.ok = true;
      return { json, text, meta };
    } catch {
      throw new RuntimeHttpError("Runtime returned invalid JSON.", meta);
    }
  } catch (e) {
    if (e instanceof RuntimeHttpError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    const meta: RuntimeHttpMeta = {
      request_id: requestId,
      url,
      method,
      latency_ms: Math.max(0, Date.now() - started),
      http_status: null,
      ok: false,
      response_text_len: 0,
      response_snip: "",
    };
    throw new RuntimeHttpError(msg, meta);
  } finally {
    clearTimeout(timer);
  }
}

