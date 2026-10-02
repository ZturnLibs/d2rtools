/**
 * Path derivation for game / mods / save locations. The backend runs on
 * Windows only, so joins use "\\" and tolerate mixed separators in user
 * input — Win32 accepts both. Chinese / en-dash path segments pass through
 * as plain JS strings (libuv handles the wide-char plumbing).
 */

export interface GameValidation {
  exists: boolean;
  hasD2R: boolean;
  hasModsDir: boolean;
}

/** Canonical mod-name check: must be a legal single Windows path segment. */
export function isValidModName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 64 &&
    name !== "." &&
    name !== ".." &&
    !/[\\/:*?"<>|]/.test(name)
  );
}

export function basename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return i === -1 ? trimmed : trimmed.slice(i + 1);
}

export function dirname(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (i === -1) return "";
  if (i === 0) return trimmed.slice(0, 1);
  return trimmed.slice(0, i);
}

export function joinPath(...parts: string[]): string {
  const joined = parts.filter((p) => p.length > 0).join("\\");
  // Normalize separators (keep leading \\ for UNC); collapses duplicated \.
  return joined.replace(/([^\\])[\\/]+/g, "$1\\");
}

export function modsDir(gameDir: string): string {
  return joinPath(gameDir, "mods");
}

export function modDir(gameDir: string, modName: string): string {
  if (!isValidModName(modName)) {
    throw new Error(`非法 mod 名：${JSON.stringify(modName)}`);
  }
  return joinPath(gameDir, "mods", modName);
}

/** %UserProfile%\Saved Games\Diablo II Resurrected */
export async function saveRoot(): Promise<string> {
  return joinPath(tjs.homeDir, "Saved Games", "Diablo II Resurrected");
}

/**
 * Resolve a modinfo savepath to the actual save directory.
 * "../" (or ".") means the mod writes into the root save dir — it shares
 * the main profile saves, which the UI must surface as 共用主存档.
 */
export async function modSaveDir(savepath: string): Promise<string> {
  const sp = savepath.trim();
  const root = await saveRoot();
  if (sp === "../" || sp === ".." || sp === "." || sp === "") return root;
  return joinPath(root, "mods", sp);
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await tjs.stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function validateGameDir(gameDir: string): Promise<GameValidation> {
  let exists = false;
  let hasD2R = false;
  let hasModsDir = false;
  try {
    exists = (await tjs.stat(gameDir)).isDirectory;
  } catch {
    exists = false;
  }
  if (exists) {
    hasD2R = await pathExists(joinPath(gameDir, "D2R.exe"));
    hasModsDir = await pathExists(modsDir(gameDir));
  }
  return { exists, hasD2R, hasModsDir };
}

/** Create <gameDir>\mods if missing (the game dir ships without one). */
export async function ensureModsDir(gameDir: string): Promise<void> {
  await tjs.makeDir(modsDir(gameDir), { recursive: true });
}
