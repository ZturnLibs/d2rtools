/**
 * 大仓库向导（M2）: three-step SharedStash .d2i replace with guards —
 * preflight (current file + game check) → red warning + confirm → atomic
 * replace with an automatic pre-replace root snapshot as the rollback point.
 */
import { useCallback, useEffect, useState } from "react";
import { invoke, errMsg } from "../lib/ipc";
import { formatBytes, formatTime } from "../lib/decode";
import type { StashPreflightView, StashSlot } from "../lib/types";
import { btnGhost } from "../App";

const btnPrimary =
  "rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40";

const SLOT_META: Record<StashSlot, { label: string; fileName: string; hint: string }> = {
  soft: { label: "软核仓库", fileName: "SharedStashSoftCoreV2.d2i", hint: "普通/扩展角色的共享仓库" },
  hard: { label: "硬核仓库", fileName: "SharedStashHardCoreV2.d2i", hint: "专家模式角色的共享仓库" },
};

export function VaultPage(props: { goToSaves: () => void }) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [slot, setSlot] = useState<StashSlot>("soft");
  const [preflight, setPreflight] = useState<StashPreflightView | null>(null);
  const [preflightBusy, setPreflightBusy] = useState(false);
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ backupId: string | null } | null>(null);

  const runPreflight = useCallback(async (s: StashSlot) => {
    setPreflightBusy(true);
    setError(null);
    try {
      setPreflight(await invoke("d2r:stashPreflight", { slot: s }));
    } catch (err) {
      setPreflight(null);
      setError(errMsg(err));
    } finally {
      setPreflightBusy(false);
    }
  }, []);

  useEffect(() => {
    void runPreflight(slot);
  }, [slot, runPreflight]);

  const pickFile = async () => {
    setError(null);
    try {
      const r = await invoke("d2r:stashPickFile", { title: `选择要导入的 ${SLOT_META[slot].fileName}` });
      if (r.path) setSourcePath(r.path);
    } catch (err) {
      setError(errMsg(err));
    }
  };

  const execute = async () => {
    if (!sourcePath) return;
    setBusy(true);
    setError(null);
    try {
      const r = await invoke("d2r:stashReplace", { slot, sourcePath, note: note.trim() || undefined });
      setResult({ backupId: r.backupId });
      setStep(3);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const meta = SLOT_META[slot];
  const gameBlocked = preflight?.gameRunning === true;

  return (
    /* 页头固定，下方内容整体内滚；滚动容器通栏到窗体右缘，滚动条贴边 */
    <div className="flex h-full min-w-0 flex-col">
      <header className="shrink-0 px-6 pt-6">
        <div className="mx-auto max-w-2xl">
          <h2 className="text-lg font-semibold">大仓库向导</h2>
          <p className="mt-1 text-xs text-neutral-500">
            用整合包作者的 .d2i 仓库文件替换当前共享仓库 · 替换前自动备份当前主存档，可回滚
          </p>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        <div className="mx-auto max-w-2xl">

      {/* step indicator */}
      <ol className="mt-5 flex items-center gap-2 text-xs">
        {["选择文件", "确认替换", "完成"].map((label, i) => {
          const n = (i + 1) as 1 | 2 | 3;
          const cls =
            step === n
              ? "border-violet-500/60 bg-violet-500/15 text-violet-300"
              : step > n
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                : "border-neutral-800 text-neutral-600";
          return (
            <li key={label} className={`flex items-center gap-2 rounded-full border px-3 py-1 ${cls}`}>
              <span className="font-semibold">{n}</span> {label}
              {i < 2 && <span className="ml-1 text-neutral-700">→</span>}
            </li>
          );
        })}
      </ol>

      {error && (
        <div className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-sm text-red-300">
          {error}
        </div>
      )}

      {step === 1 && (
        <section className="mt-4 space-y-4 rounded-xl border border-neutral-800 bg-[#0d1017] px-5 py-4">
          <div className="space-y-2">
            {(["soft", "hard"] as const).map((s) => (
              <label
                key={s}
                className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3.5 py-3 transition-colors ${
                  slot === s ? "border-violet-500/60 bg-violet-500/10" : "border-neutral-800 hover:border-neutral-700"
                }`}
              >
                <input
                  type="radio"
                  name="stash-slot"
                  className="h-4 w-4 accent-violet-500"
                  checked={slot === s}
                  onChange={() => {
                    setSlot(s);
                    setSourcePath(null);
                  }}
                />
                <span>
                  <span className="block text-sm text-neutral-100">{SLOT_META[s].label}</span>
                  <span className="block text-xs text-neutral-500">
                    {SLOT_META[s].fileName} · {SLOT_META[s].hint}
                  </span>
                </span>
              </label>
            ))}
          </div>

          {/* current stash state (preflight) */}
          <div className="rounded-lg border border-neutral-800/80 bg-[#0b0e13] px-3.5 py-3 text-xs">
            <p className="text-neutral-400">当前目标状态：</p>
            {preflightBusy ? (
              <p className="mt-1 text-neutral-600">检测中…</p>
            ) : preflight ? (
              <ul className="mt-1 space-y-0.5 text-neutral-300">
                <li>
                  文件：{preflight.fileName}
                  {preflight.exists ? (
                    <span className="text-neutral-400">
                      {" "}
                      · 存在 · {formatBytes(preflight.size)} · 修改于 {formatTime(preflight.mtime)}
                    </span>
                  ) : (
                    <span className="text-amber-400"> · 尚不存在（首次创建）</span>
                  )}
                </li>
                {gameBlocked && <li className="text-red-400">⚠ D2R.exe 正在运行 — 请先退出游戏再替换</li>}
              </ul>
            ) : (
              <p className="mt-1 text-neutral-600">无法读取（见上方错误）</p>
            )}
          </div>

          <div className="flex items-center gap-3">
            <button className={btnGhost} onClick={() => void pickFile()}>
              选择 .d2i 文件…
            </button>
            {sourcePath && (
              <span className="min-w-0 truncate text-xs text-neutral-400" title={sourcePath}>
                {sourcePath}
              </span>
            )}
          </div>

          <input
            className="w-full rounded-lg border border-neutral-700 bg-[#11141b] px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600"
            placeholder="备注（可选）"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />

          <div className="flex justify-end">
            <button
              className={btnPrimary}
              disabled={!sourcePath || gameBlocked || preflightBusy}
              onClick={() => setStep(2)}
            >
              下一步
            </button>
          </div>
        </section>
      )}

      {step === 2 && (
        <section className="mt-4 space-y-4 rounded-xl border border-neutral-800 bg-[#0d1017] px-5 py-4">
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3.5 text-sm text-red-300">
            <p className="font-semibold">即将覆盖 {meta.label}（{meta.fileName}）</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-red-300/90">
              <li>
                当前仓库{preflight?.exists ? `（${formatBytes(preflight.size)}，${formatTime(preflight.mtime)}）` : ""}
                将被替换，此操作不可撤销替换本身。
              </li>
              <li>替换前会自动备份整个主存档（“仓库替换”快照）——回滚请到存档管家还原该快照。</li>
              <li>请确保游戏已完全退出（否则执行会被拒绝）。</li>
            </ul>
          </div>
          <p className="break-all text-xs text-neutral-400">
            导入文件：{sourcePath}
          </p>
          <label className="flex cursor-pointer items-center gap-2.5 text-sm text-neutral-200">
            <input
              type="checkbox"
              className="h-4 w-4 accent-violet-500"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            我已确认要替换{meta.label}
          </label>
          <div className="flex items-center justify-between">
            <button className={btnGhost} onClick={() => setStep(1)} disabled={busy}>
              ← 上一步
            </button>
            <button className={btnPrimary} disabled={!confirmed || busy} onClick={() => void execute()}>
              {busy ? "替换中…" : "执行替换"}
            </button>
          </div>
        </section>
      )}

      {step === 3 && (
        <section className="mt-4 space-y-4 rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-5 py-6 text-center">
          <p className="text-2xl">✅</p>
          <p className="text-sm text-neutral-200">
            {meta.label} 替换完成。
            {result?.backupId && (
              <span className="mt-1 block text-xs text-neutral-400">
                回滚点快照：{result.backupId}（替换前的完整主存档）
              </span>
            )}
          </p>
          <div className="flex items-center justify-center gap-3">
            <button className={btnGhost} onClick={props.goToSaves}>
              去存档管家查看 →
            </button>
            <button
              className={btnPrimary}
              onClick={() => {
                setStep(1);
                setSourcePath(null);
                setConfirmed(false);
                setResult(null);
                void runPreflight(slot);
              }}
            >
              再替换一个
            </button>
          </div>
        </section>
      )}
        </div>
      </div>
    </div>
  );
}
