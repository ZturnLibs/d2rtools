/**
 * 存档管家（M2）: save-tree overview + snapshot backup/restore.
 * Backups live in %APPDATA%\com.zyj.d2rbox\backups (dir shown with an open
 * button). Restore is a two-step-confirm modal — the backend mirrors the
 * target dir and takes a mandatory pre-restore snapshot first.
 */
import { useEffect, useState } from "react";
import { invoke, useCommand, errMsg } from "../lib/ipc";
import { formatBytes, formatTime } from "../lib/decode";
import type {
  AppConfigView,
  BackupMetaView,
  SaveGroupView,
  StashPreflightView,
} from "../lib/types";
import { Modal } from "../components/Modal";
import { btnGhost } from "../App";

const btnPrimary =
  "rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40";

type Trigger = BackupMetaView["trigger"];

const TRIGGER_LABEL: Record<Trigger, string> = {
  manual: "手动备份",
  "auto-launch": "启动前",
  "pre-restore": "还原前",
  stash: "仓库替换",
};

const TRIGGER_CLASS: Record<Trigger, string> = {
  manual: "bg-sky-500/15 text-sky-300",
  "auto-launch": "bg-violet-500/15 text-violet-300",
  "pre-restore": "bg-amber-500/15 text-amber-300",
  stash: "bg-emerald-500/15 text-emerald-300",
};

function slotLabel(slot: string): string {
  return slot === "root" ? "主存档" : `mod存档：${slot.slice("mods/".length)}`;
}

/** Rough save-file classification for the overview card. */
function classify(name: string): "char" | "stash" | "settings" | "filter" | "other" {
  const lower = name.toLowerCase();
  if (lower.endsWith(".d2s")) return "char";
  if (lower.endsWith(".d2i") || lower.endsWith(".ftck") || lower.includes("stash")) return "stash";
  if (lower.endsWith(".json")) return "settings";
  if (lower.endsWith(".fltr")) return "filter";
  return "other";
}

const CLASS_LABEL: Record<ReturnType<typeof classify>, string> = {
  char: "角色",
  stash: "仓库",
  settings: "设置",
  filter: "过滤器",
  other: "其他",
};

