/**
 * 大箱子合并/拆分（M11）: pick 1+ item sources (.d2i stashes and/or
 * characters) and 1+ targets (slot overwrite or new file), preview the
 * deterministic layout plan (per-target pages/coordinates/warnings), then
 * apply with a guarded pipeline — game check, auto root snapshot when any
 * target exists, tmp+rename atomic write, readback verification.
 *
 * 红线在页面文案中如实呈现：只搬物品坐标与容器归属，不改物品本体、
 * 不造物品；回滚走存档管家的自动快照。
 */
import { useCallback, useMemo, useState } from "react";
import { invoke, errMsg, useCommand } from "../lib/ipc";
import { formatBytes, formatTime } from "../lib/decode";
import type {
  MergePlannedItemView,
  MergeSourceSpecView,
  MergeTargetPlanView,
  MergeTargetSpecView,
  StashMergeApplyResult,
  StashMergePreviewView,
  StashSlot,
} from "../lib/types";
import { btnGhost } from "../App";

const btnPrimary =
  "rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40";

const QUALITY_COLOR: Record<string, string> = {
  unique: "text-amber-300",
  set: "text-lime-300",
  rare: "text-yellow-300",
  crafted: "text-orange-300",
  magic: "text-sky-300",
  superior: "text-neutral-100",
  normal: "text-neutral-300",
  low: "text-neutral-500",
  unknown: "text-neutral-400",
};

const SLOT_META: Record<StashSlot, { label: string; fileName: string }> = {
  soft: { label: "软核仓库", fileName: "SharedStashSoftCoreV2.d2i" },
  hard: { label: "硬核仓库", fileName: "SharedStashHardCoreV2.d2i" },
};

const SAFE_NAME_RE = /^[\w\-.]{1,64}\.d2i$/i;

/** 目标编辑态（gold 用字符串承接输入，提交时解析）。 */
interface TargetDraft {
  mode: "slot" | "file";
  slot: StashSlot;
  fileName: string;
  pages: number;
  hardcore: boolean;
  gold: string;
}

function newDraft(): TargetDraft {
  return { mode: "file", slot: "soft", fileName: "merged.d2i", pages: 1, hardcore: false, gold: "" };
}

/** 编辑态 → 命令规格；返回 null 表示当前填写不合法（错误文案直接展示）。 */
function toSpec(d: TargetDraft): { spec: MergeTargetSpecView | null; error: string | null } {
  const pages = Math.round(d.pages);
  if (!Number.isInteger(pages) || pages < 1 || pages > 8) {
    return { spec: null, error: "页数须为 1–8（物品坐标字段上限）" };
  }
  const gold = d.gold.trim() === "" ? 0 : Number(d.gold);
  if (!Number.isInteger(gold) || gold < 0) {
    return { spec: null, error: "共享金币须为非负整数" };
  }
  if (d.mode === "slot") {
    return {
      spec: { slot: d.slot, fileName: null, pages, hardcore: d.slot === "hard", sharedGold: gold },
      error: null,
    };
  }
  const name = d.fileName.trim();
  if (!SAFE_NAME_RE.test(name)) {
    return { spec: null, error: "文件名不合法（仅限字母/数字/点/横线/下划线，且以 .d2i 结尾）" };
  }
  return { spec: { slot: null, fileName: name, pages, hardcore: d.hardcore, sharedGold: gold }, error: null };
}

