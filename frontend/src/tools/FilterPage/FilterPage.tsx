/**
 * 过滤管理 (M5): manager for the game's built-in loot-filter presets
 * (<saveRoot>\*.fltr). Toggle rule enabled flags with auto-backup, browse
 * backup history (rollback / delete), import / export / duplicate / rename
 * / delete presets. Changes written while the game is running apply on the
 * next launch — the amber banner says so.
 */
import { useEffect, useState } from "react";
import { invoke, useCommand, errMsg } from "../../lib/ipc";
import { formatBytes, formatTime } from "../../lib/decode";
import type { AppConfigView, FilterBackupView, FilterPresetView } from "../../lib/types";
import { Modal } from "../../components/Modal";
import { btnGhost } from "../../App";

const btnPrimary =
  "rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40";

type RuleView = { name?: unknown; enabled?: unknown; ruleType?: unknown; [key: string]: unknown };

function ruleBadge(t: unknown): { label: string; cls: string } {
  switch (t) {
    case "hide":
      return { label: "隐藏", cls: "bg-red-500/15 text-red-300" };
    case "show":
      return { label: "显示", cls: "bg-emerald-500/15 text-emerald-300" };
    case "highlight":
      return { label: "高亮", cls: "bg-amber-500/15 text-amber-300" };
    default:
      return {
        label: typeof t === "string" && t ? t : "未知",
        cls: "bg-neutral-700/60 text-neutral-300",
      };
  }
}

function ruleName(r: RuleView): string {
  return typeof r.name === "string" && r.name.trim() ? r.name.trim() : "未命名规则";
}

