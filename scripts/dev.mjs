// Dev wrapper: hands the ztron CLI the native chain built in the local ztron
// repo (this app lives outside that tree, so walk-up can't find it).
// NOTE: backend edits (src/**) require restarting this script — only the
// frontend gets Vite HMR.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeLibs = process.env.ZTRON_NATIVE_LIBS ?? "C:\\Users\\ZYJ\\orca\\ztron\\native\\libs";
const cli = path.join(appRoot, "node_modules", "@zturnlibs", "ztron-cli", "dist", "index.js");

if (!existsSync(cli)) {
  console.error("[d2rbox] ztron CLI not found — run `pnpm install` first.");
  process.exit(1);
}
if (!existsSync(path.join(nativeLibs, "tjs.exe"))) {
  console.error(`[d2rbox] tjs.exe not found under ${nativeLibs} — build natives or set ZTRON_NATIVE_LIBS.`);
  process.exit(1);
}

const child = spawn(process.execPath, [cli, "dev"], {
  cwd: appRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    ZTRON_TJS: path.join(nativeLibs, "tjs.exe"),
    ZTRON_HOST_BIN: path.join(nativeLibs, "ztron-host.exe"),
    ZTRON_WEBVIEW_LIB: path.join(nativeLibs, "webview.dll"),
  },
});
child.on("exit", (code) => process.exit(code ?? 0));