export function StashOpsPage(props: { goToSaves: () => void }) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [selected, setSelected] = useState<Map<string, MergeSourceSpecView>>(new Map());
  const [drafts, setDrafts] = useState<TargetDraft[]>([newDraft()]);
  const [gridW, setGridW] = useState(10);
  const [gridH, setGridH] = useState(10);
  const [note, setNote] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<StashMergePreviewView | null>(null);
  const [result, setResult] = useState<StashMergeApplyResult | null>(null);

  const sources = useCommand("d2r:itemSources", {});

  const draftErrors = useMemo(() => drafts.map(toSpec), [drafts]);
  const specs = useMemo(
    () => draftErrors.map((e) => e.spec).filter((s): s is MergeTargetSpecView => s !== null),
    [draftErrors],
  );
  const draftError = draftErrors.find((e) => e.error)?.error ?? null;
  const canPlan = selected.size > 0 && specs.length === drafts.length && !draftError;

  const toggleSource = useCallback((path: string, kind: "stash" | "character") => {
    const key = `${kind}|${path}`;
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(key)) next.delete(key);
      else next.set(key, { path, kind });
      return next;
    });
  }, []);

  const plan = async () => {
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      const view = await invoke("d2r:stashMergePreview", {
        sources: [...selected.values()],
        targets: specs,
        gridW,
        gridH,
      });
      setPreview(view);
      setStep(2);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const execute = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const r = await invoke("d2r:stashMergeApply", {
        sources: [...selected.values()],
        targets: specs,
        gridW,
        gridH,
        expectCarried: preview.carried,
        note: note.trim() || undefined,
      });
      setResult(r);
      setStep(3);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setStep(1);
    setPreview(null);
    setResult(null);
    setConfirmed(false);
    setError(null);
  };

  return (
    <div className="flex h-full min-w-0 flex-col">
      <header className="shrink-0 px-6 pt-6">
        <div className="mx-auto max-w-2xl">
          <h2 className="text-lg font-semibold">大箱子工具</h2>
          <p className="mt-1 text-xs text-neutral-500">
            把多个仓库/角色身上的物品合并进一个仓库，或把一个仓库拆分到多个文件 · 只搬物品坐标与容器归属，不改物品本体
            · 覆盖已有文件前自动快照，可到存档管家回滚
          </p>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        <div className="mx-auto max-w-2xl">
          <ol className="mt-5 flex items-center gap-2 text-xs">
            {["选择来源与目标", "预览并执行", "完成"].map((label, i) => {
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
              {/* 来源多选 */}
              <div>
                <p className="text-xs font-semibold text-neutral-300">来源（可多选，合并时全部搬入）</p>
                {sources.loading && <p className="mt-2 text-xs text-neutral-600">扫描中…</p>}
                {sources.error && <p className="mt-2 text-xs text-amber-400">来源扫描失败：{sources.error}</p>}
                {sources.data &&
                  (sources.data.groups.length === 0 ? (
                    <p className="mt-2 text-xs text-neutral-500">没有可用来源（请先到设置配置游戏目录）</p>
                  ) : (
                    <div className="mt-2 space-y-3">
                      {sources.data.groups.map((g) => (
                        <div key={g.path} className="rounded-lg border border-neutral-800/80 bg-[#0b0e13] px-3.5 py-2.5">
                          <p className="text-xs text-neutral-400">{g.name}</p>
                          <ul className="mt-1 divide-y divide-neutral-800/60">
                            {g.stashes.map((s) => (
                              <SourceRow
                                key={`s|${s.path}`}
                                label={s.name}
                                badge="仓库"
                                size={s.size}
                                mtime={s.mtime}
                                checked={selected.has(`stash|${s.path}`)}
                                onToggle={() => toggleSource(s.path, "stash")}
                              />
                            ))}
                            {g.characters.map((c) => (
                              <SourceRow
                                key={`c|${c.path}`}
                                label={c.name}
                                badge="角色"
                                size={c.size}
                                mtime={c.mtime}
                                checked={selected.has(`character|${c.path}`)}
                                onToggle={() => toggleSource(c.path, "character")}
                              />
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  ))}
                {selected.size > 0 && (
                  <p className="mt-1.5 text-xs text-neutral-500">已选 {selected.size} 个来源；角色身上的物品会被搬入仓库页</p>
                )}
              </div>

              {/* 目标列表 */}
              <div>
                <p className="text-xs font-semibold text-neutral-300">目标（合并→1 个；拆分→多个）</p>
                <div className="mt-2 space-y-2">
                  {drafts.map((d, i) => (
                    <TargetCard
                      key={i}
                      index={i}
                      draft={d}
                      error={draftErrors[i]?.error ?? null}
                      canRemove={drafts.length > 1}
                      onChange={(patch) =>
                        setDrafts((prev) => prev.map((p, j) => (j === i ? { ...p, ...patch } : p)))
                      }
                      onRemove={() => setDrafts((prev) => prev.filter((_, j) => j !== i))}
                    />
                  ))}
                </div>
                {drafts.length < 8 && (
                  <button className={btnGhost + " mt-2"} onClick={() => setDrafts((prev) => [...prev, newDraft()])}>
                    + 添加目标
                  </button>
                )}
              </div>

              {/* 高级：网格（mod 大格子仓库用） */}
              <details className="rounded-lg border border-neutral-800/80 bg-[#0b0e13] px-3.5 py-2.5 text-xs">
                <summary className="cursor-pointer select-none text-neutral-400">高级：页面网格（默认 10×10，mod 大格子仓库可调）</summary>
                <div className="mt-2 flex items-center gap-2">
                  <NumberInput value={gridW} min={1} max={15} onChange={setGridW} /> ×{" "}
                  <NumberInput value={gridH} min={1} max={15} onChange={setGridH} />
                  <span className="text-neutral-500">格（各 1–15，坐标字段 4bit 上限）</span>
                </div>
              </details>

              <input
                className="w-full rounded-lg border border-neutral-700 bg-[#11141b] px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600"
                placeholder="备注（可选，记入自动快照）"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />

              {draftError && <p className="text-xs text-amber-400">{draftError}</p>}
              <div className="flex justify-end">
                <button className={btnPrimary} disabled={!canPlan || busy} onClick={() => void plan()}>
                  {busy ? "规划中…" : "生成预览"}
                </button>
              </div>
            </section>
          )}

          {step === 2 && preview && (
            <section className="mt-4 space-y-4 rounded-xl border border-neutral-800 bg-[#0d1017] px-5 py-4">
              <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                <span className="rounded-full border border-neutral-700 px-2 py-0.5 text-neutral-200">
                  来源共 {preview.carried} 件
                </span>
                <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-emerald-300">
                  放置 {preview.placed} 件
                </span>
                {preview.unknownSize > 0 && (
                  <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-amber-300">
                    {preview.unknownSize} 件尺寸未知（按 1×1）
                  </span>
                )}
              </div>

              {preview.warnings.map((w, i) => (
                <div key={i} className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs leading-relaxed text-amber-300">
                  {w}
                </div>
              ))}

              {preview.targets.map((t) => (
                <TargetPlan key={t.path} target={t} />
              ))}

              <p className="text-xs text-neutral-500">
                执行前会检测 D2R 进程；{preview.targets.some((t) => t.exists) ? "目标已存在，将先自动快照整个主存档；" : ""}
                写入后逐件回读校验，数量不符即拒绝落盘。
              </p>
              <label className="flex cursor-pointer items-center gap-2.5 text-sm text-neutral-200">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-violet-500"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                我已确认布局预览无误
              </label>
              <div className="flex items-center justify-between">
                <button className={btnGhost} onClick={reset} disabled={busy}>
                  ← 返回调整
                </button>
                <button className={btnPrimary} disabled={!confirmed || busy} onClick={() => void execute()}>
                  {busy ? "写入中…" : "执行写入"}
                </button>
              </div>
            </section>
          )}

          {step === 3 && result && (
            <section className="mt-4 space-y-4 rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-5 py-6">
              <p className="text-center text-2xl">✅</p>
              <p className="text-center text-sm text-neutral-200">
                写入完成，{result.targets.length} 个目标已通过回读校验。
              </p>
              {result.backupId && (
                <p className="text-center text-xs text-neutral-400">
                  回滚点快照：{result.backupId}（覆盖前的完整主存档）
                </p>
              )}
              <ul className="mx-auto max-w-md divide-y divide-neutral-800/60 text-xs text-neutral-300">
                {result.targets.map((t) => (
                  <li key={t.path} className="flex items-center justify-between gap-3 py-1.5">
                    <span className="min-w-0 truncate" title={t.path}>
                      {t.path.split(/[\\/]/).pop()}
                    </span>
                    <span className="shrink-0 text-neutral-500">
                      {t.items} 件 · v{t.version} · {formatBytes(t.bytes)}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="flex items-center justify-center gap-3">
                {result.backupId && <button className={btnGhost} onClick={props.goToSaves}>去存档管家查看 →</button>}
                <button className={btnPrimary} onClick={reset}>再来一次</button>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

/** 来源行（仓库/角色通用）。 */
function SourceRow(props: {
  label: string;
  badge: string;
  size: number;
  mtime: number;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <li>
      <label className="flex cursor-pointer items-center gap-2.5 py-1.5">
        <input
          type="checkbox"
          className="h-4 w-4 accent-violet-500"
          checked={props.checked}
          onChange={props.onToggle}
        />
        <span
          className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] ${
            props.badge === "仓库" ? "border-sky-500/40 text-sky-300" : "border-violet-500/40 text-violet-300"
          }`}
        >
          {props.badge}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-neutral-200" title={props.label}>
          {props.label}
        </span>
        <span className="shrink-0 text-[10px] text-neutral-600">
          {formatBytes(props.size)} · {formatTime(props.mtime)}
        </span>
      </label>
    </li>
  );
}

/** 单个目标编辑卡片。 */
function TargetCard(props: {
  index: number;
  draft: TargetDraft;
  error: string | null;
  canRemove: boolean;
  onChange: (patch: Partial<TargetDraft>) => void;
  onRemove: () => void;
}) {
  const { draft: d, index } = props;
  return (
    <div className="rounded-lg border border-neutral-800/80 bg-[#0b0e13] px-3.5 py-2.5">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-neutral-300">目标 {index + 1}</p>
        {props.canRemove && (
          <button className="text-xs text-neutral-600 transition-colors hover:text-red-400" onClick={props.onRemove}>
            移除
          </button>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
        <label className="flex cursor-pointer items-center gap-1.5">
          <input
            type="radio"
            className="h-3.5 w-3.5 accent-violet-500"
            checked={d.mode === "file"}
            onChange={() => props.onChange({ mode: "file" })}
          />
          新文件
        </label>
        <label className="flex cursor-pointer items-center gap-1.5">
          <input
            type="radio"
            className="h-3.5 w-3.5 accent-violet-500"
            checked={d.mode === "slot"}
            onChange={() => props.onChange({ mode: "slot" })}
          />
          覆盖槽位
        </label>
      </div>
      {d.mode === "file" ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <input
            className="w-48 rounded-lg border border-neutral-700 bg-[#11141b] px-2.5 py-1.5 text-xs text-neutral-100"
            value={d.fileName}
            onChange={(e) => props.onChange({ fileName: e.target.value })}
            placeholder="merged.d2i"
          />
          <label className="flex items-center gap-1 text-neutral-400">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-violet-500"
              checked={d.hardcore}
              onChange={(e) => props.onChange({ hardcore: e.target.checked })}
            />
            硬核（HC）
          </label>
        </div>
      ) : (
        <div className="mt-2 flex items-center gap-2 text-xs">
          {(["soft", "hard"] as const).map((s) => (
            <label
              key={s}
              className={`flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 ${
                d.slot === s ? "border-violet-500/60 bg-violet-500/10 text-violet-200" : "border-neutral-800 text-neutral-400"
              }`}
            >
              <input
                type="radio"
                name={`slot-${index}`}
                className="h-3.5 w-3.5 accent-violet-500"
                checked={d.slot === s}
                onChange={() => props.onChange({ slot: s })}
              />
              {SLOT_META[s].label}
            </label>
          ))}
          <span className="text-neutral-600">{SLOT_META[d.slot].fileName}</span>
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-neutral-400">
        <label className="flex items-center gap-1.5">
          页数
          <NumberInput value={d.pages} min={1} max={8} onChange={(v) => props.onChange({ pages: v })} />
        </label>
        <label className="flex items-center gap-1.5">
          共享金币
          <input
            className="w-28 rounded-lg border border-neutral-700 bg-[#11141b] px-2.5 py-1.5 text-xs text-neutral-100 placeholder:text-neutral-600"
            value={d.gold}
            onChange={(e) => props.onChange({ gold: e.target.value })}
            placeholder="0"
          />
        </label>
      </div>
      {props.error && <p className="mt-1.5 text-xs text-amber-400">{props.error}</p>}
    </div>
  );
}

/** 单个目标的布局预览卡片。 */
function TargetPlan(props: { target: MergeTargetPlanView }) {
  const t = props.target;
  const [expanded, setExpanded] = useState(false);
  const items = expanded ? t.items : t.items.slice(0, 30);
  const pagesUsed = new Set(t.items.map((i) => i.page)).size;
  return (
    <div className="rounded-lg border border-neutral-800 bg-[#0b0e13] px-4 py-3">
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="text-xs font-semibold text-neutral-200">{t.label}</span>
        {t.exists && (
          <span className="rounded-full border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-red-300">已存在，将被覆盖</span>
        )}
        <span className="rounded-full border border-neutral-700 px-2 py-0.5 text-neutral-400">
          {t.hardcore ? "硬核" : "软核"} · v{t.version} · 用到 {pagesUsed} 页 · 金币 {t.sharedGold.toLocaleString()}
        </span>
        <span className="rounded-full border border-neutral-700 px-2 py-0.5 text-neutral-300">{t.items.length} 件</span>
      </div>
      {t.items.length > 0 ? (
        <ul className="mt-2 divide-y divide-neutral-800/60 text-xs">
          {items.map((it, i) => (
            <PlannedRow key={i} item={it} />
          ))}
        </ul>
      ) : (
        <p className="mt-1.5 text-xs text-neutral-600">没有分配到该目标（来源太少或其它目标优先）</p>
      )}
      {t.items.length > 30 && (
        <button className={btnGhost + " mt-2"} onClick={() => setExpanded((v) => !v)}>
          {expanded ? "收起" : `展开全部 ${t.items.length} 件`}
        </button>
      )}
    </div>
  );
}

function PlannedRow(props: { item: MergePlannedItemView }) {
  const it = props.item;
  return (
    <li className="flex items-center gap-2 py-1">
      <span className="w-24 shrink-0 text-right text-neutral-600">
        第 {it.page + 1} 页 ({it.x},{it.y})
      </span>
      <span className={`min-w-0 flex-1 truncate ${QUALITY_COLOR[it.quality] ?? "text-neutral-300"}`} title={it.name}>
        {it.name}
        {it.ethereal && <span className="ml-1 text-neutral-500">（无形）</span>}
        {it.sockets != null && <span className="ml-1 text-neutral-500">{it.sockets}孔</span>}
      </span>
      {it.qty != null && <span className="shrink-0 text-neutral-500">×{it.qty}</span>}
      <span className="w-8 shrink-0 text-[10px] text-neutral-500">{it.w}×{it.h}</span>
      <span className="w-28 shrink-0 truncate text-right text-[10px] text-neutral-600" title={it.from}>
        ← {it.from}
      </span>
    </li>
  );
}

function NumberInput(props: { value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <input
      type="number"
      min={props.min}
      max={props.max}
      className="w-16 rounded-lg border border-neutral-700 bg-[#11141b] px-2.5 py-1.5 text-xs text-neutral-100"
      value={props.value}
      onChange={(e) => {
        const v = Number(e.target.value);
        if (Number.isFinite(v)) props.onChange(Math.round(v));
      }}
    />
  );
}
