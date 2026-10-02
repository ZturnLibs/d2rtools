/**
 * PowerShell bridge. Used only where the Windows host has no native story
 * yet: the folder picker (host_windows.c still ships GetOpenFileNameA, which
 * ignores directory:true) and .lnk creation. Rules:
 *  - never interpolate paths into the script text — pass them via child env;
 *  - force UTF-8 console output and parse a __D2R_OK__ marker, so an empty
 *    result (user cancelled) is distinguishable from noise;
 *  - -STA is required for WinForms dialogs.
 */
import { tjsEnv } from "./env.js";

export interface PsResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function runPowerShell(opts: {
  command: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Run via -File with -ExecutionPolicy Bypass instead of -Command. */
  file?: string;
}): Promise<PsResult> {
  const args = [
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-STA",
    ...(opts.file
      ? ["-ExecutionPolicy", "Bypass", "-File", opts.file]
      : ["-Command", opts.command]),
  ];
  const proc = tjs.spawn(args, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...tjsEnv(), ...opts.env },
  });

  let timedOut = false;
  const timer =
    opts.timeoutMs && opts.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          try {
            proc.kill();
          } catch {
            /* already gone */
          }
        }, opts.timeoutMs)
      : null;

  try {
    const [stdout, stderr, status] = await Promise.all([
      proc.stdout ? proc.stdout.text() : Promise.resolve(""),
      proc.stderr ? proc.stderr.text() : Promise.resolve(""),
      proc.wait(),
    ]);
    if (timedOut) throw new Error(`PowerShell 执行超时（${opts.timeoutMs}ms）`);
    return { code: status.exit_status ?? -1, stdout, stderr };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Extract a __D2R_OK__<payload> line from PS stdout, null when absent. */
export function parseOkMarker(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("__D2R_OK__")) {
      return trimmed.slice("__D2R_OK__".length);
    }
  }
  return null;
}