export function FilterPage(props: { config: AppConfigView; goToSettings: () => void }) {
  const list = useCommand("d2r:filterList", {});
  const running = useCommand("d2r:checkGameRunning", {});
  const [selected, setSelected] = useState<string | null>(null);
  const [toggles, setToggles] = useState<Record<number, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<"backups" | "rename" | "duplicate" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const read = useCommand("d2r:filterRead", { file: selected ?? "" });

  // 列表刷新后，选中项可能已消失
  useEffect(() => {
    if (!list.data || !selected) return;
    if (!list.data.presets.some((p) => p.file === selected)) {
      setSelected(null);
      setToggles({});
    }
  }, [list.data, selected]);

  useEffect(() => {
    setConfirmDelete(false);
  }, [selected]);

  const presets = list.data?.presets ?? [];
  const current = presets.find((p) => p.file === selected) ?? null;
  const rules = read.data?.rules ?? [];
  const summaries = read.data?.summaries ?? [];

  const enabledOf = (i: number): boolean => toggles[i] ?? rules[i]?.enabled === true;

  const dirty = Object.entries(toggles)
    .filter(([i, v]) => (rules[Number(i)]?.enabled === true) !== v)
    .map(([i, v]) => ({ index: Number(i), enabled: v }));

  const toggleRule = (i: number) => {
    setToggles((prev) => ({ ...prev, [i]: !enabledOf(i) }));
  };

  const onImport = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await invoke("d2r:filterImport", {});
      if (r.file) {
        setInfo(`已导入：${r.file}`);
        list.refresh();
        setSelected(r.file);
        setToggles({});
      }
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const onExport = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const r = await invoke("d2r:filterExport", { file: selected });
      if (r.path) setInfo(`已导出到：${r.path}`);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const onSave = async () => {
    if (!selected || dirty.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const r = await invoke("d2r:filterUpdate", { file: selected, changes: dirty });
      setToggles({});
      setInfo(`已保存 ${r.changed} 条规则的修改` + (r.backedUp ? `，旧文件备份：${r.backedUp}` : ""));
      list.refresh();
      read.refresh();
      running.refresh();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const r = await invoke("d2r:filterDelete", { file: selected });
      setInfo(`已删除 ${selected}` + (r.backedUp ? `（备份：${r.backedUp}，可在备份历史中找回）` : ""));
      setSelected(null);
      setToggles({});
      list.refresh();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
      setConfirmDelete(false);
    }
  };

  return (
    /* 页头与横幅固定，左右两栏各自独立内滚，外壳不整体滚动 */
    <div className="flex h-full min-w-0 flex-col space-y-5">
      <header className="shrink-0 px-6 pt-6">
        <div className="mx-auto flex max-w-6xl items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">过滤管理</h2>
            <p className="mt-1 text-xs text-neutral-500">
              游戏自带掉落过滤预设（.fltr）· 勾选规则后保存，旧文件自动备份
            </p>
          </div>
          <button className={btnPrimary} onClick={() => void onImport()} disabled={busy}>
            导入预设
          </button>
        </div>
      </header>

      {running.data?.running && (
        <div className="mx-6 shrink-0 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-300">
          游戏正在运行，修改将在下次启动游戏时生效。
        </div>
      )}
      {!props.config.gameDir && (
        <div className="mx-6 flex shrink-0 items-center justify-between rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-300">
          <span>尚未设置游戏目录。过滤文件保存在存档目录，仍可管理，但建议先完成设置。</span>
          <button className={btnGhost} onClick={props.goToSettings}>
            去设置 →
          </button>
        </div>
      )}
      {error && <Banner className="mx-6 shrink-0" tone="red" text={error} onClose={() => setError(null)} />}
      {info && <Banner className="mx-6 shrink-0" tone="green" text={info} onClose={() => setInfo(null)} />}
      {list.error && <Banner className="mx-6 shrink-0" tone="red" text={list.error} onClose={list.refresh} />}

      {/* 左右两栏填满剩余高度各自滚动；内容保持 max-w-6xl 与页头对齐 */}
      <div className="min-h-0 flex-1 px-6 pb-6">
        <div className="mx-auto flex h-full max-w-6xl gap-5">
        {/* 左栏：预设列表（独立滚动） */}
        <section className="min-h-0 w-80 shrink-0 overflow-y-auto">
          {list.data && !list.data.rootExists ? (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-4 text-sm text-amber-300">
              未找到存档目录：{list.data.root}
              <div className="mt-1 text-xs text-amber-500/80">请先启动一次游戏让其生成存档目录。</div>
            </div>
          ) : list.data && presets.length === 0 ? (
            <div className="rounded-xl border border-dashed border-neutral-800 px-4 py-6 text-center text-sm text-neutral-500">
              存档目录里还没有 .fltr 预设。
              <div className="mt-1 text-xs text-neutral-600">点右上角「导入预设」把 .fltr 文件放进来，或在游戏内新建过滤方案。</div>
            </div>
          ) : (
            <ul className="space-y-2">
              {presets.map((p) => (
                <PresetItem
                  key={p.file}
                  preset={p}
                  active={p.file === selected}
                  onClick={() => {
                    setSelected(p.file);
                    setToggles({});
                    setConfirmDelete(false);
                  }}
                />
              ))}
            </ul>
          )}
        </section>

        {/* 右栏：规则（独立滚动） */}
        <section className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {!selected ? (
            <div className="rounded-xl border border-dashed border-neutral-800 px-4 py-10 text-center text-sm text-neutral-500">
              从左侧选择一个预设查看规则。
            </div>
          ) : read.error ? (
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-4 text-sm text-red-300">
              {read.error}
            </div>
          ) : !read.data ? (
            <p className="text-xs text-neutral-500">读取规则…</p>
          ) : (
            <>
              <div className="rounded-xl border border-neutral-800 bg-[#0d1017] px-5 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold text-neutral-100">{read.data.name}</h3>
                    <p className="mt-0.5 text-xs text-neutral-500">
                      {current ? `${current.ruleCount} 条规则 · 已启用 ${current.enabledCount} · ${formatBytes(current.size)} · ${formatTime(current.mtime)}` : read.data.rules.length + " 条规则"}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-1.5 text-xs">
                    <button className={btnGhost + " px-2 py-1 text-xs"} disabled={busy} onClick={() => void onExport()}>
                      导出
                    </button>
                    <button className={btnGhost + " px-2 py-1 text-xs"} disabled={busy} onClick={() => setDialog("duplicate")}>
                      另存副本
                    </button>
                    <button className={btnGhost + " px-2 py-1 text-xs"} disabled={busy} onClick={() => setDialog("rename")}>
                      重命名
                    </button>
                    <button className={btnGhost + " px-2 py-1 text-xs"} disabled={busy} onClick={() => setDialog("backups")}>
                      备份历史
                    </button>
                    <button
                      className={`rounded-lg border px-2 py-1 text-xs transition-colors ${
                        confirmDelete
                          ? "border-red-500/60 bg-red-500/15 text-red-300"
                          : "border-neutral-700 text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
                      } disabled:cursor-not-allowed disabled:opacity-40`}
                      disabled={busy}
                      onClick={() => (confirmDelete ? void onDelete() : setConfirmDelete(true))}
                    >
                      {confirmDelete ? "确认删除？" : "删除"}
                    </button>
                  </div>
                </div>
                {read.data.warning && (
                  <p className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-300">
                    {read.data.warning}
                  </p>
                )}
              </div>

              <ul className="mt-3 space-y-2">
                {read.data.rules.map((r, i) => {
                  const badge = ruleBadge(r.ruleType);
                  const enabled = enabledOf(i);
                  return (
                    <li
                      key={i}
                      className={`rounded-xl border px-4 py-3 ${
                        enabled ? "border-neutral-700 bg-[#0d1017]" : "border-neutral-800/80 bg-[#0b0e13] opacity-80"
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <input
                          type="checkbox"
                          className="h-4 w-4 shrink-0 accent-violet-500"
                          checked={enabled}
                          disabled={busy}
                          onChange={() => toggleRule(i)}
                        />
                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${badge.cls}`}>
                          {badge.label}
                        </span>
                        <span className={`min-w-0 flex-1 truncate text-sm ${enabled ? "text-neutral-100" : "text-neutral-400"}`}>
                          {ruleName(r)}
                          <span className="ml-2 text-xs text-neutral-500">{summaries[i] ?? ""}</span>
                        </span>
                      </div>
                      <details className="mt-2 text-xs text-neutral-500">
                        <summary className="cursor-pointer select-none text-neutral-600 hover:text-neutral-400">
                          原始条件
                        </summary>
                        <pre className="mt-1.5 max-h-48 overflow-auto rounded-lg bg-black/30 p-2.5 text-[11px] leading-relaxed text-neutral-400">
                          {JSON.stringify(r, null, 2)}
                        </pre>
                      </details>
                    </li>
                  );
                })}
              </ul>

              {dirty.length > 0 && (
                <div className="sticky bottom-0 mt-4 flex items-center justify-between gap-3 rounded-xl border border-violet-500/30 bg-[#14101f]/95 px-4 py-3 text-sm backdrop-blur">
                  <span className="text-violet-300">
                    本次将修改 {dirty.length} 条规则 · 旧文件自动备份
                  </span>
                  <div className="flex shrink-0 items-center gap-2">
                    <button className={btnGhost} disabled={busy} onClick={() => setToggles({})}>
                      放弃
                    </button>
                    <button className={btnPrimary} disabled={busy} onClick={() => void onSave()}>
                      {busy ? "保存中…" : "保存"}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </section>
        </div>
      </div>

      {dialog === "backups" && selected && (
        <BackupsDialog
          file={selected}
          busy={busy}
          setBusy={setBusy}
          onClose={() => setDialog(null)}
          onRestored={(backedUp) => {
            setDialog(null);
            setInfo(`已回滚 ${selected}` + (backedUp ? `，回滚前版本已备份：${backedUp}` : ""));
            list.refresh();
            read.refresh();
          }}
          onDeleted={() => setInfo("已删除备份")}
        />
      )}
      {dialog === "rename" && selected && (
        <NameDialog
          title="重命名预设"
          initial={read.data?.name ?? ""}
          confirmText="重命名"
          busy={busy}
          setBusy={setBusy}
          setError={setError}
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            const r = await invoke("d2r:filterRename", { file: selected, newName: name });
            setSelected(r.file);
            setToggles({});
            list.refresh();
            setInfo(`已重命名为：${name}`);
          }}
        />
      )}
      {dialog === "duplicate" && selected && (
        <NameDialog
          title="另存为副本"
          initial={`${read.data?.name ?? ""} 副本`}
          confirmText="创建副本"
          busy={busy}
          setBusy={setBusy}
          setError={setError}
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            const r = await invoke("d2r:filterDuplicate", { file: selected, newName: name });
            setSelected(r.file);
            list.refresh();
            setInfo(`已创建副本：${name}`);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preset list item
// ---------------------------------------------------------------------------

function PresetItem(props: { preset: FilterPresetView; active: boolean; onClick: () => void }) {
  const p = props.preset;
  return (
    <li>
      <button
        onClick={props.onClick}
        className={`w-full rounded-xl border px-4 py-3 text-left transition-colors ${
          props.active
            ? "border-violet-500/40 bg-violet-500/10"
            : "border-neutral-800 bg-[#0d1017] hover:border-neutral-700"
        }`}
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className={`truncate text-sm font-medium ${props.active ? "text-violet-200" : "text-neutral-100"}`}>
            {p.name}
          </span>
          <span className="shrink-0 text-[11px] text-neutral-500">{formatTime(p.mtime)}</span>
        </div>
        <p className="mt-1 text-xs text-neutral-500">
          {p.ruleCount} 条规则 · 已启用 {p.enabledCount} · {formatBytes(p.size)}
        </p>
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

function BackupsDialog(props: {
  file: string;
  busy: boolean;
  setBusy: (b: boolean) => void;
  onClose: () => void;
  onRestored: (backedUp: string | null) => void;
  onDeleted: () => void;
}) {
  const backups = useCommand("d2r:filterBackups", { file: props.file });
  const [error, setErrorLocal] = useState<string | null>(null);
  const [confirmName, setConfirmName] = useState<string | null>(null);

  const restore = async (b: FilterBackupView) => {
    props.setBusy(true);
    setErrorLocal(null);
    try {
      const r = await invoke("d2r:filterRestoreBackup", { file: props.file, backup: b.name });
      props.onRestored(r.backedUp);
    } catch (err) {
      setErrorLocal(errMsg(err));
      props.setBusy(false);
    }
  };

  const remove = async (b: FilterBackupView) => {
    props.setBusy(true);
    setErrorLocal(null);
    try {
      await invoke("d2r:filterDeleteBackup", { file: props.file, backup: b.name });
      backups.refresh();
      props.onDeleted();
    } catch (err) {
      setErrorLocal(errMsg(err));
    } finally {
      props.setBusy(false);
      setConfirmName(null);
    }
  };

  return (
    <Modal title={`备份历史 · ${props.file}`} onClose={props.onClose}>
      {backups.error && <p className="mb-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">{backups.error}</p>}
      {error && <p className="mb-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p>}
      {!backups.data ? (
        <p className="text-xs text-neutral-500">读取备份…</p>
      ) : backups.data.backups.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-800 px-4 py-5 text-center text-xs text-neutral-500">
          还没有备份。每次保存 / 删除 / 回滚都会自动备份旧文件。
        </div>
      ) : (
        <ul className="space-y-2">
          {backups.data.backups.map((b) => (
            <li key={b.name} className="flex items-center gap-3 rounded-lg border border-neutral-800 px-3.5 py-2.5">
              <span className="min-w-0 flex-1 truncate text-sm text-neutral-200">{b.name}</span>
              <span className="shrink-0 text-xs text-neutral-500">
                {formatTime(b.mtime)} · {formatBytes(b.size)}
              </span>
              <button
                className={btnGhost + " shrink-0 px-2 py-1 text-xs"}
                disabled={props.busy}
                onClick={() => void restore(b)}
              >
                回滚到此版本
              </button>
              <button
                className={`shrink-0 rounded-lg border px-2 py-1 text-xs transition-colors ${
                  confirmName === b.name
                    ? "border-red-500/60 bg-red-500/15 text-red-300"
                    : "border-neutral-700 text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
                } disabled:cursor-not-allowed disabled:opacity-40`}
                disabled={props.busy}
                onClick={() => {
                  if (confirmName === b.name) void remove(b);
                  else setConfirmName(b.name);
                }}
              >
                {confirmName === b.name ? "确认删除？" : "删除"}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-neutral-600">回滚会先备份当前版本，随时可以回滚回来。</p>
    </Modal>
  );
}

function NameDialog(props: {
  title: string;
  initial: string;
  confirmText: string;
  busy: boolean;
  setBusy: (b: boolean) => void;
  setError: (e: string | null) => void;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(props.initial);
  const [error, setErrorLocal] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) return;
    props.setBusy(true);
    setErrorLocal(null);
    try {
      await props.onSubmit(name.trim());
      props.onClose();
    } catch (err) {
      setErrorLocal(errMsg(err)); // 重名 / 非法字符 — 留在弹窗里改
      props.setBusy(false);
    }
  };

  return (
    <Modal
      title={props.title}
      onClose={props.onClose}
      footer={
        <>
          <button className={btnGhost} onClick={props.onClose}>
            取消
          </button>
          <button className={btnPrimary} disabled={props.busy || !name.trim()} onClick={() => void submit()}>
            {props.busy ? "处理中…" : props.confirmText}
          </button>
        </>
      }
    >
      <p className="text-xs text-neutral-500">名称会同时用作文件名（自动加 .fltr）与预设内部名称。</p>
      <input
        autoFocus
        className="mt-3 w-full rounded-lg border border-neutral-700 bg-[#11141b] px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600"
        placeholder="预设名称"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
        }}
      />
      {error && <p className="mt-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p>}
    </Modal>
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
