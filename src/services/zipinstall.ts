/**
 * Zip-based mod install (M9): stream-extract an author zip into a stage
 * dir, safety-check it, then hand the discovered mod dirs to the regular
 * install pipeline. Serving the download -> install as two steps (stage,
 * then commit) lets the UI pick a variant when a pack zip contains several,
 * and lets a manually-imported local zip reuse the exact same path.
 *
 * Streaming matters: pack zips run 500MB-2GB, and fflate's unzipSync would
 * hold every decompressed entry in memory. The streaming Unzip keeps the
 * peak at the largest single entry (a ~800MB MPQ, bounded by maxEntryBytes).
 *
 * Concurrency note: fflate's ondata callback is synchronous, but disk writes
 * are async — each entry keeps a serialized write promise chain; fflate emits
 * entries strictly in archive order, and all chains are awaited after the
 * final push. A failure anywhere sets `fail`, which stops the source loop
 * and turns into a throw after cleanup.
 */
import { Unzip, UnzipInflate } from "fflate";
import { joinPath, dirname } from "./paths.js";
import { scanSource } from "./scan.js";
import { fetchWithTimeout } from "./net.js";
import type { KnownMod } from "./config.js";

/** Extensions we refuse to extract, ever (R3: 恶意 zip 防线). D2R mods are
 *  data-only (mpq folders of txt/json/dc6); code has no business in there. */
const REJECTED_EXTS = [
  ".exe", ".dll", ".bat", ".cmd", ".com", ".scr", ".pif", ".msi", ".msp", ".mst",
  ".ps1", ".psm1", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".wsh", ".hta",
  ".jar", ".lnk", ".reg", ".cpl", ".ocx", ".sys", ".drv",
];

export function rejectedFileReason(name: string): string | null {
  const dot = name.toLowerCase().lastIndexOf(".");
  if (dot === -1) return null;
  const ext = name.toLowerCase().slice(dot);
  return REJECTED_EXTS.includes(ext) ? ext : null;
}

/** Zip-slip guard, same rules as zip.ts (no drive letters / absolute / "..").
 *  Directory entries legitimately end with "/" — validated without it. */
function isSafeEntry(rawName: string): boolean {
  const name = rawName.endsWith("/") || rawName.endsWith("\\") ? rawName.slice(0, -1) : rawName;
  if (name === "") return true; // bare root dir entry
  if (/^[a-zA-Z]:/.test(name)) return false;
  if (name.startsWith("/") || name.startsWith("\\")) return false;
  return name.split(/[\\/]/).every((seg) => seg !== ".." && seg.length > 0);
}

export interface StageCandidate {
  name: string;
  displayName: string | null;
  savepath: string;
  variant: string;
  sourcePath: string;
}

export interface StageOutcome {
  stageId: string;
  dir: string;
  candidates: StageCandidate[];
  files: number;
  bytes: number;
}

export interface IngestOpts {
  maxEntryBytes?: number; // per decompressed file (default 1GiB — one big MPQ)
  maxBytesTotal?: number; // total decompressed (default 4GiB)
}

interface EntryState {
  dst: string;
  isDir: boolean;
  writer: TjsFile | null;
  chain: Promise<void>;
  written: number;
  counted: boolean;
}

/** Serialize one more step onto an entry's write chain; first error wins. */
function link(st: EntryState, fail: { err: Error | null }, step: () => Promise<void>): void {
  st.chain = st.chain.then(step).catch((err: unknown) => {
    if (!fail.err) fail.err = err instanceof Error ? err : new Error(String(err));
  });
}

/**
 * Extract a zip supplied as a chunk stream into `dir`. Every entry is
 * validated (zip-slip + rejected ext) at discovery, before any write.
 * Throws — with the work dir cleaned — on the first policy violation,
 * decode error, or size-cap breach.
 */
