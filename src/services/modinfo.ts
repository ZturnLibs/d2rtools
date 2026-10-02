/**
 * modinfo.json reading with the leniency real packs demand:
 *  - EJ hides it at <mod>\EJ.mpq\modinfo.json (mpq-as-folder) with a UTF-8 BOM;
 *  - VIPer_cs's file has a trailing comma (invalid strict JSON).
 * The canonical mod name is always the folder name; parsed fields are
 * display metadata only.
 */
import { joinPath, dirname } from "./paths.js";

export interface ModInfoResult {
  name: string; // display name from modinfo, fallback = dirName
  savepath: string;
  warning: string | null;
}

/** Strip UTF-8 BOM if present (U+FEFF as decoded by TextDecoder). */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Lenient JSON: plain parse -> BOM strip -> trailing-comma strip -> retry. */
export function lenientParse(text: string): Record<string, unknown> | null {
  const attempts = [text, stripBom(text)];
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate) as Record<string, unknown>;
    } catch {
      /* try next */
    }
  }
  const stripped = stripBom(text).replace(/,\s*([}\]])/g, "$1");
  try {
    return JSON.parse(stripped) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readJsonFile(path: string): Promise<Record<string, unknown> | null> {
  try {
    const bytes = await tjs.readFile(path);
    return lenientParse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/**
 * Detection order for mod dir `dir` (folder name `dirName`):
 *   1. <dir>\modinfo.json            (standard layout, VIPer_cs)
 *   2. <dir>\<dirName>.mpq\modinfo.json  (mpq-as-folder, EJ)
 *   3. <dirName>.mpq exists as a plain file -> no info file; folder-name fallback
 * Returns null when none apply (not a mod dir).
 */
export async function readModInfo(dir: string, dirName: string): Promise<ModInfoResult | null> {
  let parsed = await readJsonFile(joinPath(dir, "modinfo.json"));
  if (!parsed) {
    const mpqPath = joinPath(dir, `${dirName}.mpq`);
    try {
      const st = await tjs.stat(mpqPath);
      if (st.isDirectory) {
        parsed = await readJsonFile(joinPath(mpqPath, "modinfo.json"));
      }
    } catch {
      /* no .mpq child at all — fall through */
    }
  }

  if (!parsed) {
    // modinfo-less dir: only treat as a mod if a same-named .mpq exists.
    const mpqPath = joinPath(dir, `${dirName}.mpq`);
    try {
      await tjs.stat(mpqPath);
    } catch {
      return null;
    }
    return { name: dirName, savepath: dirName, warning: null };
  }

  const name = typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : dirName;
  const savepath =
    typeof parsed.savepath === "string" && parsed.savepath.trim() ? parsed.savepath.trim() : dirName;
  return { name, savepath, warning: null };
}

/**
 * Author-facing text files worth showing on the card (说明/readme), picked
 * from the mod dir itself or its parent variant dir (where 术士君临 puts them).
 */
export async function findReadme(modDirPath: string): Promise<string | null> {
  const candidates = [
    joinPath(modDirPath, "说明.txt"),
    joinPath(modDirPath, "readme.txt"),
    joinPath(modDirPath, "README.txt"),
    joinPath(dirname(modDirPath), "说明.txt"),
    joinPath(dirname(modDirPath), "readme.txt"),
  ];
  for (const p of candidates) {
    try {
      const st = await tjs.stat(p);
      if (st.isFile) return p;
    } catch {
      /* next */
    }
  }
  return null;
}
