/**
 * M3 probe — 作者脚本 (bat 扫描/受控运行) + 存档转移, against a SANDBOX game
 * dir / save tree under tmp, plus a read-only scan of the real VIPer_cs bats.
 * Run: node scripts/run-probe.mjs phase5-probe.ts
 */
import {
  scanModScripts,
  runModScript,
  type ScriptRunLine,
} from "../src/services/authscripts.js";
import { listCharacters, transferCharacters, listBackups, deleteBackup } from "../src/services/saves.js";
import { loadConfig } from "../src/services/config.js";
import { joinPath, pathExists } from "../src/services/paths.js";

// transfer 预备份写进真实备份库 — 记住既有 id，收尾时只删本探针创建的
const preExisting = new Set((await listBackups()).backups.map((b) => b.id));

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`PASS ${label}`);
  } else {
    failures++;
    console.log(`FAIL ${label}`, detail !== undefined ? JSON.stringify(detail) : "");
  }
}

async function expectThrow(label: string, fn: () => Promise<unknown>, re: RegExp) {
  try {
    await fn();
    check(label, false, "(no throw)");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    check(label, re.test(msg), msg);
  }
}

// -- sandbox game dir with GBK bat fixtures ----------------------------------
// GBK fixture: ASCII 结构 + 一对 GBK 高位字节（"中" = D6 D0），证明分析只依赖
// ASCII 结构、GBK 字节不会破坏匹配。
const gbkZh = [0xd6, 0xd0];
function batBytes(lines: string[], injectGbkLine: number): Uint8Array {
  const bytes: number[] = [];
  lines.forEach((l, i) => {
    if (i === injectGbkLine) bytes.push(...gbkZh); // 行首塞一对 GBK 字节
    for (let k = 0; k < l.length; k++) bytes.push(l.charCodeAt(k) & 0x7f);
    bytes.push(0x0d, 0x0a);
  });
  return new Uint8Array(bytes);
}

const game = joinPath(tjs.tmpDir, `d2rbox-m3probe-${Date.now()}`);
const modA = joinPath(game, "mods", "ModA");
await tjs.makeDir(modA, { recursive: true });

await tjs.writeFile(
  joinPath(modA, "kill.bat"),
  batBytes(
    [
      "@echo off",
      "rem switch helper - 中文说明占位（GBK 字节在上一行注入）",
      "echo switching...",
      "taskkill /f /im D2R.exe",
      "del .\\mods\\MDK\\config.txt",
      "pause",
    ],
    1,
  ),
);
await tjs.writeFile(
  joinPath(modA, "run.bat"),
  batBytes(
    [
      "@echo off",
      'start "" D2R.exe -w',
      "xcopy /y .\\mods\\MDK\\settings.ini .\\",
    ],
    -1,
  ),
);
await tjs.writeFile(
  joinPath(modA, "echo.bat"),
  batBytes(
    ["@echo off", "echo HELLO-PROBE-12345", "echo ERR-LINE 1>&2", "pause"],
    -1,
  ),
);

// -- 1. scanModScripts (sandbox) ---------------------------------------------
const scan = await scanModScripts(game, ["ModA", "Ghost"]); // Ghost 目录不存在 — 忽略
check("scan skips missing mod dir", scan.mods.length === 1 && scan.mods[0]?.mod === "ModA");
const scripts = scan.mods[0]?.scripts ?? [];
check("scan finds 3 bats sorted", scripts.map((s) => s.name).join(",") === "echo.bat,kill.bat,run.bat", scripts.map((s) => s.name));

