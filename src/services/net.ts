/**
 * Network primitives over the tjs fetch (libcurl) backend. Measured on the
 * reference machine (2026-10): jsdelivr / gitee / npmmirror are reachable but
 * flaky; github.com / api.github.com time out outright. So every fetch gets
 * a hard timeout, and anything GitHub-hosted goes through a mirror candidate
 * chain with the caller supplying the fallbacks.
 */
import { dirname } from "./paths.js";

export const USER_AGENT = "d2rbox/0.3";

export class TimeoutError extends Error {
  constructor(url: string, ms: number) {
    super(`请求超时（${Math.round(ms / 1000)}s）：${url}`);
    this.name = "TimeoutError";
  }
}

export interface FetchOpts {
  timeoutMs?: number;
  headers?: Record<string, string>;
}

/** fetch + hard timeout. The abort also cancels the in-flight connect. */
export async function fetchWithTimeout(url: string, opts: FetchOpts = {}): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: ac.signal,
      headers: { "User-Agent": USER_AGENT, ...opts.headers },
    });
  } catch (err) {
    if (ac.signal.aborted) throw new TimeoutError(url, timeoutMs);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Try each candidate URL in order; first non-200 wins the payload.
 * Returns which candidate answered. Mirrors are expected to fail here
 * (GFW / quota) — a per-candidate timeout keeps the whole chain bounded.
 */
export async function fetchTextMirror(
  candidates: string[],
  opts: FetchOpts = {},
): Promise<{ text: string; via: string }> {
  const errors: string[] = [];
  for (const url of candidates) {
    try {
      const res = await fetchWithTimeout(url, opts);
      if (!res.ok) {
        errors.push(`${url} → HTTP ${res.status}`);
        continue;
      }
      return { text: await res.text(), via: url };
    } catch (err) {
      errors.push(`${url} → ${String(err).slice(0, 120)}`);
    }
  }
  throw new Error(`所有下载源均不可达：\n${errors.join("\n")}`);
}

export interface DownloadProgress {
  done: number;
  total: number | null; // null when the server sent no content-length
}

export interface DownloadOpts {
  timeoutMs?: number;
  maxBytes?: number; // hard cap; abort mid-stream when exceeded
  onProgress?: (p: DownloadProgress) => void;
}

/** Write a streamed download to `dst` chunk by chunk (no whole-body buffering). */
export async function downloadToFile(
  url: string,
  dst: string,
  opts: DownloadOpts = {},
): Promise<{ bytes: number }> {
  const res = await fetchWithTimeout(url, { timeoutMs: opts.timeoutMs ?? 30_000 });
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status} ${url}`);
  const totalHeader = res.headers.get("content-length");
  const total = totalHeader ? Number(totalHeader) : null;
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024 * 1024;

  const reader = res.body!.getReader();
  const writer = await tjs.open(dst, "w");
  let done = 0;
  let lastReport = 0;
  try {
    for (;;) {
      const { done: streamDone, value } = await reader.read();
      if (streamDone) break;
      if (value && value.length > 0) {
        done += value.length;
        if (done > maxBytes) {
          void reader.cancel();
          throw new Error(`下载超过大小上限（${Math.round(maxBytes / 1024 / 1024)}MB），已中止`);
        }
        await writer.write(value);
        const now = Date.now();
        if (opts.onProgress && (now - lastReport >= 150 || done === total)) {
          lastReport = now;
          opts.onProgress({ done, total });
        }
      }
    }
  } finally {
    await writer.close();
  }
  return { bytes: done };
}

/** Parent dir of a path ("" when none) — re-exported for stage dirs. */
export function parentDir(p: string): string {
  return dirname(p);
}
