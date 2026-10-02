/**
 * D2R 工具箱 backend. All filesystem/process work lives in d2r:* commands
 * (src/commands.ts) running directly on tjs — no plugin scopes, no ACL
 * gating (app:* commands bypass it). The webview talks to these through the
 * codegen bindings in src/ztron-commands.ts.
 */
import { AppBuilder, loadCapabilities } from "@zturnlibs/ztron-core";
import { commandDefs } from "./commands.js";
import { HostRuntime } from "@zturnlibs/ztron-runtime-ffi";

const runtime = new HostRuntime({
  host: tjs.env.ZTRON_HOST ?? "127.0.0.1",
  port: Number(tjs.env.ZTRON_HOST_PORT),
});
await runtime.connect();
console.log("[d2rbox] backend connected");

// The CLI points ZTRON_DEV_URL at the Vite dev server / built frontend;
// inline html is only a fallback when neither exists.
const devUrl = tjs.env.ZTRON_DEV_URL;
const inlineHtml = `<!doctype html>
<html>
  <body style="font-family:system-ui;padding:2rem">
    <h1>D2R 工具箱</h1>
    <p>frontend unavailable - run the Vite dev frontend via ztron dev</p>
  </body>
</html>`;

const conf = tjs.env.ZTRON_CONF
  ? (JSON.parse(tjs.env.ZTRON_CONF) as Parameters<AppBuilder["fromConfig"]>[0])
  : {};
if (!devUrl) {
  for (const w of conf.windows ?? []) {
    if (w.url === "frontend") {
      delete w.url;
      w.html = inlineHtml;
    }
  }
}

const capabilities = await loadCapabilities(
  tjs.env.ZTRON_CAPABILITIES_DIR ?? "./capabilities",
);

new AppBuilder(runtime, "com.zyj.d2rbox")
  .configure({
    invokeKey: tjs.env.ZTRON_INVOKE_KEY ?? Math.random().toString(36).slice(2),
    capabilities,
  })
  .fromConfig(conf, { frontendUrl: devUrl ?? undefined })
  .setup((app) => {
    // One line per command: a loop over Object.values() collapses the
    // heterogeneous CommandDef generics into an unassignable union.
    app.commandDef(commandDefs.getConfig);
    app.commandDef(commandDefs.setGameDir);
    app.commandDef(commandDefs.pickFolder);
    app.commandDef(commandDefs.addSource);
    app.commandDef(commandDefs.removeSource);
    app.commandDef(commandDefs.scanSource);
    app.commandDef(commandDefs.listMods);
    app.commandDef(commandDefs.installMod);
    app.commandDef(commandDefs.uninstallPreflight);
    app.commandDef(commandDefs.uninstallMod);
    app.commandDef(commandDefs.readTextB64);
    app.commandDef(commandDefs.saveProfiles);
    app.commandDef(commandDefs.launch);
    app.commandDef(commandDefs.exportShortcut);
    app.commandDef(commandDefs.openDir);
    app.commandDef(commandDefs.saveOverview);
    app.commandDef(commandDefs.listBackups);
    app.commandDef(commandDefs.backupNow);
    app.commandDef(commandDefs.restoreBackup);
    app.commandDef(commandDefs.deleteBackup);
    app.commandDef(commandDefs.setBackupNote);
    app.commandDef(commandDefs.setSavePrefs);
    app.commandDef(commandDefs.checkGameRunning);
    app.commandDef(commandDefs.stashPickFile);
    app.commandDef(commandDefs.stashPreflight);
    app.commandDef(commandDefs.stashReplace);
    app.commandDef(commandDefs.modScripts);
    app.commandDef(commandDefs.runScript);
    app.commandDef(commandDefs.listCharacters);
    app.commandDef(commandDefs.transferCharacters);
    console.log("[d2rbox] registered 30 d2r:* commands");
  })
  .build()
  .run();