export async function ingestZipChunks(
  chunks: AsyncIterable<Uint8Array>,
  dir: string,
  opts: IngestOpts = {},
): Promise<{ files: number; bytes: number }> {
  const maxEntryBytes = opts.maxEntryBytes ?? 1024 * 1024 * 1024;
  const maxBytesTotal = opts.maxBytesTotal ?? 4 * 1024 * 1024 * 1024;
  const fail: { err: Error | null } = { err: null };
  const entries: EntryState[] = [];
  let filesTotal = 0;
  let bytesTotal = 0;
  let pushed = 0;
  let head: number[] = [];
  let magicChecked = false;

  await tjs.makeDir(dir, { recursive: true });
  try {
    const unzipper = new Unzip((file) => {
      if (fail.err) return;
      try {
        if (!isSafeEntry(file.name)) {
          throw new Error(`压缩包包含不安全路径，已中止解压：${file.name}`);
        }
        const bad = rejectedFileReason(file.name);
        if (bad) {
          throw new Error(`压缩包包含被禁止的文件类型（${bad}），已中止解压：${file.name}`);
        }
      } catch (err) {
        fail.err = err as Error;
        return;
      }
      const st: EntryState = {
        dst: joinPath(dir, file.name),
        isDir: file.name.endsWith("/") || file.name.endsWith("\\"),
        writer: null,
        chain: Promise.resolve(),
        written: 0,
        counted: false,
      };
      entries.push(st);
      file.ondata = (err, data, final) => {
        if (fail.err) return;
        if (err) {
          fail.err = new Error(`解压失败：${err.message}`);
          return;
        }
        if (st.isDir) return;
        if (data && data.length > 0) {
          st.written += data.length;
          bytesTotal += data.length;
          if (st.written > maxEntryBytes) {
            fail.err = new Error(
              `${file.name} 解压后超过单文件上限（${Math.round(maxEntryBytes / 1024 / 1024)}MB），已中止`,
            );
            return;
          }
          if (bytesTotal > maxBytesTotal) {
            fail.err = new Error(
              `压缩包解压后总大小超过上限（${Math.round(maxBytesTotal / 1024 / 1024 / 1024)}GB），已中止`,
            );
            return;
          }
          link(st, fail, async () => {
            if (!st.writer) {
              const parent = dirname(st.dst);
              if (parent) await tjs.makeDir(parent, { recursive: true });
              st.writer = await tjs.open(st.dst, "w");
            }
            await st.writer.write(data);
          });
        }
        if (final) {
          link(st, fail, async () => {
            if (st.writer) {
              await st.writer.close();
              st.writer = null;
            }
            if (!st.counted) {
              st.counted = true;
              filesTotal++;
            }
          });
        }
      };
      try {
        file.start(); // throws for unregistered compression methods
      } catch (err) {
        fail.err = new Error(
          `压缩包内的 ${file.name} 使用了不支持的压缩格式：${String(err).slice(0, 80)}`,
        );
      }
    });
    unzipper.register(UnzipInflate);

    for await (const chunk of chunks) {
      if (fail.err) break;
      if (!magicChecked) {
        for (const b of chunk) {
          head.push(b);
          if (head.length >= 2) break;
        }
        if (head.length >= 2) {
          magicChecked = true;
          if (String.fromCharCode(head[0]!, head[1]!) !== "PK") {
            throw new Error("不是有效的 zip 压缩包（文件头校验失败）");
          }
        }
      }
      pushed += chunk.length;
      unzipper.push(chunk, false);
    }
    if (!fail.err) unzipper.push(new Uint8Array(0), true);
    // All entry callbacks have fired by now — await every write chain.
    await Promise.all(entries.map((e) => e.chain));
  } catch (err) {
    if (!fail.err) fail.err = err as Error;
  }

  if (fail.err) {
    await tjs.remove(dir, { recursive: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
    throw fail.err;
  }
  return { files: filesTotal, bytes: bytesTotal };
}

/**
 * Safety-check + classify what landed in a stage dir. Returns the mod roots
 * scanSource found; the caller turns 0 candidates into a friendly error.
 */
export async function scanStageDir(
  dir: string,
): Promise<{ candidates: StageCandidate[]; warnings: string[] }> {
  const outcome = await scanSource(dir, "stage");
  const candidates: StageCandidate[] = outcome.mods.map((m: KnownMod) => ({
    name: m.name,
    displayName: m.displayName,
    savepath: m.savepath,
    variant: m.variant,
    sourcePath: m.sourcePath,
  }));
  return { candidates, warnings: outcome.warnings };
}

// ---------------------------------------------------------------------------
// Stage registry — in-memory; stage dirs live under %TEMP%\d2rbox-stages and
// are swept whole once per backend session (nothing can be mid-install when
// the backend boots).
// ---------------------------------------------------------------------------

const stages = new Map<string, { dir: string; createdAt: number }>();
let swept = false;

export function stageRoot(): string {
  return joinPath(tjs.tmpDir, "d2rbox-stages");
}

async function ensureSwept(): Promise<void> {
  if (swept) return;
  swept = true;
  await tjs.remove(stageRoot(), { recursive: true, maxRetries: 3, retryDelay: 100 }).catch(
    () => undefined,
  );
}

export async function newStage(): Promise<{ stageId: string; dir: string }> {
  await ensureSwept();
  const stageId = `stage_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const dir = joinPath(stageRoot(), stageId);
  stages.set(stageId, { dir, createdAt: Date.now() });
  return { stageId, dir };
}

export function getStage(stageId: string): { dir: string } | null {
  return stages.get(stageId) ?? null;
}

export async function dropStage(stageId: string): Promise<void> {
  const st = stages.get(stageId);
  stages.delete(stageId);
  if (st) {
    await tjs.remove(st.dir, { recursive: true, maxRetries: 3, retryDelay: 100 }).catch(
      () => undefined,
    );
  }
}

/** Stage a zip already on disk (manual-import path). */
export async function stageFromZipFile(
  zipPath: string,
  opts: IngestOpts = {},
): Promise<StageOutcome> {
  const st = await tjs.stat(zipPath).catch(() => null);
  if (!st?.isFile) throw new Error(`文件不存在：${zipPath}`);
  const { stageId, dir } = await newStage();
  async function* chunks(): AsyncIterable<Uint8Array> {
    const handle = await tjs.open(zipPath, "r");
    try {
      for (;;) {
        const buf = await handle.read(1024 * 1024);
        if (buf.length === 0) break;
        yield buf;
      }
    } finally {
      await handle.close();
    }
  }
  try {
    const { files, bytes } = await ingestZipChunks(chunks(), dir, opts);
    const { candidates, warnings } = await scanStageDir(dir);
    if (candidates.length === 0) {
      throw new Error(
        `压缩包中未找到可识别的 mod（需要 modinfo.json 或同名 .mpq）${
          warnings.length > 0 ? `：${warnings[0]}` : ""
        }`,
      );
    }
    return { stageId, dir, candidates, files, bytes };
  } catch (err) {
    await dropStage(stageId);
    throw err;
  }
}

/**
 * Stage a zip straight off a download stream (作者直链 path) — no whole-file
 * temp copy, download and decompress proceed chunk by chunk. Network errors
 * surface verbatim so the caller can offer "打开主页手动下载" (R1 降级).
 */
export async function stageFromUrl(
  url: string,
  opts: IngestOpts & {
    timeoutMs?: number;
    onDownloadProgress?: (p: { done: number; total: number | null }) => void;
  } = {},
): Promise<StageOutcome> {
  const { stageId, dir } = await newStage();
  try {
    const res = await fetchWithTimeout(url, { timeoutMs: opts.timeoutMs ?? 60_000 });
    if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}（${url}）`);
    const totalHeader = res.headers.get("content-length");
    const total = totalHeader ? Number(totalHeader) : null;
    async function* chunks(): AsyncIterable<Uint8Array> {
      const reader = res.body!.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length > 0) yield value;
      }
    }
    const outcome = await ingestWithDownloadProgress(chunks(), dir, opts, total);
    const { candidates, warnings } = await scanStageDir(dir);
    if (candidates.length === 0) {
      throw new Error(
        `下载的压缩包中未找到可识别的 mod（需要 modinfo.json 或同名 .mpq）${
          warnings.length > 0 ? `：${warnings[0]}` : ""
        }`,
      );
    }
    return { stageId, dir, candidates, files: outcome.files, bytes: outcome.bytes };
  } catch (err) {
    await dropStage(stageId);
    throw err;
  }
}

/** ingestZipChunks + download progress relay (compressed bytes vs total). */
async function ingestWithDownloadProgress(
  chunks: AsyncIterable<Uint8Array>,
  dir: string,
  opts: IngestOpts & {
    onDownloadProgress?: (p: { done: number; total: number | null }) => void;
  },
  total: number | null,
): Promise<{ files: number; bytes: number }> {
  let done = 0;
  let lastReport = 0;
  const wrapped = {
    async *[Symbol.asyncIterator]() {
      for await (const chunk of chunks) {
        done += chunk.length;
        const now = Date.now();
        if (opts.onDownloadProgress && (now - lastReport >= 150 || done === total)) {
          lastReport = now;
          opts.onDownloadProgress({ done, total });
        }
        yield chunk;
      }
      opts.onDownloadProgress?.({ done, total });
    },
  };
  return ingestZipChunks(wrapped, dir, opts);
}
