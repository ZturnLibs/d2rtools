/**
 * 环境体检 (M8): one-click read-only health report of the game
 * environment — path shape/length, emu-pack language, game version,
 * antivirus-victim core files, save dir and system settings. Items come
 * from a single d2r:healthCheck invocation (auto-run on mount, ~1-3s of
 * PowerShell cold start); warn/fail rows carry step-by-step fix guidance.
 * 复制报告 exports plain text for pasting into group chats.
 */
import { useState } from "react";
import { useCommand, errMsg } from "../lib/ipc";
import type { AppConfigView, HealthCheckItemView, HealthCheckResult } from "../lib/types";
import { btnGhost } from "../App";

const btnPrimary =
  "rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40";

const GROUP_NAMES: Record<HealthCheckItemView["group"], string> = {
  path: "游戏目录",
  lang: "游戏语言",
  version: "版本信息",
  av: "杀毒误报",
  saves: "存档",
  system: "系统",
};
const GROUP_ORDER = ["path", "lang", "version", "av", "saves", "system"] as const;

const STATUS_META: Record<HealthCheckItemView["status"], { label: string; dot: string; text: string }> = {
  ok: { label: "正常", dot: "bg-emerald-500", text: "text-emerald-300" },
  info: { label: "提示", dot: "bg-neutral-400", text: "text-neutral-300" },
  warn: { label: "警告", dot: "bg-amber-500", text: "text-amber-300" },
  fail: { label: "异常", dot: "bg-red-500", text: "text-red-300" },
};

function buildReportText(data: HealthCheckResult): string {
  const lines: string[] = [`D2R 工具箱 · 环境体检报告`];
  lines.push(`游戏目录：${data.gameDir ?? "（未设置）"}`);
  const version = data.items.find((i) => i.id === "game-version")?.detail;
  if (version) lines.push(version);
  lines.push("");
  for (const it of data.items) {
    lines.push(`[${STATUS_META[it.status].label}] ${GROUP_NAMES[it.group]}·${it.title}：${it.detail}`);
  }
  return lines.join("\n");
}

export function HealthPage(props: { config: AppConfigView; goToSettings: () => void }) {
  const health = useCommand("d2r:healthCheck", {});
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const items = health.data?.items ?? [];
  const counts = { ok: 0, info: 0, warn: 0, fail: 0 } as Record<HealthCheckItemView["status"], number>;
  for (const it of items) counts[it.status] += 1;

  const grouped = GROUP_ORDER.map((g) => ({ group: g, items: items.filter((i) => i.group === g) })).filter(
    (g) => g.items.length > 0,
  );

  const onCopy = async () => {
    if (!health.data) return;
    try {
      await navigator.clipboard.writeText(buildReportText(health.data));
      setInfo("体检报告已复制，可直接粘贴到群里。");
      setError(null);
    } catch (err) {
      setError(errMsg(err));
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-col space-y-5">
      <header className="shrink-0 px-6 pt-6">
        <div className="mx-auto flex max-w-4xl items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">环境体检</h2>
            <p className="mt-1 text-xs text-neutral-500">
              一键检测游戏环境常见问题 · 只检测，不改动任何文件
              {health.data && (
                <span className="ml-2 text-neutral-600">耗时 {(health.data.durationMs / 1000).toFixed(1)}s</span>
              )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              className={btnGhost}
              disabled={!health.data || health.loading}
              onClick={() => void onCopy()}
            >
              复制报告
            </button>
            <button className={btnPrimary} disabled={health.loading} onClick={health.refresh}>
              {health.loading ? "检测中…" : items.length > 0 ? "重新检测" : "一键检测"}
            </button>
          </div>
        </div>
        {items.length > 0 && (
          <div className="mx-auto mt-3 flex max-w-4xl flex-wrap items-center gap-2 text-xs">
            {(Object.keys(counts) as HealthCheckItemView["status"][]).map((s) =>
              counts[s] > 0 ? (
                <span
                  key={s}
                  className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 ${STATUS_META[s].text} bg-neutral-800/60`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${STATUS_META[s].dot}`} />
                  {counts[s]} {STATUS_META[s].label}
                </span>
              ) : null,
            )}
          </div>
        )}
      </header>

      {health.error && (
        <Banner className="mx-6 shrink-0" tone="red" text={health.error} onClose={health.refresh} />
      )}
      {error && <Banner className="mx-6 shrink-0" tone="red" text={error} onClose={() => setError(null)} />}
      {info && <Banner className="mx-6 shrink-0" tone="green" text={info} onClose={() => setInfo(null)} />}
      {!props.config.gameDir && (
        <div className="mx-6 flex shrink-0 items-center justify-between rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-300">
          <span>尚未设置游戏目录，大部分体检项无法进行。</span>
          <button className={btnGhost} onClick={props.goToSettings}>
            去设置 →
          </button>
        </div>
      )}

      {/* 单列体检报告，独立内滚，滚动条贴窗体右缘 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        <div className="mx-auto max-w-4xl">
          {health.loading && items.length === 0 ? (
            <div className="rounded-xl border border-dashed border-neutral-800 px-4 py-10 text-center text-sm text-neutral-500">
              正在体检…
              <div className="mt-1 text-xs text-neutral-600">首次检测需要调用系统组件，约几秒钟。</div>
            </div>
          ) : (
            <div className="space-y-5">
              {grouped.map(({ group, items: groupItems }) => (
                <section key={group}>
                  <h3 className="mb-2 px-1 text-xs font-medium uppercase tracking-wider text-neutral-500">
                    {GROUP_NAMES[group]}
                  </h3>
                  <div className="space-y-2">
                    {groupItems.map((it) => (
                      <ItemRow key={it.id} item={it} />
                    ))}
                  </div>
                </section>
              ))}
              {items.length > 0 && (
                <p className="px-1 pt-1 text-center text-[11px] text-neutral-600">
                  检测结果仅供参考 · 向群友求助时可点右上角「复制报告」附上完整结果
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ItemRow({ item }: { item: HealthCheckItemView }) {
  const meta = STATUS_META[item.status];
  const showFix = (item.status === "warn" || item.status === "fail") && item.fixSteps.length > 0;
  return (
    <div className="rounded-xl border border-neutral-800 bg-[#0d1017] px-4 py-3">
      <div className="flex items-start gap-2.5">
        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${meta.dot}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-medium text-neutral-100">{item.title}</span>
            <span className={`text-[11px] ${meta.text}`}>{meta.label}</span>
          </div>
          <p className="mt-0.5 break-all text-xs text-neutral-400">{item.detail}</p>
          {showFix && (
            <div
              className={`mt-2 rounded-lg border px-3 py-2 text-xs ${
                item.status === "fail"
                  ? "border-red-500/30 bg-red-500/10 text-red-200"
                  : "border-amber-500/30 bg-amber-500/10 text-amber-200"
              }`}
            >
              {item.fixSummary && <p className="font-medium">{item.fixSummary}</p>}
              <ol className="mt-1 list-decimal space-y-1 pl-4">
                {item.fixSteps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Banner(props: { tone: "red" | "green"; text: string; onClose: () => void; className?: string }) {
  const cls =
    props.tone === "red"
      ? "border-red-500/30 bg-red-500/10 text-red-300"
      : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300";
  return (
    <div className={`flex items-center justify-between gap-3 rounded-xl border px-4 py-2.5 text-sm ${cls} ${props.className ?? ""}`}>
      <span className="min-w-0 break-all">{props.text}</span>
      <button className="shrink-0 opacity-60 transition-opacity hover:opacity-100" onClick={props.onClose}>
        ✕
      </button>
    </div>
  );
}