export function SavesPage(props: { config: AppConfigView; refreshConfig: () => void }) {
  const overview = useCommand("d2r:saveOverview", {});
  const backups = useCommand("d2r:listBackups", {});
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  const [restore, setRestore] = useState<BackupMetaView | null>(null);

  // prefs — optimistic local copy of config.autoBackup / config.backupKeep
  const [autoBackup, setAutoBackup] = useState(props.config.autoBackup);
  const [keep, setKeep] = useState(props.config.backupKeep);
  useEffect(() => {
    setAutoBackup(props.config.autoBackup);
    setKeep(props.config.backupKeep);
  }, [props.config.autoBackup, props.config.backupKeep]);

  const savePrefs = async (patch: { autoBackup?: boolean; backupKeep?: number }) => {
    setBusy(true);
    setError(null);
    try {
      const r = await invoke("d2r:setSavePrefs", patch);
      setAutoBackup(r.autoBackup);
      setKeep(r.backupKeep);
      props.refreshConfig();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await invoke("d2r:deleteBackup", { id });
      backups.refresh();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const onRestoreDone = async (preRestoreId: string | null) => {
    setRestore(null);
    setInfo(preRestoreId ? `还原完成，回滚点：${preRestoreId}` : "还原完成");
    overview.refresh();
    backups.refresh();
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">存档管家</h2>
          <p className="mt-1 text-xs text-neutral-500">
            整目录快照备份 / 镜像还原 · 还原与替换前自动创建回滚点
          </p>
        </div>
        <button className={btnPrimary} onClick={() => setBackupOpen(true)} disabled={busy || !overview.data}>
          立即备份
        </button>
      </header>

      {error && <Banner tone="red" text={error} onClose={() => setError(null)} />}
      {info && <Banner tone="green" text={info} onClose={() => setInfo(null)} />}

      {/* prefs bar */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border border-neutral-800 bg-[#0d1017] px-5 py-3.5 text-sm">
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            className="h-4 w-4 accent-violet-500"
            checked={autoBackup}
            disabled={busy}
            onChange={(e) => void savePrefs({ autoBackup: e.target.checked })}
          />
          启动 Mod 前自动备份
        </label>
        <label className="flex items-center gap-2 text-neutral-300">
          每个范围保留
          <input
            type="number"
            min={1}
            max={100}
            className="w-16 rounded-md border border-neutral-700 bg-[#11141b] px-2 py-1 text-center text-sm text-neutral-100"
            value={keep}
            disabled={busy}
            onChange={(e) => {
              const n = Math.max(1, Math.min(100, Math.trunc(Number(e.target.value) || 1)));
              setKeep(n);
              void savePrefs({ backupKeep: n });
            }}
          />
          份
        </label>
        {backups.data && (
          <div className="ml-auto flex min-w-0 items-center gap-2 text-xs text-neutral-500">
            <span className="truncate" title={backups.data.dir}>
              备份目录：{backups.data.dir}
            </span>
            <button className={btnGhost + " shrink-0 px-2 py-1 text-xs"} onClick={() => void invoke("d2r:openDir", { path: backups.data!.dir })}>
              打开
            </button>
          </div>
        )}
      </div>

      {overview.error && <Banner tone="red" text={overview.error} onClose={overview.refresh} />}

      {overview.data && <OverviewSection root={overview.data.root} mods={overview.data.mods} />}

      {backups.error && <Banner tone="red" text={backups.error} onClose={backups.refresh} />}
      {backups.data && (
        <SnapshotList
          backups={backups.data.backups}
          busy={busy}
          onRestore={(b) => setRestore(b)}
          onDelete={(id) => void onDelete(id)}
          onOpenDir={(id) => void invoke("d2r:openDir", { path: `${backups.data!.dir}\\${id}` })}
        />
      )}

      {backupOpen && overview.data && (
        <BackupDialog
          root={overview.data.root}
          mods={overview.data.mods.filter((m) => m.exists)}
          busy={busy}
          setBusy={setBusy}
          setError={setError}
          onClose={() => setBackupOpen(false)}
          onDone={(b) => {
            setBackupOpen(false);
            setInfo(`备份完成：${b.id}（${b.files} 个文件，${formatBytes(b.bytes)}）`);
            backups.refresh();
          }}
        />
      )}

      {restore && (
        <RestoreDialog
          meta={restore}
          busy={busy}
          setBusy={setBusy}
          setError={setError}
          onClose={() => setRestore(null)}
          onDone={onRestoreDone}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function OverviewSection(props: { root: SaveGroupView; mods: SaveGroupView[] }) {
  const { root, mods } = props;
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-neutral-300">存档总览</h3>
      {!root.exists ? (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-5 py-4 text-sm text-amber-300">
          未找到存档目录：{root.path}
          <div className="mt-1 text-xs text-amber-500/80">请先启动一次游戏让其生成存档目录。</div>
        </div>
      ) : (
        <RootCard root={root} />
      )}
      {mods.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {mods.map((m) => (
            <ModSaveCard key={m.slot} group={m} />
          ))}
        </div>
      )}
    </section>
  );
}

function RootCard(props: { root: SaveGroupView }) {
  const root = props.root;
  const counts = new Map<string, { n: number; bytes: number }>();
  for (const f of root.files) {
    const k = classify(f.name);
    const c = counts.get(k) ?? { n: 0, bytes: 0 };
    c.n++;
    c.bytes += f.size;
    counts.set(k, c);
  }
  const order = ["char", "stash", "settings", "filter", "other"] as const;

  return (
    <div className="rounded-xl border border-neutral-800 bg-[#0d1017] px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-neutral-100">主存档</h4>
          <p className="mt-0.5 truncate text-xs text-neutral-500" title={root.path}>
            {root.path}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-xs text-neutral-400">
          <span>
            {root.files.length} 个文件 · {formatBytes(root.totalBytes)}
          </span>
          <button className={btnGhost + " px-2 py-1 text-xs"} onClick={() => void invoke("d2r:openDir", { path: root.path })}>
            打开
          </button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        {order.map((k) => {
          const c = counts.get(k);
          if (!c) return null;
          return (
            <span key={k} className="rounded-full bg-neutral-800/70 px-2.5 py-1 text-neutral-300">
              {CLASS_LABEL[k]} {c.n} · {formatBytes(c.bytes)}
            </span>
          );
        })}
      </div>

      {root.dirs.length > 0 && (
        <div className="mt-3 border-t border-neutral-800/70 pt-2.5">
          <p className="text-xs text-neutral-500">子目录（含手工备份，会一并纳入快照）</p>
          <ul className="mt-1.5 space-y-1">
            {root.dirs.map((d) => (
              <li key={d.name} className="flex items-center justify-between text-xs text-neutral-300">
                <span className="truncate">
                  📁 {d.name}
                  <span className="ml-2 text-neutral-500">
                    {d.files} 个文件 · {formatBytes(d.bytes)}
                  </span>
                </span>
                <button
                  className="shrink-0 text-neutral-500 transition-colors hover:text-neutral-200"
                  onClick={() => void invoke("d2r:openDir", { path: `${root.path}\\${d.name}` })}
                >
                  打开
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ModSaveCard(props: { group: SaveGroupView }) {
  const g = props.group;
  return (
    <div className="rounded-xl border border-neutral-800 bg-[#0d1017] px-4 py-3.5">
      <div className="flex items-start justify-between gap-2">
        <h4 className="truncate text-sm font-medium text-neutral-100">{g.name}</h4>
        {g.exists && (
          <button
            className="shrink-0 text-xs text-neutral-500 transition-colors hover:text-neutral-200"
            onClick={() => void invoke("d2r:openDir", { path: g.path })}
          >
            打开
          </button>
        )}
      </div>
      <p className="mt-1 text-xs text-neutral-500">
        {g.exists ? `${g.files.length} 个文件 · ${formatBytes(g.totalBytes)}` : "尚未创建（启动该 Mod 后生成）"}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Snapshot list
// ---------------------------------------------------------------------------

function SnapshotList(props: {
  backups: BackupMetaView[];
  busy: boolean;
  onRestore: (b: BackupMetaView) => void;
  onDelete: (id: string) => void;
  onOpenDir: (id: string) => void;
}) {
  if (props.backups.length === 0) {
    return (
      <section className="rounded-xl border border-dashed border-neutral-800 px-5 py-6 text-center text-sm text-neutral-500">
        还没有快照。「立即备份」或开启自动备份后，快照会出现在这里。
      </section>
    );
  }
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-neutral-300">快照（每个范围保留最新）</h3>
      <div className="overflow-hidden rounded-xl border border-neutral-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-[#0d1017] text-xs text-neutral-500">
            <tr>
              <th className="px-4 py-2.5 font-medium">时间</th>
              <th className="px-3 py-2.5 font-medium">来源</th>
              <th className="px-3 py-2.5 font-medium">范围</th>
              <th className="px-3 py-2.5 font-medium">大小</th>
              <th className="px-3 py-2.5 font-medium">备注</th>
              <th className="px-4 py-2.5 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-800/70 bg-[#0b0e13]">
            {props.backups.map((b) => (
              <tr key={b.id} className="align-middle hover:bg-neutral-800/25">
                <td className="whitespace-nowrap px-4 py-2.5 text-neutral-200">{formatTime(b.createdAt)}</td>
                <td className="px-3 py-2.5">
                  <span className={`rounded-full px-2 py-0.5 text-xs ${TRIGGER_CLASS[b.trigger] ?? "bg-neutral-800 text-neutral-300"}`}>
                    {TRIGGER_LABEL[b.trigger as Trigger] ?? b.trigger}
                  </span>
                </td>
                <td className="px-3 py-2.5">
                  <span className="flex flex-wrap gap-1">
                    {b.scopes.map((s) => (
                      <span key={s.slot} className="rounded bg-neutral-800/70 px-1.5 py-0.5 text-xs text-neutral-300">
                        {slotLabel(s.slot)}
                      </span>
                    ))}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-2.5 text-xs text-neutral-400">
                  {b.files} 文件 · {formatBytes(b.bytes)}
                </td>
                <td className="max-w-[16rem] px-3 py-2.5">
                  <NoteCell id={b.id} note={b.note} />
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-right">
                  <div className="inline-flex items-center gap-1.5 text-xs">
                    <button className={btnGhost + " px-2 py-1 text-xs"} disabled={props.busy} onClick={() => props.onRestore(b)}>
                      还原
                    </button>
                    <button className={btnGhost + " px-2 py-1 text-xs"} onClick={() => props.onOpenDir(b.id)}>
                      目录
                    </button>
                    <ConfirmButton disabled={props.busy} onConfirm={() => props.onDelete(b.id)} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function NoteCell(props: { id: string; note: string }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(props.note);
  useEffect(() => setValue(props.note), [props.note]);

  const commit = async () => {
    setEditing(false);
    if (value.trim() === props.note) return;
    try {
      await invoke("d2r:setBackupNote", { id: props.id, note: value });
    } catch {
      setValue(props.note);
    }
  };

  if (editing) {
    return (
      <input
        autoFocus
        className="w-full rounded-md border border-violet-500/50 bg-[#11141b] px-2 py-1 text-xs text-neutral-100"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") void commit();
          if (e.key === "Escape") {
            setValue(props.note);
            setEditing(false);
          }
        }}
      />
    );
  }
  return (
    <button
      className="w-full truncate rounded px-1 py-0.5 text-left text-xs text-neutral-400 hover:bg-neutral-800/60 hover:text-neutral-200"
      title="点击编辑备注"
      onClick={() => setEditing(true)}
    >
      {props.note || <span className="text-neutral-600">＋ 备注</span>}
    </button>
  );
}

/** Two-click delete: first click arms, second (within 3.5s) fires. */
function ConfirmButton(props: { disabled: boolean; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3500);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      className={`rounded-lg border px-2 py-1 text-xs transition-colors ${
        armed
          ? "border-red-500/60 bg-red-500/15 text-red-300"
          : "border-neutral-700 text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
      } disabled:cursor-not-allowed disabled:opacity-40`}
      disabled={props.disabled}
      onClick={() => (armed ? props.onConfirm() : setArmed(true))}
    >
      {armed ? "确认删除？" : "删除"}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

function BackupDialog(props: {
  root: SaveGroupView;
  mods: SaveGroupView[];
  busy: boolean;
  setBusy: (b: boolean) => void;
  setError: (e: string | null) => void;
  onClose: () => void;
  onDone: (b: BackupMetaView) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set(["root"]));
  const [note, setNote] = useState("");

  const toggle = (slot: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slot)) next.delete(slot);
      else next.add(slot);
      return next;
    });
  };

  const submit = async () => {
    props.setBusy(true);
    props.setError(null);
    try {
      const r = await invoke("d2r:backupNow", { slots: [...selected], note: note.trim() || undefined });
      props.onDone(r.backup);
    } catch (err) {
      props.setError(errMsg(err));
      props.onClose();
    } finally {
      props.setBusy(false);
    }
  };

  return (
    <Modal
      title="立即备份"
      onClose={props.onClose}
      footer={
        <>
          <button className={btnGhost} onClick={props.onClose}>
            取消
          </button>
          <button className={btnPrimary} disabled={props.busy || selected.size === 0} onClick={() => void submit()}>
            {props.busy ? "备份中…" : "开始备份"}
          </button>
        </>
      }
    >
      <p className="text-xs text-neutral-500">选择要快照的存档范围（整目录复制，含子目录）。</p>
      <div className="mt-3 space-y-2">
        {props.root.exists && (
          <label className="flex items-center gap-2.5 rounded-lg border border-neutral-800 px-3 py-2.5 hover:border-neutral-700">
            <input type="checkbox" className="h-4 w-4 accent-violet-500" checked={selected.has("root")} onChange={() => toggle("root")} />
            <span className="text-sm text-neutral-100">主存档</span>
            <span className="ml-auto text-xs text-neutral-500">{props.root.files.length} 文件 · {formatBytes(props.root.totalBytes)}</span>
          </label>
        )}
        {props.mods.map((m) => (
          <label key={m.slot} className="flex items-center gap-2.5 rounded-lg border border-neutral-800 px-3 py-2.5 hover:border-neutral-700">
            <input type="checkbox" className="h-4 w-4 accent-violet-500" checked={selected.has(m.slot)} onChange={() => toggle(m.slot)} />
            <span className="text-sm text-neutral-100">{m.name}</span>
            <span className="ml-auto text-xs text-neutral-500">{m.files.length} 文件 · {formatBytes(m.totalBytes)}</span>
          </label>
        ))}
      </div>
      <input
        className="mt-3 w-full rounded-lg border border-neutral-700 bg-[#11141b] px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600"
        placeholder="备注（可选）"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
    </Modal>
  );
}

function RestoreDialog(props: {
  meta: BackupMetaView;
  busy: boolean;
  setBusy: (b: boolean) => void;
  setError: (e: string | null) => void;
  onClose: () => void;
  onDone: (preRestoreId: string | null) => void;
}) {
  // step 1: what will happen; step 2: final confirm
  const [step, setStep] = useState<1 | 2>(1);
  const [error, setErrorLocal] = useState<string | null>(null);

  const submit = async () => {
    props.setBusy(true);
    setErrorLocal(null);
    try {
      const r = await invoke("d2r:restoreBackup", { id: props.meta.id });
      props.onDone(r.preRestoreId);
    } catch (err) {
      setErrorLocal(errMsg(err)); // e.g. 游戏运行中 — shown in-modal
      props.setBusy(false);
    }
  };

  return (
    <Modal
      title={`还原快照 · ${formatTime(props.meta.createdAt)}`}
      onClose={props.onClose}
      footer={
        step === 1 ? (
          <>
            <button className={btnGhost} onClick={props.onClose}>
              取消
            </button>
            <button className={btnPrimary} onClick={() => setStep(2)}>
              下一步
            </button>
          </>
        ) : (
          <>
            <button className={btnGhost} onClick={() => setStep(1)}>
              ← 上一步
            </button>
            <button className={btnPrimary} disabled={props.busy} onClick={() => void submit()}>
              {props.busy ? "还原中…" : "确认还原"}
            </button>
          </>
        )
      }
    >
      {step === 1 ? (
        <div className="space-y-3 text-sm">
          <p>
            将把以下范围还原为该快照的内容：
            <span className="ml-1 inline-flex flex-wrap gap-1 align-middle">
              {props.meta.scopes.map((s) => (
                <span key={s.slot} className="rounded bg-neutral-800/70 px-1.5 py-0.5 text-xs text-neutral-200">
                  {slotLabel(s.slot)}
                </span>
              ))}
            </span>
          </p>
          <ul className="list-disc space-y-1 pl-5 text-xs text-neutral-400">
            <li>镜像还原：目标目录先清空再拷入快照（主存档的 mods\ 子目录不受影响）。</li>
            <li>还原前会自动备份当前状态（“还原前”快照），随时可再还原回来。</li>
          </ul>
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3.5 py-3 text-red-300">
            最终确认：游戏运行中无法还原。还原会覆盖所选范围的当前存档，请确保已了解将回退的内容。
          </div>
          {props.meta.note && <p className="text-xs text-neutral-400">快照备注：{props.meta.note}</p>}
        </div>
      )}
      {error && <p className="mt-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p>}
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function Banner(props: { tone: "red" | "green"; text: string; onClose: () => void }) {
  const cls =
    props.tone === "red"
      ? "border-red-500/30 bg-red-500/10 text-red-300"
      : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300";
  return (
    <div className={`flex items-center justify-between gap-3 rounded-xl border px-4 py-2.5 text-sm ${cls}`}>
      <span className="min-w-0 break-all">{props.text}</span>
      <button className="shrink-0 opacity-60 transition-opacity hover:opacity-100" onClick={props.onClose}>
        ✕
      </button>
    </div>
  );
}