const kill = scripts.find((s) => s.name === "kill.bat");
const run = scripts.find((s) => s.name === "run.bat");
check("kill.bat killsGame", kill?.sideEffects.killsGame === true);
check("kill.bat pauses", kill?.sideEffects.pauses === true);
check("kill.bat not launchesGame", kill?.sideEffects.launchesGame === false);
check("kill.bat missingTarget MDK", kill?.missingTargets.includes("MDK") === true, kill?.missingTargets);
check("run.bat launchesGame", run?.sideEffects.launchesGame === true);
check("run.bat not killsGame", run?.sideEffects.killsGame === false);
check("run.bat forward-slash ref maps to MDK", run?.missingTargets.includes("MDK") === true, run?.missingTargets);
check("b64 round-trip has GBK bytes", (() => {
  const bin = atob(kill?.b64 ?? "");
  const bytes = [...bin].map((c) => c.charCodeAt(0));
  const i = bytes.indexOf(0xd6);
  return i >= 0 && bytes[i + 1] === 0xd0;
})());

// -- 2. runModScript: output capture + pause EOF + exit code ------------------
const outLines: ScriptRunLine[] = [];
const t0 = Date.now();
const rr = await runModScript({
  gameDir: game,
  modName: "ModA",
  fileName: "echo.bat",
  onLine: (l) => outLines.push(l),
});
const elapsed = Date.now() - t0;
const outText = outLines
  .filter((l) => l.stream === "out")
  .map((l) => atob(l.b64))
  .join("|");
const errText = outLines
  .filter((l) => l.stream === "err")
  .map((l) => atob(l.b64))
  .join("|");
check("run exit code 0", rr.code === 0, rr);
check("run not timedOut", rr.timedOut === false);
check("run fast (pause EOF passes)", elapsed < 20_000, `${elapsed}ms`);
check("stdout captured", outText.includes("HELLO-PROBE-12345"), outText);
check("stderr captured", errText.includes("ERR-LINE"), errText);

await expectThrow("runScript rejects traversal", () =>
  runModScript({ gameDir: game, modName: "../x", fileName: "a.bat", onLine: () => undefined }),
  /非法 mod 名/,
);
await expectThrow("runScript rejects non-bat", () =>
  runModScript({ gameDir: game, modName: "ModA", fileName: "../mods/ModA/kill.bat", onLine: () => undefined }),
  /非法脚本名/,
);

// -- 3. real read-only scan: VIPer_cs bats ------------------------------------
const cfg = await loadConfig();
if (cfg.gameDir && (await pathExists(joinPath(cfg.gameDir, "mods", "VIPer_cs")))) {
  const real = await scanModScripts(cfg.gameDir, ["VIPer_cs"]);
  const rs = real.mods[0]?.scripts ?? [];
  check("real VIPer_cs has 2 bats", rs.length === 2, rs.map((s) => s.name));
  check("real: one kills game", rs.some((s) => s.sideEffects.killsGame));
  check("real: one launches game", rs.some((s) => s.sideEffects.launchesGame));
  check(
    "real: MDK missing in union",
    [...new Set(rs.flatMap((s) => s.missingTargets))].includes("MDK"),
    rs.flatMap((s) => s.missingTargets),
  );
} else {
  console.log("SKIP real VIPer_cs scan (game dir not configured)");
}

// -- 4. transfer: sandbox root <-> mods/EJ ------------------------------------
const sb = joinPath(tjs.tmpDir, `d2rbox-m3save-${Date.now()}`);
await tjs.makeDir(sb, { recursive: true });
await tjs.writeFile(joinPath(sb, "Alpha.d2s"), new TextEncoder().encode("ALPHA-D2S"));
await tjs.writeFile(joinPath(sb, "Alpha.ctl"), new TextEncoder().encode("ALPHA-CTL"));
await tjs.writeFile(joinPath(sb, "Alpha.map"), new TextEncoder().encode("ALPHA-MAP"));
await tjs.writeFile(joinPath(sb, "Beta.d2s"), new TextEncoder().encode("BETA-D2S"));
await tjs.writeFile(joinPath(sb, "Beta.d2s.backup"), new TextEncoder().encode("BETA-BAK"));
await tjs.writeFile(joinPath(sb, "Settings.json"), new TextEncoder().encode("{}"));
// mods/EJ 故意不建 — transfer 需自动创建目标目录

