/**
 * 物品清单（M7）：只读浏览各 savepath 的共享仓库（.d2i）与角色（.d2s）。
 * 左栏为来源树（主存档 + 各 mod 存档组，与存档管家同一 slot 模型），
 * 点文件走 d2r:itemView 解析；右栏按页/部位分页，支持分类筛选与
 * 名称/物品代码搜索。解析失败（版本不支持/文件损坏）就地显示错误。
 */
import { useMemo, useState } from "react";
import { invoke, useCommand, errMsg } from "../../lib/ipc";
import { formatBytes, formatTime } from "../../lib/decode";
import type {
  CharacterFileInfoView,
  ItemDtoView,
  ItemSourceGroupView,
  ItemViewResult,
  StashFileInfoView,
} from "../../lib/types";
import { btnGhost } from "../../App";

const btnPrimary =
  "rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40";

// ---------------------------------------------------------------------------
// 常量映射
// ---------------------------------------------------------------------------

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

const WHERE_LABEL: Record<string, string> = {
  equipped: "装备中",
  inventory: "背包",
  stash: "随身仓库",
  cube: "赫拉迪姆方块",
  merc: "佣兵",
  corpse: "尸体",
  other: "其他",
};

const STASH_KIND_LABEL: Record<string, string> = {
  "shared-soft": "共享仓库（SC）",
  "shared-hard": "共享仓库（HC）",
  other: "其他仓库",
};

function groupLabel(g: ItemSourceGroupView): string {
  return g.slot === "root" ? "主存档" : g.name;
}

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

interface SelectedFile {
  path: string;
  /** 文件名（列表展示用） */
  name: string;
  /** 预判类型：决定文案与图标；实际以解析结果为准 */
  expect: "stash" | "char";
}

