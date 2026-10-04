/**
 * Mod 库 page (M9): vetted online index (mirror chain → bundled fallback),
 * search + install via author direct link or local zip import. 红线: the
 * index is metadata only — files always come from the author's own host.
 */
import { useMemo, useState } from "react";
import { invoke, errMsg, useCommand } from "../../lib/ipc";
import { btnGhost } from "../../App";
import { ZipInstallDialog } from "./ZipInstallDialog";
import type { AppConfigView } from "../../lib/types";

type IndexEntry = {
  id: string;
  name: string;
  author: string;
  category: string;
  version: string;
  language?: string;
  homepage: string | null;
  downloadUrl: string | null;
  configUrl: string | null;
  description: string;
  notes?: string;
};

type IndexResult = {
  entries: IndexEntry[];
  fetchedAt: number;
  via: string;
  bundledFallback: boolean;
  errorsText: string | null;
};

const CATEGORY_LABEL: Record<string, string> = {
  "chinese-pack": "中文整合",
  foreign: "国外 mod",
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function StorePage(props: {
  config: AppConfigView;
  goToSettings: () => void;
}) {
  // 首次进入用缓存（后端 1h TTL 内不打网络）；「刷新」强制拉远端。
  const index = useCommand("d2r:modIndexList", {});
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [installSource, setInstallSource] = useState<
    { kind: "url"; url: string; label: string } | { kind: "pick" } | null
  >(null);

  const entries = index.data?.entries ?? [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) =>
      [e.name, e.author, e.description, e.category].some((s) => s?.toLowerCase().includes(q)),
    );
  }, [entries, query]);

  async function refresh() {
    setError("");
    setNotice("");
    try {
      await invoke("d2r:modIndexList", { refresh: true });
      index.refresh();
      setNotice("在线清单已刷新。");
    } catch (err) {
      setError(errMsg(err));
    }
  }

  async function openHomepage(url: string) {
    setError("");
    try {
      // explorer.exe 遇到 http(s) 参数会转交系统默认浏览器
      await invoke("d2r:openDir", { path: url });
    } catch (err) {
      setError(errMsg(err));
    }
  }

  if (!props.config.gameDir) {
    return (
      <div className="h-full overflow-y-auto px-6 pt-6">
        <div className="mx-auto mt-16 max-w-md text-center">
          <p className="text-sm text-neutral-400">先设置游戏目录，才能安装 Mod 库里的 MOD。</p>
          <button className={btnGhost + " mt-3"} onClick={props.goToSettings}>
            去设置 →
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-col space-y-4">
      <div className="flex shrink-0 items-center justify-between px-6 pt-6">
        <div>
          <h2 className="text-base font-semibold">Mod 库</h2>
          <p className="text-xs text-neutral-500">
            已验证的 mod 源清单（仅元数据，文件始终来自作者原始地址）。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button className={btnGhost} onClick={() => setInstallSource({ kind: "pick" })}>
            导入本地 zip
          </button>
          <button className={btnGhost} disabled={index.loading} onClick={() => void refresh()}>
            {index.loading ? "同步中…" : "刷新"}
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3 text-xs text-neutral-500">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索名称 / 作者 / 描述…"
              className="w-64 rounded-lg border border-neutral-800 bg-[#11141b] px-3 py-1.5 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
            />
            {index.data && (
              <span>
                {index.data.bundledFallback ? "离线清单" : "数据源 " + index.data.via} · 同步于{" "}
                {formatTime(index.data.fetchedAt)}
              </span>
            )}
            {index.data?.bundledFallback && (
              <span className="rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-amber-300">
                在线镜像不可达，展示内置清单
              </span>
            )}
          </div>

          {(notice || error) && (
            <div
              className={`rounded-lg border px-4 py-2 text-sm ${
                error
                  ? "border-red-500/30 bg-red-500/10 text-red-300"
                  : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
              }`}
            >
              <span>{error || notice}</span>
              <button
                className="ml-3 text-xs text-neutral-400 hover:text-neutral-200"
                onClick={() => {
                  setNotice("");
                  setError("");
                }}
              >
                关闭
              </button>
            </div>
          )}

          {index.loading && <p className="text-sm text-neutral-500">读取在线清单…</p>}
          {index.error && <p className="text-sm text-red-400">{index.error}</p>}

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
            {filtered.map((e) => (
              <div
                key={e.id}
                className="flex flex-col rounded-xl border border-neutral-800 bg-[#11141b] p-4 transition-colors hover:border-neutral-700"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold text-neutral-100">{e.name}</h3>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
                      <Chip>{CATEGORY_LABEL[e.category] ?? e.category}</Chip>
                      {e.language === "zh" ? <Chip tone="cyan">中文</Chip> : null}
                      {e.version && e.version !== "-" ? <Chip tone="green">v{e.version}</Chip> : null}
                    </div>
                  </div>
                </div>
                {e.description && (
                  <p className="mt-2 line-clamp-3 text-xs leading-5 text-neutral-400">{e.description}</p>
                )}
                {e.notes && <p className="mt-1.5 text-[11px] text-neutral-600">{e.notes}</p>}
                <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-neutral-800/60 pt-3 text-xs text-neutral-500">
                  <span className="mr-auto">{e.author}</span>
                  {e.homepage && (
                    <button className={btnGhost + " !px-2 !py-0.5 !text-[11px]"} onClick={() => void openHomepage(e.homepage!)}>
                      打开主页
                    </button>
                  )}
                  {e.downloadUrl ? (
                    <button
                      className="rounded-lg bg-neutral-100 px-3 py-1 text-xs font-semibold text-neutral-950 transition-transform active:translate-y-px"
                      onClick={() => setInstallSource({ kind: "url", url: e.downloadUrl!, label: e.name })}
                    >
                      安装
                    </button>
                  ) : (
                    <button
                      className="rounded-lg border border-neutral-700 px-3 py-1 text-xs text-neutral-300 transition-colors hover:border-neutral-500 hover:bg-neutral-800/60"
                      onClick={() => setInstallSource({ kind: "pick" })}
                      title="该 mod 没有公开直链（网盘/群分发），下载后从这里导入 zip"
                    >
                      手动导入
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          {!index.loading && filtered.length === 0 && !index.error && (
            <div className="mx-auto mt-10 max-w-md rounded-2xl border border-dashed border-neutral-800 p-8 text-center text-sm text-neutral-500">
              {query ? "没有匹配的条目。" : "清单为空——往 docs/mod-index.json 添加条目并刷新。"}
            </div>
          )}
        </div>
      </div>

      {installSource && (
        <ZipInstallDialog
          source={installSource}
          onClose={() => setInstallSource(null)}
          onDone={() => undefined}
        />
      )}
    </div>
  );
}

function Chip(props: { children: React.ReactNode; tone?: "cyan" | "green" }) {
  const tones = {
    cyan: "border-cyan-500/30 bg-cyan-500/10 text-cyan-300",
    green: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  } as const;
  return (
    <span
      className={`rounded border px-1.5 py-0.5 ${props.tone ? tones[props.tone] : "border-neutral-700 bg-neutral-800/60 text-neutral-400"}`}
    >
      {props.children}
    </span>
  );
}
