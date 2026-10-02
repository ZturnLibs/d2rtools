/**
 * Registered pack-source bar: add via native folder picker (PowerShell
 * FolderBrowserDialog), per-source rescan/remove, scan warnings.
 */
import { useState } from "react";
import { invoke, errMsg } from "../../lib/ipc";
import type { SourceView } from "../../lib/types";

export function SourceList(props: {
  sources: SourceView[];
  onChanged: () => void;
  onWarnings: (warnings: string[]) => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function add() {
    setError("");
    try {
      const picked = await invoke("d2r:pickFolder", { title: "选择整合包根目录（含 mods\\ 或其上层均可）" });
      if (!picked.path) return;
      const { source } = await invoke("d2r:addSource", { path: picked.path });
      await rescan(source.id);
    } catch (err) {
      setError(errMsg(err));
    }
  }

  async function rescan(id: string) {
    setError("");
    setBusyId(id);
    try {
      const res = await invoke("d2r:scanSource", { id });
      props.onWarnings(res.warnings);
      props.onChanged();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusyId(null);
    }
  }

  async function remove(id: string) {
    setError("");
    setBusyId(id);
    try {
      await invoke("d2r:removeSource", { id });
      setConfirmId(null);
      props.onWarnings([]);
      props.onChanged();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-neutral-500">整合包来源：</span>
        {props.sources.map((s) => (
          <span
            key={s.id}
            className="inline-flex items-center gap-2 rounded-lg border border-neutral-800 bg-[#11141b] px-2.5 py-1 text-xs"
            title={s.path}
          >
            <span className="max-w-48 truncate font-medium text-neutral-300">{s.label}</span>
            <button
              className="text-neutral-500 transition-colors hover:text-neutral-200 disabled:opacity-40"
              disabled={busyId !== null}
              onClick={() => void rescan(s.id)}
            >
              {busyId === s.id ? "扫描中…" : "重扫"}
            </button>
            {confirmId === s.id ? (
              <button className="text-red-400 hover:text-red-300" onClick={() => void remove(s.id)}>
                确认删除?
              </button>
            ) : (
              <button
                className="text-neutral-500 transition-colors hover:text-red-400 disabled:opacity-40"
                disabled={busyId !== null}
                onClick={() => setConfirmId(s.id)}
              >
                删除
              </button>
            )}
          </span>
        ))}
        <button
          className="rounded-lg border border-dashed border-neutral-700 px-3 py-1 text-xs text-neutral-400 transition-colors hover:border-neutral-500 hover:text-neutral-200 disabled:opacity-40"
          disabled={busyId !== null}
          onClick={() => void add()}
        >
          + 添加整合包目录
        </button>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
