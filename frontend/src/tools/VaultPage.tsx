/**
 * 大仓库向导（M2）+ 替换影响预览与 HC/SC 一致性检测（M10）: three-step
 * SharedStash .d2i replace with guards — preflight (current file + game
 * check + SC/HC 一致性) → red warning + **将被清空的物品清单 + 搬家建议 +
 * 导入文件页数预览** → atomic replace with an automatic pre-replace root
 * snapshot as the rollback point.
 *
 * 解析分工：物品明细走 d2r:itemView（完整解析，mod 自定义物品可能失败）；
 * 失败时用 d2r:stashHeader 只读头部兜底（页数/HC 标志不依赖物品段）。
 */
import { useCallback, useEffect, useState } from "react";
import { invoke, errMsg } from "../lib/ipc";
import { formatBytes, formatTime } from "../lib/decode";
import type {
  ItemViewResult,
  StashConsistencyView,
  StashHeaderView,
  StashPreflightView,
  StashSlot,
} from "../lib/types";
import { btnGhost } from "../App";

const btnPrimary =
  "rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40";

const SLOT_META: Record<StashSlot, { label: string; fileName: string; hint: string }> = {
  soft: { label: "软核仓库", fileName: "SharedStashSoftCoreV2.d2i", hint: "普通/扩展角色的共享仓库" },
  hard: { label: "硬核仓库", fileName: "SharedStashHardCoreV2.d2i", hint: "专家模式角色的共享仓库" },
};

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

const CATEGORY_LABEL: Record<string, string> = {
  rune: "符文",
  gem: "宝石",
  jewel: "珠宝",
  weapon: "武器",
  armor: "护甲",
  other: "其他",
};
const CATEGORY_ORDER = ["rune", "gem", "jewel", "weapon", "armor", "other"] as const;

type StashView = Extract<ItemViewResult, { kind: "stash" }>;
type ItemDto = StashView["pages"][number]["items"][number];

/** 一份 .d2i 的解析结果视图（物品明细失败时降级为头部速览）。 */
type StashParse =
  | { kind: "loading" }
  | { kind: "none" }
  | { kind: "stash"; view: Extract<ItemViewResult, { kind: "stash" }> }
  | { kind: "header-fallback"; header: StashHeaderView; message: string }
  | { kind: "error"; message: string };

function stashOf(parse: StashParse): Extract<ItemViewResult, { kind: "stash" }> | null {
  return parse.kind === "stash" ? parse.view : null;
}

function countByCategory(items: ItemDto[]): { key: string; n: number }[] {
  const by = new Map<string, number>();
  for (const it of items) by.set(it.category, (by.get(it.category) ?? 0) + 1);
  return CATEGORY_ORDER.filter((k) => by.has(k)).map((key) => ({ key, n: by.get(key)! }));
}

/**
 * 一次解析尝试：完整解析（物品明细）→ 失败则头部速览兜底（页数/HC 标志
 * 不依赖物品段）。所有失败都以可展示的 StashParse 落地，不抛出。
 */
async function resolveStash(path: string): Promise<StashParse> {
  try {
    const view = await invoke("d2r:itemView", { path });
    if (view.kind === "stash") return { kind: "stash", view };
    return await headerFallback(path, viewMessage(view));
  } catch {
    return await headerFallback(path, "物品明细无法解析");
  }
}

async function headerFallback(path: string, message: string): Promise<StashParse> {
  try {
    const header = await invoke("d2r:stashHeader", { path });
    if (header) return { kind: "header-fallback", header, message };
  } catch {
    /* fall through to error */
  }
  return { kind: "error", message };
}

/** 第 2 步的替换影响面板：并行解析"当前仓库"（将被清空的物品）与"导入
 * 文件"（页数/物品预览），失败逐个降级，不阻断替换流程。 */