const root0 = await listCharacters(sb, "root");
check("list root: 2 chars", root0.characters.length === 2, root0.characters.map((c) => c.name));
const alpha0 = root0.characters.find((c) => c.name === "Alpha");
check("Alpha companions=2", alpha0?.companions.length === 2, alpha0);

// copy Alpha → mods/EJ（目录自动创建）
const cp = await transferCharacters({ saveDir: sb, fromSlot: "root", toSlot: "mods/EJ", names: ["Alpha"], mode: "copy", backupKeep: 5 });
check("copy ok, 1 char / 3 files", cp.ok && cp.characters === 1 && cp.files === 3, cp);
check("copy made transfer backup", cp.backupId !== null);
check("copy keeps source", new TextDecoder().decode(await tjs.readFile(joinPath(sb, "Alpha.d2s"))) === "ALPHA-D2S");
check("copy target bytes match", new TextDecoder().decode(await tjs.readFile(joinPath(sb, "mods", "EJ", "Alpha.d2s"))) === "ALPHA-D2S");
check("copy target companion", new TextDecoder().decode(await tjs.readFile(joinPath(sb, "mods", "EJ", "Alpha.map"))) === "ALPHA-MAP");

// move Beta → mods/EJ
const mv = await transferCharacters({ saveDir: sb, fromSlot: "root", toSlot: "mods/EJ", names: ["Beta"], mode: "move", backupKeep: 5 });
check("move ok, 2 files", mv.ok && mv.files === 2, mv);
check("move target present", (await pathExists(joinPath(sb, "mods", "EJ", "Beta.d2s.backup"))) === true);
check("move deletes source .d2s", (await pathExists(joinPath(sb, "Beta.d2s"))) === false);
check("move deletes source companion", (await pathExists(joinPath(sb, "Beta.d2s.backup"))) === false);

// 备份库里有 trigger=transfer 的快照，note 说明动作
const metas = (await listBackups()).backups;
const tb = metas.find((b) => b.id === cp.backupId);
check("transfer backup trigger", tb?.trigger === "transfer", tb?.trigger);
check("transfer backup note", (tb?.note ?? "").includes("复制 1 个角色"), tb?.note);
const tb2 = metas.find((b) => b.id === mv.backupId);
check("move backup note", (tb2?.note ?? "").includes("移动 1 个角色"), tb2?.note);

// refusals
await expectThrow("same slot refused", () =>
  transferCharacters({ saveDir: sb, fromSlot: "root", toSlot: "root", names: ["Alpha"], mode: "copy", backupKeep: 5 }),
  /相同/,
);
await expectThrow("missing char refused", () =>
  transferCharacters({ saveDir: sb, fromSlot: "root", toSlot: "mods/EJ", names: ["Ghost"], mode: "copy", backupKeep: 5 }),
  /找不到角色/,
);
await expectThrow("name conflict refused", () =>
  transferCharacters({ saveDir: sb, fromSlot: "root", toSlot: "mods/EJ", names: ["Alpha"], mode: "copy", backupKeep: 5 }),
  /同名角色/,
);
check("conflict left target intact", new TextDecoder().decode(await tjs.readFile(joinPath(sb, "mods", "EJ", "Alpha.d2s"))) === "ALPHA-D2S");

// -- cleanup --------------------------------------------------------------------
await tjs.remove(game, { recursive: true, maxRetries: 3, retryDelay: 200 });
await tjs.remove(sb, { recursive: true, maxRetries: 3, retryDelay: 200 });
check("sandbox cleaned", !(await pathExists(game)) && !(await pathExists(sb)));

for (const b of await listBackups().then((r) => r.backups)) {
  if (!preExisting.has(b.id)) await deleteBackup(b.id).catch(() => undefined);
}
check("backup store cleaned", (await listBackups()).backups.every((b) => preExisting.has(b.id)));

console.log(failures === 0 ? "\nPROBE_ALL_PASS" : `\nPROBE_FAILURES=${failures}`);