export function ItemPage() {
  const sources = useCommand("d2r:itemSources", {});
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set(["root"]));
  const [file, setFile] = useState<SelectedFile | null>(null);
  const [parsed, setParsed] = useState<ItemViewResult | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const groups = sources.data?.groups ?? [];
  const currentGroup = groups.find((g) => file && g.stashes.some((s) => s.path === file.path))
    ?? groups.find((g) => file && g.characters.some((c) => c.path === file.path));

  const toggleGroup = (slot: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(slot)) next.delete(slot);
      else next.add(slot);
      return next;
    });
  };

  const openFile = async (f: SelectedFile) => {
    setFile(f);
    setParsed(null);
    setLoadErr(null);
    setLoading(true);
    try {
      const r = await invoke("d2r:itemView" as const, { path: f.path });
      setParsed(r);
    } catch (err) {
      setLoadErr(errMsg(err));
    } finally {
      setLoading(false);
    }
  };

  const totalFiles = groups.reduce((n, g) => n + g.stashes.length + g.characters.length, 0);

  return (
    /* 页面自身填满可视区：页头固定，下方左右两栏各自内滚，外壳不整体滚动 */
    <div className="flex h-full min-w-0 flex-col gap-5 p-6">
      <header className="flex shrink-0 items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">物品清单</h2>
          <p className="mt-1 text-xs text-neutral-500">
            只读浏览共享仓库与角色物品 · 按分类筛选、按名称搜索（不会写入任何存档文件）
          </p>
        </div>
        <button className={btnGhost} onClick={sources.refresh}>
          刷新
        </button>
      </header>

      {sources.error && (
        <div className="shrink-0 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-sm text-red-300">
          {sources.error}
        </div>
      )}

      {sources.data && totalFiles === 0 && (
        <div className="shrink-0 rounded-xl border border-dashed border-neutral-800 px-5 py-8 text-center text-sm text-neutral-500">
          各存档目录下没有可解析的 .d2i / .d2s 文件。先启动一次游戏或 Mod 生成存档。
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-5 lg:grid-cols-[17rem_1fr]">
        {/* 来源树：左栏独立滚动 */}
        <aside className="min-h-0 space-y-2.5 overflow-y-auto pr-1 lg:pr-2">
          {groups.map((g) => {
            const open = openGroups.has(g.slot) || (file !== null && currentGroup?.slot === g.slot);
            return (
              <div key={g.slot} className="rounded-xl border border-neutral-800 bg-[#0d1017]">
                <button
                  className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left"
                  onClick={() => toggleGroup(g.slot)}
                >
                  <span className={`text-[10px] text-neutral-500 transition-transform ${open ? "rotate-90" : ""}`}>▶</span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-neutral-100">
                    {groupLabel(g)}
                  </span>
                  <span className="shrink-0 text-[11px] text-neutral-500">
                    {g.exists ? `${g.stashes.length + g.characters.length}` : "—"}
                  </span>
                </button>
                {open && (
                  <div className="space-y-0.5 border-t border-neutral-800/70 px-2 py-2">
                    {!g.exists && (
                      <p className="px-2 py-1 text-xs text-neutral-600">存档目录尚未创建</p>
                    )}
                    {g.exists && g.stashes.length === 0 && g.characters.length === 0 && (
                      <p className="px-2 py-1 text-xs text-neutral-600">没有仓库/角色文件</p>
                    )}
                    {g.stashes.map((s) => (
                      <FileButton
                        key={s.path}
                        active={file?.path === s.path}
                        icon="▣"
                        label={s.name}
                        sub={`${STASH_KIND_LABEL[s.kind] ?? s.kind} · ${formatBytes(s.size)}`}
                        onClick={() => void openFile({ path: s.path, name: s.name, expect: "stash" })}
                      />
                    ))}
                    {g.characters.map((c) => (
                      <FileButton
                        key={c.path}
                        active={file?.path === c.path}
                        icon="⚔"
                        label={c.name}
                        sub={`${formatBytes(c.size)} · ${formatTime(c.mtime)}`}
                        onClick={() => void openFile({ path: c.path, name: c.name, expect: "char" })}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </aside>

        {/* 查看器：右栏内滚，标题/信息条固定在顶部 */}
        <section className="flex min-h-0 min-w-0 flex-col">
          {!file && (
            <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-neutral-800 px-5 py-10 text-center text-sm text-neutral-500">
              从左侧选择一个仓库或角色文件开始浏览。
            </div>
          )}
          {file && loading && (
            <div className="flex flex-1 animate-pulse items-center justify-center rounded-xl border border-neutral-800 px-5 py-10 text-center text-sm text-neutral-500">
              解析 {file.name} …
            </div>
          )}
          {file && !loading && loadErr && (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-5 py-4 text-sm text-red-300">
                {loadErr}
              </div>
            </div>
          )}
          {file && !loading && parsed && <Viewer file={file} parsed={parsed} />}
        </section>
      </div>
    </div>
  );
}

function FileButton(props: { active: boolean; icon: string; label: string; sub: string; onClick: () => void }) {
  return (
    <button
      className={`w-full rounded-lg px-2.5 py-1.5 text-left transition-colors ${
        props.active ? "bg-violet-500/15" : "hover:bg-neutral-800/60"
      }`}
      onClick={props.onClick}
    >
      <span
        className={`block truncate text-[13px] ${props.active ? "text-violet-300" : "text-neutral-200"}`}
        title={props.label}
      >
        <span className="mr-1.5 text-neutral-500">{props.icon}</span>
        {props.label}
      </span>
      <span className="block truncate text-[11px] text-neutral-500" title={props.sub}>
        {props.sub}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// 查看器：stash 按页、char 按部位，共用筛选/表格
// ---------------------------------------------------------------------------

function Viewer(props: { file: SelectedFile; parsed: ItemViewResult }) {
  const { parsed } = props;

  if (parsed.kind === "error") {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-5 py-4 text-sm text-amber-300">
          解析失败：{parsed.message}
          <p className="mt-1 text-xs text-amber-500/80">
            可能是未知存档版本、mod 自定义属性位宽或文件损坏；文件未被改动。
          </p>
        </div>
      </div>
    );
  }

  if (parsed.kind === "character-partial") {
    return (
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-xl border border-neutral-800 bg-[#0d1017] px-4 py-3 text-sm">
          <span className="font-medium text-neutral-100">{parsed.name || props.file.name}</span>
          {parsed.className && <span className="text-xs text-neutral-400">职业 {parsed.className}</span>}
          {parsed.level !== null && <span className="text-xs text-neutral-400">等级 {parsed.level}</span>}
          <span className={`rounded-full px-2 py-0.5 text-xs ${parsed.hardcore ? "bg-rose-500/15 text-rose-300" : "bg-sky-500/15 text-sky-300"}`}>
            {parsed.hardcore ? "专家模式" : "普通模式"}
          </span>
        </div>
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-5 py-4 text-sm text-amber-300">
          {parsed.message}
        </div>
      </div>
    );
  }

  // 统一成 {key, label, items} 分页结构
  const tabs =
    parsed.kind === "stash"
      ? parsed.pages.map((p) => ({
          key: `p${p.index}`,
          label: p.name,
          items: p.items,
        }))
      : parsed.groups.map((g) => ({
          key: g.where,
          label: WHERE_LABEL[g.where] ?? g.where,
          items: g.items,
        }));

  const allItems = tabs.flatMap((t) => t.items);

  return (
    /* 信息条固定，ItemBrowser（tabs/筛选/表格）占满剩余高度内部滚动 */
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {parsed.kind === "stash" ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-xl border border-neutral-800 bg-[#0d1017] px-4 py-3 text-sm">
          <span className="font-medium text-neutral-100">{props.file.name}</span>
          <span className={`rounded-full px-2 py-0.5 text-xs ${parsed.hardcore ? "bg-rose-500/15 text-rose-300" : "bg-sky-500/15 text-sky-300"}`}>
            {parsed.hardcore ? "专家模式" : "普通模式"}
          </span>
          <span className="text-xs text-neutral-400">版本 {parsed.version}</span>
          <span className="text-xs text-neutral-400">共享金币 {parsed.sharedGold.toLocaleString()}</span>
          <span className="text-xs text-neutral-400">
            {parsed.pageCount} 页 · {allItems.length} 件物品
          </span>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-xl border border-neutral-800 bg-[#0d1017] px-4 py-3 text-sm">
          <span className="font-medium text-neutral-100">{parsed.name || props.file.name}</span>
          {parsed.className && <span className="text-xs text-neutral-400">职业 {parsed.className}</span>}
          {parsed.level !== null && <span className="text-xs text-neutral-400">等级 {parsed.level}</span>}
          <span className={`rounded-full px-2 py-0.5 text-xs ${parsed.hardcore ? "bg-rose-500/15 text-rose-300" : "bg-sky-500/15 text-sky-300"}`}>
            {parsed.hardcore ? "专家模式" : "普通模式"}
          </span>
          <span className="text-xs text-neutral-400">
            {tabs.length} 个部位 · {allItems.length} 件物品
          </span>
        </div>
      )}

      <ItemBrowser tabs={tabs} />
    </div>
  );
}

function ItemBrowser(props: { tabs: { key: string; label: string; items: ItemDtoView[] }[] }) {
  const { tabs } = props;
  const [tabKey, setTabKey] = useState("all");
  const [category, setCategory] = useState<string>("all");
  const [query, setQuery] = useState("");

  const tab = tabs.find((t) => t.key === tabKey) ?? null;
  const baseItems = tabKey === "all" ? tabs.flatMap((t) => t.items) : (tab?.items ?? []);

  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const it of baseItems) counts.set(it.category, (counts.get(it.category) ?? 0) + 1);
    return CATEGORY_ORDER.filter((c) => counts.has(c));
  }, [baseItems]);

  const activeCategory =
    category !== "all" && (categories as string[]).includes(category) ? category : "all";

  const q = query.trim().toLowerCase();
  const items = baseItems.filter((it) => {
    if (activeCategory !== "all" && it.category !== activeCategory) return false;
    if (!q) return true;
    return it.name.toLowerCase().includes(q) || it.type.toLowerCase().includes(q);
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* 分页 / 部位 tabs（固定） */}
      <div className="flex shrink-0 flex-wrap gap-1.5">
        <TabChip active={tabKey === "all"} label={`全部 ${tabs.flatMap((t) => t.items).length}`} onClick={() => setTabKey("all")} />
        {tabs.map((t) => (
          <TabChip key={t.key} active={tabKey === t.key} label={`${t.label} ${t.items.length}`} onClick={() => setTabKey(t.key)} />
        ))}
      </div>

      {/* 筛选 + 搜索（固定） */}
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5">
          <CatChip active={activeCategory === "all"} label="全部分类" onClick={() => setCategory("all")} />
          {categories.map((c) => (
            <CatChip key={c} active={activeCategory === c} label={CATEGORY_LABEL[c] ?? c} onClick={() => setCategory(c)} />
          ))}
        </div>
        <input
          className="ml-auto w-56 rounded-lg border border-neutral-700 bg-[#11141b] px-3 py-1.5 text-sm text-neutral-100 placeholder:text-neutral-600"
          placeholder="搜索名称 / 物品代码…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {items.length === 0 ? (
        <div className="shrink-0 rounded-xl border border-dashed border-neutral-800 px-5 py-8 text-center text-sm text-neutral-500">
          {q || activeCategory !== "all" ? "没有匹配的物品。" : "此范围没有物品。"}
        </div>
      ) : (
        /* 表格区占满剩余高度，行滚动、表头吸顶 */
        <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-neutral-800">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-neutral-500">
              <tr>
                <th className="sticky top-0 z-10 bg-[#0d1017] px-4 py-2.5 font-medium">名称</th>
                <th className="sticky top-0 z-10 bg-[#0d1017] px-3 py-2.5 font-medium">代码</th>
                <th className="sticky top-0 z-10 bg-[#0d1017] px-3 py-2.5 font-medium">数量</th>
                <th className="sticky top-0 z-10 bg-[#0d1017] px-3 py-2.5 font-medium">等级</th>
                <th className="sticky top-0 z-10 bg-[#0d1017] px-3 py-2.5 font-medium">标记</th>
                <th className="sticky top-0 z-10 bg-[#0d1017] px-4 py-2.5 font-medium">位置</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800/70 bg-[#0b0e13]">
              {items.map((it, i) => (
                <ItemRow key={`${it.type}-${it.x}-${it.y}-${i}`} it={it} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ItemRow(props: { it: ItemDtoView }) {
  const it = props.it;
  return (
    <tr className="align-middle hover:bg-neutral-800/25">
      <td className="max-w-[20rem] px-4 py-2">
        <span className={`block truncate font-medium ${QUALITY_COLOR[it.quality] ?? "text-neutral-300"}`} title={it.name}>
          {it.name}
        </span>
        <span className="text-[11px] text-neutral-600">
          {qualityLabel(it.quality)}
          {it.ethereal ? " · 无形" : ""}
        </span>
      </td>
      <td className="px-3 py-2 font-mono text-xs text-neutral-400">{it.type}</td>
      <td className="px-3 py-2 text-neutral-300">{it.qty ?? "—"}</td>
      <td className="px-3 py-2 text-neutral-400">{it.level ?? "—"}</td>
      <td className="px-3 py-2">
        <span className="flex flex-wrap gap-1 text-[11px]">
          {it.ethereal && <Mark className="bg-sky-500/15 text-sky-300">无形</Mark>}
          {it.socketed && <Mark className="bg-neutral-700/60 text-neutral-200">打孔{it.sockets ? ` ×${it.sockets}` : ""}</Mark>}
          {!it.identified && <Mark className="bg-amber-500/15 text-amber-300">未鉴定</Mark>}
          {it.ethereal === false && !it.socketed && it.identified && <span className="text-neutral-700">—</span>}
        </span>
      </td>
      <td className="whitespace-nowrap px-4 py-2 text-xs text-neutral-400">
        {it.where === "stash" && it.page >= 0 ? `第 ${it.page + 1} 页 (${it.x},${it.y})` : `(${it.x},${it.y})`}
      </td>
    </tr>
  );
}

function qualityLabel(q: string): string {
  const map: Record<string, string> = {
    low: "低质", normal: "普通", superior: "超强", magic: "魔法",
    set: "套装", rare: "稀有", unique: "暗金", crafted: "手工",
    unknown: "未知",
  };
  return map[q] ?? q;
}

function Mark(props: { className: string; children: React.ReactNode }) {
  return <span className={`rounded-full px-2 py-0.5 ${props.className}`}>{props.children}</span>;
}

function TabChip(props: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      className={`rounded-lg px-3 py-1.5 text-xs transition-colors ${
        props.active
          ? "bg-violet-500/20 text-violet-200"
          : "bg-neutral-800/50 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
      }`}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}

function CatChip(props: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
        props.active
          ? "border-violet-500/50 bg-violet-500/15 text-violet-300"
          : "border-neutral-800 text-neutral-500 hover:border-neutral-600 hover:text-neutral-300"
      }`}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}