function ReplaceImpact(props: { slot: StashSlot; currentPath: string | null; sourcePath: string }) {
  const { slot, currentPath, sourcePath } = props;
  const [current, setCurrent] = useState<StashParse>(currentPath ? { kind: "loading" } : { kind: "none" });
  const [incoming, setIncoming] = useState<StashParse>({ kind: "loading" });

  useEffect(() => {
    let alive = true;
    if (currentPath) {
      void resolveStash(currentPath).then((p) => alive && setCurrent(p));
    }
    void resolveStash(sourcePath).then((p) => alive && setIncoming(p));
    return () => {
      alive = false;
    };
  }, [currentPath, sourcePath]);

  const cur = stashOf(current);
  const inc = stashOf(incoming);
  const curItems = cur ? cur.pages.flatMap((p) => p.items) : [];
  const incItems = inc ? inc.pages.flatMap((p) => p.items) : [];
  const incHeader = incoming.kind === "header-fallback" ? incoming.header : null;
  const overflowPages = (n: number | null | undefined) => n != null && n > 8;

  const advice: { level: "warn" | "info"; text: string }[] = [];
  if (cur && curItems.length > 0) {
    advice.push({
      level: "warn",
      text: `当前仓库有 ${curItems.length} 件物品（${cur.pageCount} 页），替换后将随旧文件一起不可见。想保留：① 游戏内先把物品搬到角色背包/赫拉迪姆方块；② 或替换后到存档管家用自动快照回滚找回。`,
    });
  }
  if (cur && inc && inc.pageCount < cur.pageCount) {
    advice.push({
      level: "warn",
      text: `导入仓库只有 ${inc.pageCount} 页，少于当前的 ${cur.pageCount} 页——容量变小时请确认放得下你计划转移回来的物品。`,
    });
  }
  if (incHeader && overflowPages(incHeader.pageCount)) {
    advice.push({
      level: "warn",
      text: `导入仓库 ${incHeader.pageCount} 页，超过物品坐标字段的 8 页上限——第 9 页及以后的物品在游戏内可能无法正常显示/交互（mod 网格若支持更多页则不受影响）。`,
    });
  }
  if (incoming.kind === "error") {
    advice.push({
      level: "info",
      text: `导入文件的物品明细无法解析（${incoming.message}）。不阻断替换：mod 自定义物品位宽时本工具读不出明细，游戏通常仍能正常读取；替换前会自动快照，可回滚。`,
    });
  }
  if (advice.length === 0 && curItems.length === 0) {
    advice.push({
      level: "info",
      text: "当前仓库为空或尚不存在——没有会被清掉的物品，可直接替换。",
    });
  }

  return (
    <div className="space-y-3">
      {/* 将被清空的物品 */}
      <div className="rounded-lg border border-neutral-800 bg-[#0b0e13] px-4 py-3">
        <p className="text-xs font-semibold text-neutral-300">将被清空的物品（当前{SLOT_META[slot].label}）</p>
        {current.kind === "loading" && <p className="mt-1.5 text-xs text-neutral-600">解析中…</p>}
        {current.kind === "none" && (
          <p className="mt-1.5 text-xs text-neutral-500">当前仓库尚不存在（首次创建），没有会被清掉的物品。</p>
        )}
        {current.kind === "error" && (
          <p className="mt-1.5 text-xs text-amber-400">当前仓库读取失败：{current.message}（替换前仍会自动快照，可回滚）</p>
        )}
        {current.kind === "header-fallback" && (
          <p className="mt-1.5 text-xs text-amber-400">物品明细无法解析（{current.message}）——页数信息见下方导入预览与第 1 步一致性检测；替换前仍会自动快照。</p>
        )}
        {cur && (
          <div className="mt-2">
            <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
              <span className="rounded-full border border-neutral-700 px-2 py-0.5 text-neutral-300">
                共 {curItems.length} 件
              </span>
              <span className="rounded-full border border-neutral-700 px-2 py-0.5 text-neutral-400">
                {cur.pageCount} 页 · 金币 {cur.sharedGold.toLocaleString()}
              </span>
              {countByCategory(curItems).map((c) => (
                <span key={c.key} className="rounded-full border border-neutral-800 px-2 py-0.5 text-neutral-400">
                  {CATEGORY_LABEL[c.key] ?? c.key} ×{c.n}
                </span>
              ))}
            </div>
            {curItems.length > 0 && <ItemList items={curItems} />}
          </div>
        )}
      </div>

      {/* 搬家建议 */}
      {advice.map((a, i) => (
        <div
          key={i}
          className={`rounded-lg border px-4 py-2.5 text-xs leading-relaxed ${
            a.level === "warn"
              ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
              : "border-neutral-800 bg-[#0b0e13] text-neutral-400"
          }`}
        >
          {a.text}
        </div>
      ))}

      {/* 导入文件预览 */}
      <div className="rounded-lg border border-neutral-800 bg-[#0b0e13] px-4 py-3">
        <p className="text-xs font-semibold text-neutral-300">导入文件预览</p>
        {incoming.kind === "loading" && <p className="mt-1.5 text-xs text-neutral-600">解析中…</p>}
        {incoming.kind === "error" && (
          <p className="mt-1.5 text-xs text-amber-400">无法解析物品明细：{incoming.message}</p>
        )}
        {incoming.kind === "header-fallback" && incHeader && (
          <p className="mt-1.5 text-xs text-neutral-400">
            物品明细读不出（{incoming.message}），但头部有效：
            {incHeader.pageCount != null ? `${incHeader.pageCount} 页` : "页数未知"} ·{" "}
            {incHeader.hardcore ? "硬核" : "软核"}仓库 · 金币 {incHeader.sharedGold.toLocaleString()}
            {overflowPages(incHeader.pageCount) && (
              <span className="text-amber-400"> · 超过 8 页坐标上限</span>
            )}
          </p>
        )}
        {inc && (
          <div className="mt-2">
            <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
              <span className="rounded-full border border-neutral-700 px-2 py-0.5 text-neutral-300">
                共 {incItems.length} 件
              </span>
              <span className="rounded-full border border-neutral-700 px-2 py-0.5 text-neutral-400">
                {inc.pageCount} 页 · {inc.hardcore ? "硬核" : "软核"} · 金币 {inc.sharedGold.toLocaleString()}
              </span>
              {overflowPages(inc.pageCount) && (
                <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-amber-300">
                  超过 8 页坐标上限
                </span>
              )}
              {inc.hardcore !== (slot === "hard") && (
                <span className="rounded-full border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-red-300">
                  内容标记为{inc.hardcore ? "硬核" : "软核"}仓库，与目标槽位不符
                </span>
              )}
              {countByCategory(incItems).map((c) => (
                <span key={c.key} className="rounded-full border border-neutral-800 px-2 py-0.5 text-neutral-400">
                  {CATEGORY_LABEL[c.key] ?? c.key} ×{c.n}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function viewMessage(view: ItemViewResult): string {
  return view.kind === "error" ? view.message : view.kind === "character-partial" ? view.message : "不是仓库文件";
}

const ITEM_PREVIEW = 30;

function ItemList(props: { items: ItemDto[] }) {
  const [expanded, setExpanded] = useState(false);
  const items = expanded ? props.items : props.items.slice(0, ITEM_PREVIEW);
  return (
    <div className="mt-2">
      <ul className="divide-y divide-neutral-800/60 text-xs">
        {items.map((it, i) => (
          <li key={i} className="flex items-center gap-2 py-1">
            <span className="w-12 shrink-0 text-right text-neutral-600">第 {it.page + 1} 页</span>
            <span className={`min-w-0 flex-1 truncate ${QUALITY_COLOR[it.quality] ?? "text-neutral-300"}`} title={it.name}>
              {it.name}
              {it.ethereal && <span className="ml-1 text-neutral-500">（无形）</span>}
              {it.sockets != null && <span className="ml-1 text-neutral-500">{it.sockets}孔</span>}
            </span>
            {it.qty != null && <span className="shrink-0 text-neutral-500">×{it.qty}</span>}
          </li>
        ))}
      </ul>
      {props.items.length > ITEM_PREVIEW && (
        <button className={btnGhost + " mt-2"} onClick={() => setExpanded((v) => !v)}>
          {expanded ? "收起" : `展开全部 ${props.items.length} 件`}
        </button>
      )}
    </div>
  );
}

export function VaultPage(props: { goToSaves: () => void }) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [slot, setSlot] = useState<StashSlot>("soft");
  const [preflight, setPreflight] = useState<StashPreflightView | null>(null);
  const [preflightBusy, setPreflightBusy] = useState(false);
  const [consistency, setConsistency] = useState<StashConsistencyView | null>(null);
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

  const runConsistency = useCallback(async () => {
    try {
      setConsistency(await invoke("d2r:stashConsistency", {}));
    } catch {
      setConsistency(null); // 一致性检测失败不阻断向导
    }
  }, []);

  useEffect(() => {
    void runPreflight(slot);
  }, [slot, runPreflight]);

  useEffect(() => {
    void runConsistency();
  }, [runConsistency]);

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
            用整合包作者的 .d2i 仓库文件替换当前共享仓库 · 替换前自动备份当前主存档，可回滚 · 替换前可预览将被清空的物品
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
                    {consistency?.[s]?.exists && consistency[s]?.header?.pageCount != null && (
                      <span className="text-neutral-400"> · 当前 {consistency[s]!.header!.pageCount} 页</span>
                    )}
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

          {/* M10: HC/SC 一致性检测 */}
          {consistency && consistency.warnings.length > 0 && (
            <div className="rounded-lg border border-neutral-800/80 bg-[#0b0e13] px-3.5 py-3 text-xs">
              <p className="text-neutral-400">HC/SC 一致性检测：</p>
              <ul className="mt-1 space-y-1">
                {consistency.warnings.map((w, i) => (
                  <li
                    key={i}
                    className={
                      w.level === "error" ? "text-red-400" : w.level === "warn" ? "text-amber-400" : "text-neutral-400"
                    }
                  >
                    {w.level === "error" ? "✕ " : w.level === "warn" ? "⚠ " : "· "}
                    {w.text}
                  </li>
                ))}
              </ul>
            </div>
          )}

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

      {step === 2 && sourcePath && (
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

          <ReplaceImpact
            slot={slot}
            currentPath={preflight?.exists ? preflight.path : null}
            sourcePath={sourcePath}
          />

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
                void runConsistency();
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
