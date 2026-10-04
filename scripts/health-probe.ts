/**
 * M8 实机探针：在真实 tjs 下跑 health 服务（与打包同款 esbuild 参数），
 * 对真实游戏目录做环境体检，验证 PowerShell 合并探针的语法 / 编码 /
 * Get-MpPreference 兼容性。--commands 模式走 d2r:healthCheck 命令处理器
 * 全链路（含 loadConfig），与前端 invoke 完全一致。
 */
import { commandDefs } from "../src/commands.js";

const GAME_DIR = "D:/Games/Diablo II Resurrected – Infernal Edition";
const t0 = Date.now();
const COMMANDS = false; // 改 true 走命令处理器全链路（tjs 无 process 全局）

if (COMMANDS) {
  const r = await commandDefs.healthCheck.handler({} as never, undefined as never);
  console.log("[probe] healthCheck handler: gameDir =", r.gameDir, "durationMs =", r.durationMs);
  for (const it of r.items) {
    console.log(`[probe] [${it.status}] ${it.group}/${it.id}: ${it.detail}`);
    if (it.fixSteps.length) console.log(`[probe]   fix: ${it.fixSummary ?? ""} | ${it.fixSteps.join(" / ")}`);
  }
  console.log("[probe] commands done in", Date.now() - t0, "ms");
}

// 服务直调（对照模式：gameDir/knownModNames 手工传入）
const { runHealthCheck, buildSystemProbeCommand } = await import("../src/services/health.js");

// 先单独看合并探针的原始输出
const { runPowerShell, parseOkMap } = await import("../src/services/ps.js");
const ps = await runPowerShell({
  command: buildSystemProbeCommand(),
  env: { D2R_EXE: `${GAME_DIR}\\D2R.exe` },
  timeoutMs: 10_000,
});
console.log("[probe] PS exit:", ps.code, "in", Date.now() - t0, "ms");
console.log("[probe] values:", JSON.stringify(parseOkMap(ps.stdout)));

// 再跑完整体检
const r = await runHealthCheck({ gameDir: GAME_DIR, knownModNames: ["EJ", "VIPer_cs"] });
console.log("[probe] runHealthCheck durationMs =", r.durationMs);
const counts: Record<string, number> = {};
for (const it of r.items) {
  counts[it.status] = (counts[it.status] ?? 0) + 1;
  console.log(`[probe] [${it.status}] ${it.group}/${it.id}: ${it.detail}`);
  if (it.fixSteps.length) console.log(`[probe]   fix: ${it.fixSummary ?? ""} | ${it.fixSteps.join(" / ")}`);
}
console.log("[probe] status counts:", JSON.stringify(counts), "total", r.items.length);
console.log("[probe] done in", Date.now() - t0, "ms");
