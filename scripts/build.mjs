// Build wrapper for `ztron build`. Uses the LOCAL ztron repo's CLI (the
// win32 packaging branch lives there first; the npm 0.3.8 release predates
// it) and the repo's native chain, same as dev.mjs.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeLibs = process.env.ZTRON_NATIVE_LIBS ?? "C:\\Users\\ZYJ\\orca\\ztron\\native\\libs";
const repoCli = "C:\\Users\\ZYJ\\orca\\ztron\\packages\\cli\\dist\\index.js";

for (const f of [repoCli, path.join(nativeLibs, "tjs.exe")]) {
  if (!existsSync(f)) {
    console.error(`[d2rbox] missing ${f} — check the ztron repo checkout.`);
    process.exit(1);
  }
}

const child = spawn(process.execPath, [repoCli, "build"], {
  cwd: appRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    ZTRON_TJS: path.join(nativeLibs, "tjs.exe"),
    ZTRON_HOST_BIN: path.join(nativeLibs, "ztron-host.exe"),
    ZTRON_WEBVIEW_LIB: path.join(nativeLibs, "webview.dll"),
    ZTRON_MAKENSIS: process.env.ZTRON_MAKENSIS ?? "C:\\Users\\ZYJ\\orca\\tools\\nsis-3.12\\makensis.exe",
  },
});
child.on("exit", (code) => process.exit(code ?? 0));
