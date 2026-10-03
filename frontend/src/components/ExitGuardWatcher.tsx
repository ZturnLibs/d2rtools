/**
 * 存档守护（M7）：全局轮询游戏进程，捕捉「运行中 → 已退出」沿后调用
 * postExitCheck —— 后端据此清掉启动看护、做增量备份（auto-exit）、并把
 * 丢失的 .d2s 与启动前锚点快照一并报回来。有丢失时弹模态窗，提供一键
 * 还原到启动前；仅有变化时右下角轻提示。
 *
 * 轮询无关当前所在工具页 —— 游戏退出可能发生在任何页面。
 */
import { useEffect, useRef, useState } from "react";
import { invoke, errMsg } from "../lib/ipc";
import type { PostExitCheckResult } from "../lib/types";
import { Modal } from "./Modal";
import { btnGhost } from "../App";

const btnPrimary =
  "rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40";

const POLL_MS = 5000;

export function ExitGuardWatcher() {
  const wasRunning = useRef(false);
  const [report, setReport] = useState<PostExitCheckResult | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [restoreErr, setRestoreErr] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      let running = false;
      try {
        const r = await invoke("d2r:checkGameRunning", {});
        running = r.running;
      } catch {
        return; // 后端忙/重启 —— 下个周期再试
      }
      if (!alive) return;
      const exited = wasRunning.current && !running;
      wasRunning.current = running;
      if (!exited) return;
      try {
        const r = await invoke("d2r:postExitCheck", {});
        if (!alive) return;
        if (!r.watched) return; // 不是经本工具启动的（或看护已处理）
        if (r.lost.length > 0) {
          setReport(r);
        } else if (r.changed && r.backupId) {
          setToast(`检测到存档变化，退出游戏后已自动备份（${r.backupId}）`);
        }
        // 存档管家页若开着，让它刷新备份/总览
        window.dispatchEvent(new CustomEvent("d2rbox:backups-changed"));
      } catch {
        /* postExitCheck 自身不抛；兜底忽略 */
      }
    };
    const id = setInterval(() => void tick(), POLL_MS);
    void tick();
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // toast 自动消失
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 8000);
    return () => clearTimeout(t);
  }, [toast]);

  const restore = async () => {
    if (!report?.preLaunchBackupId) return;
    setBusy(true);
    setRestoreErr(null);
    try {
      await invoke("d2r:restoreBackup", { id: report.preLaunchBackupId });
      setRestored(true);
    } catch (err) {
      setRestoreErr(errMsg(err)); // 例：游戏已被重新启动 → 留在窗内看
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {report && (
        <Modal
          title="⚠ 检测到角色存档丢失"
          onClose={() => {
            setReport(null);
            setRestored(false);
            setRestoreErr(null);
          }}
          footer={
            restored ? (
              <button
                className={btnPrimary}
                onClick={() => {
                  setReport(null);
                  setRestored(false);
                }}
              >
                知道了
              </button>
            ) : (
              <>
                <button
                  className={btnGhost}
                  onClick={() => {
                    setReport(null);
                    setRestoreErr(null);
                  }}
                >
                  暂不处理
                </button>
                <button
                  className={btnPrimary}
                  disabled={busy || !report.preLaunchBackupId}
                  title={
                    report.preLaunchBackupId
                      ? `还原到启动前快照 ${report.preLaunchBackupId}`
                      : "启动时未生成锚点快照，无法自动还原"
                  }
                  onClick={() => void restore()}
                >
                  {busy ? "还原中…" : "一键还原到启动前"}
                </button>
              </>
            )
          }
        >
          <div className="space-y-3 text-sm">
            <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3.5 py-3 text-red-300">
              游戏退出后，以下角色存档文件消失了：
              <ul className="mt-1.5 list-disc pl-5 text-xs">
                {report.lost.map((name) => (
                  <li key={name} className="break-all font-mono">
                    {name}
                  </li>
                ))}
              </ul>
            </div>
            <p className="text-xs text-neutral-400">
              可能是游戏崩溃或杀毒软件误删。启动前已自动创建快照
              {report.preLaunchBackupId ? (
                <span className="font-mono">（{report.preLaunchBackupId}）</span>
              ) : null}
              ，一键还原可找回丢失角色；还原前也会先备份当前状态。
            </p>
            {report.changed && report.backupId && !restored && (
              <p className="text-xs text-neutral-500">
                其余存档变化已先备份为 <span className="font-mono">{report.backupId}</span>。
              </p>
            )}
            {restored && (
              <p className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3.5 py-2.5 text-emerald-300">
                已还原到启动前快照，丢失的角色存档应已找回。
              </p>
            )}
            {restoreErr && (
              <p className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                {restoreErr}
              </p>
            )}
          </div>
        </Modal>
      )}
      {toast && (
        <div className="fixed bottom-5 right-5 z-40 max-w-sm rounded-xl border border-emerald-500/30 bg-[#0d1017] px-4 py-3 text-sm text-emerald-300 shadow-2xl">
          <div className="flex items-start gap-3">
            <span className="min-w-0">{toast}</span>
            <button
              className="shrink-0 opacity-60 transition-opacity hover:opacity-100"
              onClick={() => setToast(null)}
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </>
  );
}
