/**
 * Launch, pick-folder and shortcut export. The game itself is spawned
 * directly (array argv — no string interpolation, so the en-dash / Chinese
 * path is safe); only dialogs and .lnk creation go through PowerShell.
 */
import { joinPath, pathExists } from "./paths.js";
import { runPowerShell, parseOkMarker } from "./ps.js";

/**
 * Seed rules from the pack conventions (see docs/product-plan.md §2):
 * savepath "../" → shared main saves, the VIPer line — no -txt;
 * isolated savepath → the EJ line — needs -txt to read extracted txt files.
 * The ModManager UI shows this suggestion; profiles can override via
 * extraArgs.
 */
export function suggestLaunchArgs(mod: { name: string; savepath: string }): string[] {
  return mod.savepath.trim() === "../"
    ? ["-mod", mod.name]
    : ["-mod", mod.name, "-txt"];
}

/** Fire-and-forget launch: stdio ignored so we never hold the game's pipes. */
export async function launchGame(gameDir: string, args: string[]): Promise<{ pid: number }> {
  const exe = joinPath(gameDir, "D2R.exe");
  if (!(await pathExists(exe))) {
    throw new Error(`未找到 D2R.exe：${exe}`);
  }
  const proc = tjs.spawn([exe, ...args], {
    cwd: gameDir,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const pid = proc.pid;
  void proc.wait().catch(() => undefined); // hygiene: let the exit be reaped
  return { pid };
}

/** Native folder picker via FolderBrowserDialog (host dialog.open ignores
 *  directory:true on Windows). Returns null when the user cancels. */
export async function pickFolder(title: string): Promise<string | null> {
  const script = [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
    "$dlg = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$dlg.Description = $env:D2R_PICK_TITLE",
    "$dlg.ShowNewFolderButton = $false",
    "$owner = New-Object System.Windows.Forms.Form",
    "$owner.TopMost = $true",
    "if ($dlg.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output ('__D2R_OK__' + $dlg.SelectedPath) }",
    "$owner.Dispose()",
  ].join("; ");
  const res = await runPowerShell({
    command: script,
    env: { D2R_PICK_TITLE: title },
    timeoutMs: 120_000, // user may linger in the dialog
  });
  if (res.code !== 0 && res.stdout.trim() === "") {
    throw new Error(`目录选择失败：${res.stderr.trim() || `exit ${res.code}`}`);
  }
  return parseOkMarker(res.stdout);
}

/** Native file picker via OpenFileDialog (same story as pickFolder — the
 *  host's file dialog can't be aimed from the backend). With `save:true`
 *  it becomes a SaveFileDialog (save-as mode, overwrite prompt, suggested
 *  file name). Returns null when the user cancels. */
export async function pickFile(opts: {
  title: string;
  filterName: string; // e.g. "仓库文件"
  pattern: string; // e.g. "*.d2i"
  save?: boolean;
  defaultName?: string; // save mode: suggested file name
}): Promise<string | null> {
  const dialogType = opts.save ? "SaveFileDialog" : "OpenFileDialog";
  const script = [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
    `$dlg = New-Object System.Windows.Forms.${dialogType}`,
    "$dlg.Title = $env:D2R_PICK_TITLE",
    "$dlg.Filter = $env:D2R_PICK_FILTER + ' (' + $env:D2R_PICK_PATTERN + ')|' + $env:D2R_PICK_PATTERN",
    ...(opts.save
      ? ["$dlg.OverwritePrompt = $true"]
      : ["$dlg.DereferenceLinks = $true"]),
    ...(opts.save && opts.defaultName
      ? ["$dlg.FileName = $env:D2R_PICK_DEFAULT"]
      : []),
    "$owner = New-Object System.Windows.Forms.Form",
    "$owner.TopMost = $true",
    "if ($dlg.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output ('__D2R_OK__' + $dlg.FileName) }",
    "$owner.Dispose()",
  ].join("; ");
  const res = await runPowerShell({
    command: script,
    env: {
      D2R_PICK_TITLE: opts.title,
      D2R_PICK_FILTER: opts.filterName,
      D2R_PICK_PATTERN: opts.pattern,
      ...(opts.save && opts.defaultName
        ? { D2R_PICK_DEFAULT: opts.defaultName }
        : {}),
    },
    timeoutMs: 120_000,
  });
  if (res.code !== 0 && res.stdout.trim() === "") {
    throw new Error(`文件选择失败：${res.stderr.trim() || `exit ${res.code}`}`);
  }
  return parseOkMarker(res.stdout);
}

/**
 * Create a desktop .lnk via WScript.Shell. The generated .ps1 is written
 * UTF-8 **with BOM** (PS 5.1 assumes ANSI otherwise) and all values travel
 * through env. Returns the actual lnk path — desktop may be OneDrive-
 * redirected, so the script reports where it really wrote.
 */
export async function exportShortcut(opts: {
  fileName: string; // e.g. "EJ 开荒.lnk" — sanitized by the caller
  targetExe: string;
  args: string;
  workDir: string;
}): Promise<string> {
  const script = [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$desktop = [Environment]::GetFolderPath('Desktop')",
    "$lnkPath = Join-Path $desktop $env:D2R_LNK_FILE",
    "$ws = New-Object -ComObject WScript.Shell",
    "$sc = $ws.CreateShortcut($lnkPath)",
    "$sc.TargetPath = $env:D2R_LNK_EXE",
    "$sc.Arguments = $env:D2R_LNK_ARGS",
    "$sc.WorkingDirectory = $env:D2R_LNK_CWD",
    "$sc.IconLocation = \"$env:D2R_LNK_EXE,0\"",
    "$sc.Save()",
    "Write-Output ('__D2R_OK__' + $lnkPath)",
  ].join("\n");

  const body = new TextEncoder().encode(script);
  const ps1 = joinPath(tjs.tmpDir, `d2rbox-shortcut-${Date.now()}.ps1`);
  const withBom = new Uint8Array(3 + body.length);
  withBom[0] = 0xef;
  withBom[1] = 0xbb;
  withBom[2] = 0xbf;
  withBom.set(body, 3);
  await tjs.writeFile(ps1, withBom);

  try {
    const res = await runPowerShell({
      command: "",
      file: ps1,
      env: {
        D2R_LNK_FILE: opts.fileName,
        D2R_LNK_EXE: opts.targetExe,
        D2R_LNK_ARGS: opts.args,
        D2R_LNK_CWD: opts.workDir,
      },
      timeoutMs: 30_000,
    });
    const lnk = parseOkMarker(res.stdout);
    if (!lnk || !(await pathExists(lnk))) {
      throw new Error(`快捷方式创建失败：${res.stderr.trim() || `exit ${res.code}`}`);
    }
    return lnk;
  } finally {
    await tjs.remove(ps1).catch(() => undefined);
  }
}

/** Open a folder in Explorer (read-only convenience for settings/cards). */
export async function openInExplorer(p: string): Promise<void> {
  tjs.spawn(["explorer.exe", p], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
}
