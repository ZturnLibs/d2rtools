/**
 * fflate <-> tjs fs bridge. The only module in the app allowed to import
 * fflate. Two primitives: zipDir (tree walk + zipSync + atomic rename) and
 * unzipToDir (unzipSync + zip-slip-guarded writes). The walk mirrors
 * saves.ts walkFiles semantics so a zip backup captures exactly what a
 * folder backup would.
 */
import { zipSync, unzipSync } from "fflate";
import { joinPath, dirname } from "./paths.js";

const MAX_FILE_BYTES = 256 * 1024 * 1024;

interface WalkedFile {
  path: string;
  rel: string;
  size: number;
}

/**
 * Walk dir recursively. `rel` is the path relative to `dir` ("\\"-separated).
 * `excludeTop` skips top-level dir names (depth 0 only, case-insensitive) —
 * the root save slot excludes `mods\` this way, same as saves.ts.
 */
async function walkFiles(
  dir: string,
  prefix = "",
  excludeTop: string[] = [],
): Promise<WalkedFile[]> {
  const out: WalkedFile[] = [];
  const lowerEx = excludeTop.map((n) => n.toLowerCase());
  const atTop = prefix === "";
  const d = await tjs.readDir(dir);
  for await (const e of d) {
    if (atTop && e.isDirectory && lowerEx.includes(e.name.toLowerCase())) continue;
    const p = joinPath(dir, e.name);
    if (e.isDirectory) {
      out.push(...(await walkFiles(p, `${prefix}${e.name}\\`, excludeTop)));
    } else if (e.isFile) {
      let size = 0;
      try {
        size = (await tjs.stat(p)).size;
      } catch {
        /* raced delete */
      }
      out.push({ path: p, rel: `${prefix}${e.name}`, size });
    }
  }
  return out;
}

/**
 * Zip `srcDir` into `dstZip` (tmp + rename). One entry per file, keyed by
 * its "\\"-separated relative path. Throws on any single file over 256MB
 * (zip keeps whole files in memory — point those at folder-format backups).
 */
export async function zipDir(
  srcDir: string,
  dstZip: string,
  opts?: { excludeTop?: string[] },
): Promise<{ files: number; bytes: number }> {
  const files = await walkFiles(srcDir, "", opts?.excludeTop ?? []);
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES) {
      throw new Error(
        `文件过大，无法压缩备份（${f.rel}，${Math.round(f.size / 1024 / 1024)}MB）：` +
          "zip 格式需要将整个文件读入内存，请改用文件夹格式备份",
      );
    }
  }
  const data: Record<string, Uint8Array> = {};
  let bytes = 0;
  for (const f of files) {
    const content = await tjs.readFile(f.path);
    data[f.rel] = content;
    bytes += content.length;
  }
  const zipped = zipSync(data);
  const tmp = `${dstZip}.tmp`;
  try {
    const parent = dirname(dstZip);
    if (parent) await tjs.makeDir(parent, { recursive: true });
    await tjs.writeFile(tmp, zipped);
    await tjs.rename(tmp, dstZip);
  } catch (err) {
    await tjs.remove(tmp).catch(() => undefined);
    throw err;
  }
  return { files: files.length, bytes };
}

/** Zip-slip guard: no drive letters, no absolute paths, no ".." segments. */
function isSafeEntry(name: string): boolean {
  if (/^[a-zA-Z]:/.test(name)) return false;
  if (name.startsWith("/") || name.startsWith("\\")) return false;
  return name.split(/[\\/]/).every((seg) => seg !== ".." && seg.length > 0);
}

/**
 * Extract `srcZip` into `dstDir`, creating parent dirs as needed. Every
 * entry name is validated BEFORE anything is written, so a malicious entry
 * aborts the whole extraction with nothing on disk.
 */
export async function unzipToDir(srcZip: string, dstDir: string): Promise<{ files: number }> {
  const entries = unzipSync(await tjs.readFile(srcZip));
  for (const name of Object.keys(entries)) {
    if (!isSafeEntry(name)) {
      throw new Error(`压缩包包含不安全路径，已中止解压：${name}`);
    }
  }
  let files = 0;
  for (const [name, content] of Object.entries(entries)) {
    const dst = joinPath(dstDir, name);
    const parent = dirname(dst);
    if (parent) await tjs.makeDir(parent, { recursive: true });
    await tjs.writeFile(dst, content);
    files++;
  }
  return { files };
}
