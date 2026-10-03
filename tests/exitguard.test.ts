import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeSandbox, type TestSandbox } from "./setup.js";
import { joinPath } from "../src/services/paths.js";
import {
  captureFingerprint,
  armLaunchWatch,
  clearLaunchWatch,
  postExitCheck,
} from "../src/services/exitguard.js";
import { loadConfig } from "../src/services/config.js";
import { listBackups } from "../src/services/saves.js";

let sb: TestSandbox;
let saveDir: string;

/** name 为完整文件名（调用方自带 .d2s 后缀），避免误拼出 .d2s.d2s。 */
async function seedChar(name: string, body: string): Promise<void> {
  await tjs.writeFile(joinPath(saveDir, name), body);
}

beforeEach(async () => {
  sb = await makeSandbox();
  saveDir = joinPath(sb.home, "Saved Games", "Diablo II Resurrected");
  await tjs.makeDir(saveDir, { recursive: true });
});

afterEach(async () => {
  await sb.cleanup();
});

describe("captureFingerprint", () => {
  it("lists top-level files sorted, with size/mtime", async () => {
    await seedChar("B.d2s", "bbb");
    await seedChar("A.d2s", "aaaa");
    const fps = await captureFingerprint(saveDir, ["root"]);
    expect(fps).toHaveLength(1);
    expect(fps[0]!.slot).toBe("root");
    expect(fps[0]!.files.map((f) => f.name)).toEqual(["A.d2s", "B.d2s"]);
    expect(fps[0]!.files[0]!.size).toBe(4);
    expect(fps[0]!.files[0]!.mtime).toBeGreaterThan(0);
  });

  it("keeps a missing slot as empty file list instead of throwing", async () => {
    const fps = await captureFingerprint(saveDir, ["mods/Ghost"]);
    expect(fps[0]!.files).toEqual([]);
  });
});

describe("postExitCheck", () => {
  const WATCH = {
    startedAt: 1,
    pid: 42,
    slots: ["root" as const],
    fingerprint: [] as Awaited<ReturnType<typeof captureFingerprint>>,
    backupId: "bak_anchor" as string | null,
  };

  it("returns watched=false when no launch watch is armed (idempotent tail)", async () => {
    const r = await postExitCheck({ saveDir, backupKeep: 5, zip: false });
    expect(r).toMatchObject({ running: false, watched: false, changed: false, lost: [] });
  });

  it("backs up changed saves on exit and reports changed", async () => {
    await seedChar("Hero.d2s", "v1");
    const fingerprint = await captureFingerprint(saveDir, ["root"]);
    await armLaunchWatch({ ...WATCH, fingerprint, backupId: null });

    // 游戏跑了一局：改了角色 + 新增一个角色
    await seedChar("Hero.d2s", "v2-with-more-loot");
    await seedChar("Newbie.d2s", "x");

    const r = await postExitCheck({ saveDir, backupKeep: 5, zip: false });
    expect(r.running).toBe(false);
    expect(r.watched).toBe(true);
    expect(r.changed).toBe(true);
    expect(r.lost).toEqual([]);
    expect(r.backupId).not.toBeNull();

    const metas = (await listBackups()).backups;
    expect(metas.find((b) => b.id === r.backupId)?.trigger).toBe("auto-exit");
    // 处理完即清，重复调用 watched=false
    expect((await postExitCheck({ saveDir, backupKeep: 5, zip: false })).watched).toBe(false);
  });

  it("does nothing when the save tree is untouched (增量语义)", async () => {
    await seedChar("Hero.d2s", "same");
    const fingerprint = await captureFingerprint(saveDir, ["root"]);
    await armLaunchWatch({ ...WATCH, fingerprint, backupId: null });

    const r = await postExitCheck({ saveDir, backupKeep: 5, zip: false });
    expect(r.changed).toBe(false);
    expect(r.backupId).toBeNull();
    expect((await listBackups()).backups).toHaveLength(0);
  });

  it("flags vanished .d2s as lost and keeps the pre-launch anchor", async () => {
    await seedChar("Hero.d2s", "doomed");
    await seedChar("Keeper.d2s", "fine");
    const fingerprint = await captureFingerprint(saveDir, ["root"]);
    await armLaunchWatch({ ...WATCH, fingerprint, backupId: "bak_anchor" });

    await tjs.remove(joinPath(saveDir, "Hero.d2s"));
    // Keeper 也动一下，确保 lost 检测独立于 changed（本来 changed 就为 true）
    await seedChar("Keeper.d2s", "fine-v2");

    const r = await postExitCheck({ saveDir, backupKeep: 5, zip: false });
    expect(r.changed).toBe(true);
    expect(r.lost).toEqual(["Hero.d2s"]);
    expect(r.preLaunchBackupId).toBe("bak_anchor");
  });

  it("clears the watch even when nothing changed", async () => {
    await armLaunchWatch({ ...WATCH, fingerprint: await captureFingerprint(saveDir, ["root"]) });
    await postExitCheck({ saveDir, backupKeep: 5, zip: false });
    expect((await loadConfig()).launchWatch).toBeNull();
  });

  it("arm/clear round-trips through config", async () => {
    await armLaunchWatch({ ...WATCH });
    expect((await loadConfig()).launchWatch?.pid).toBe(42);
    await clearLaunchWatch();
    expect((await loadConfig()).launchWatch).toBeNull();
    // 已是 null 时再清不报错
    await clearLaunchWatch();
  });
});
