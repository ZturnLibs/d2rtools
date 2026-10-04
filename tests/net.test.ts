import { describe, it, expect, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fetchTextMirror, downloadToFile } from "../src/services/net.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function fakeFetch(routes: Map<string, () => Response | Promise<Response>>) {
  const calls: string[] = [];
  const impl = (async (url: string | URL) => {
    const key = String(url);
    calls.push(key);
    const route = routes.get(key);
    if (!route) throw new Error("Network request failed: Unable to connect");
    return await route();
  }) as typeof fetch;
  return { impl, calls };
}

describe("fetchTextMirror (镜像候选链)", () => {
  it("returns the first healthy mirror and reports via", async () => {
    const { impl } = fakeFetch(
      new Map([["https://a/x.json", () => new Response(`{"ok":1}`, { status: 200 })]]),
    );
    globalThis.fetch = impl;
    const res = await fetchTextMirror(["https://a/x.json", "https://b/x.json"]);
    expect(res.text).toBe(`{"ok":1}`);
    expect(res.via).toBe("https://a/x.json");
  });

  it("skips HTTP errors and dead hosts, answers from the next candidate", async () => {
    const { impl, calls } = fakeFetch(
      new Map([["https://b/x.json", () => new Response("good", { status: 200 })]]),
    );
    globalThis.fetch = impl;
    const res = await fetchTextMirror(["https://dead/x.json", "https://b/x.json"]);
    expect(res.via).toBe("https://b/x.json");
    expect(calls).toEqual(["https://dead/x.json", "https://b/x.json"]);
  });

  it("treats non-200 as failure and tries the rest", async () => {
    const { impl } = fakeFetch(
      new Map([
        ["https://a/x.json", () => new Response("rate limited", { status: 429 })],
        ["https://b/x.json", () => new Response("ok", { status: 200 })],
      ]),
    );
    globalThis.fetch = impl;
    const res = await fetchTextMirror(["https://a/x.json", "https://b/x.json"]);
    expect(res.via).toBe("https://b/x.json");
  });

  it("throws with a per-candidate breakdown when everything fails", async () => {
    globalThis.fetch = (async () => {
      throw new Error("closed before established");
    }) as typeof fetch;
    await expect(fetchTextMirror(["https://a/x.json", "https://b/x.json"])).rejects.toThrow(
      /均不可达[\s\S]*https:\/\/a\/x\.json[\s\S]*closed before established/,
    );
  });
});

describe("downloadToFile (流式落盘)", () => {
  function streamResponse(chunks: Uint8Array[], totalBytes: number | null): Response {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    });
    const headers = new Headers({ "content-type": "application/octet-stream" });
    if (totalBytes !== null) headers.set("content-length", String(totalBytes));
    return new Response(stream, { status: 200, headers });
  }

  async function tmpPath(name: string): Promise<string> {
    return path.join(await fsp.mkdtemp(path.join(os.tmpdir(), "d2rbox-net-")), name);
  }

  it("writes the whole body and reports bytes", async () => {
    const body = new Uint8Array(66000);
    body.fill(0x5a);
    const { impl } = fakeFetch(
      new Map([["https://a/f.bin", () => streamResponse([body, body.subarray(0, 100)], null)]]),
    );
    globalThis.fetch = impl;
    const dst = await tmpPath("f.bin");
    const res = await downloadToFile("https://a/f.bin", dst);
    expect(res.bytes).toBe(66100);
    expect((await fsp.stat(dst)).size).toBe(66100);
  });

  it("aborts past maxBytes (zip 炸弹/误下护栏)", async () => {
    const body = new Uint8Array(1000);
    body.fill(1);
    const { impl } = fakeFetch(
      new Map([
        [
          "https://a/big.bin",
          () =>
            streamResponse(
              [body, body, body, body, body],
              null,
            ),
        ],
      ]),
    );
    globalThis.fetch = impl;
    const dst = await tmpPath("big.bin");
    await expect(downloadToFile("https://a/big.bin", dst, { maxBytes: 2500 })).rejects.toThrow(
      /大小上限/,
    );
    expect((await fsp.stat(dst)).size).toBeLessThanOrEqual(4000); // partial file, bounded
  });

  it("throws on HTTP error status without writing", async () => {
    const { impl } = fakeFetch(new Map([["https://a/f.bin", () => new Response("no", { status: 404 })]]));
    globalThis.fetch = impl;
    const dst = await tmpPath("f.bin");
    await expect(downloadToFile("https://a/f.bin", dst)).rejects.toThrow(/404/);
    await expect(fsp.stat(dst)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports progress with total from content-length", async () => {
    const part = new Uint8Array(500);
    const seen: { done: number; total: number | null }[] = [];
    const { impl } = fakeFetch(
      new Map([
        ["https://a/f.bin", () => streamResponse([part, part], 1000)],
      ]),
    );
    globalThis.fetch = impl;
    const dst = await tmpPath("f.bin");
    await downloadToFile("https://a/f.bin", dst, {
      onProgress: (p) => seen.push({ ...p }),
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toEqual({ done: 1000, total: 1000 });
  });
});
