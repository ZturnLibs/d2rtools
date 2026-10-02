/**
 * Launch-profile bar: create/select profiles (one mod + extra args), launch,
 * export a desktop .lnk. Profile = the "don't make me remember the args" fix.
 */
import { useState } from "react";
import { invoke, errMsg } from "../../lib/ipc";
import type { ModInfo, ProfileView } from "../../lib/types";

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const inputCls =
  "w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm outline-none focus:border-neutral-500";

export function ProfileBar(props: {
  profiles: ProfileView[];
  mods: ModInfo[];
  onLaunchProfile: (p: ProfileView) => void;
  onSaveProfiles: (profiles: ProfileView[]) => Promise<void>;
}) {
  const [editing, setEditing] = useState<ProfileView | "new" | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  async function exportShortcut(p: ProfileView) {
    setError("");
    setNotice("");
    try {
      const res = await invoke("d2r:exportShortcut", {
        name: p.name,
        modName: p.modName,
        extraArgs: p.extraArgs,
      });
      setNotice(`快捷方式已导出：${res.lnkPath}`);
    } catch (err) {
      setError(errMsg(err));
    }
  }

  async function save(p: ProfileView) {
    const next = props.profiles.filter((x) => x.id !== p.id).concat(p);
    next.sort((a, b) => a.createdAt - b.createdAt);
    await props.onSaveProfiles(next);
    setEditing(null);
  }

  return (
    <div className="rounded-xl border border-neutral-800 bg-[#0d1017] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-neutral-500">启动配置档：</span>
        {props.profiles.length === 0 && (
          <span className="text-xs text-neutral-600">还没有配置档——建一个，以后双击就能按正确参数开荒。</span>
        )}
        {props.profiles.map((p) => (
          <span key={p.id} className="inline-flex items-center gap-2 rounded-lg border border-neutral-800 bg-[#11141b] px-2.5 py-1 text-xs">
            <button
              className="max-w-44 truncate font-medium text-neutral-200 transition-colors hover:text-violet-300"
              title={`${p.modName} ${p.extraArgs.join(" ")}${p.note ? `\n${p.note}` : ""}`}
              onClick={() => props.onLaunchProfile(p)}
            >
              ▶ {p.name}
            </button>
            <button className="text-neutral-500 hover:text-neutral-200" onClick={() => setEditing(p)}>
              编辑
            </button>
            <button className="text-neutral-500 hover:text-neutral-200" onClick={() => void exportShortcut(p)}>
              导出快捷方式
            </button>
            <button
              className="text-neutral-500 hover:text-red-400"
              onClick={() => void props.onSaveProfiles(props.profiles.filter((x) => x.id !== p.id))}
            >
              ✕
            </button>
          </span>
        ))}
        <button
          className="rounded-lg border border-dashed border-neutral-700 px-3 py-1 text-xs text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
          onClick={() => setEditing("new")}
        >
          + 新建配置档
        </button>
      </div>
      {notice && (
        <p className="mt-2 truncate text-xs text-emerald-400" title={notice}>
          {notice}
        </p>
      )}
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      {editing && (
        <ProfileEditor
          profile={editing === "new" ? null : editing}
          mods={props.mods}
          onCancel={() => setEditing(null)}
          onSave={(p) => void save(p)}
        />
      )}
    </div>
  );
}

function ProfileEditor(props: {
  profile: ProfileView | null;
  mods: ModInfo[];
  onCancel: () => void;
  onSave: (p: ProfileView) => void;
}) {
  const [name, setName] = useState(props.profile?.name ?? "");
  const [modName, setModName] = useState(props.profile?.modName ?? props.mods[0]?.name ?? "");
  const [argsText, setArgsText] = useState(props.profile?.extraArgs.join(" ") ?? "");
  const [note, setNote] = useState(props.profile?.note ?? "");
  const parsedArgs = argsText.split(/\s+/).filter(Boolean);

  return (
    <div className="mt-3 space-y-2 rounded-lg border border-neutral-800 bg-neutral-900/50 p-3">
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs text-neutral-400">
          名称
          <input className={inputCls + " mt-1"} value={name} onChange={(e) => setName(e.target.value)} placeholder="如：EJ 开荒" />
        </label>
        <label className="text-xs text-neutral-400">
          MOD（建议选已安装的）
          <select className={inputCls + " mt-1"} value={modName} onChange={(e) => setModName(e.target.value)}>
            {props.mods.map((m) => (
              <option key={m.key} value={m.name}>
                {m.displayName ? `${m.displayName}（${m.name}）` : m.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="block text-xs text-neutral-400">
        附加参数（空格分隔，例如：-txt -w）
        <input className={inputCls + " mt-1 font-mono"} value={argsText} onChange={(e) => setArgsText(e.target.value)} placeholder="-txt -w" />
      </label>
      <label className="block text-xs text-neutral-400">
        备注
        <input className={inputCls + " mt-1"} value={note} onChange={(e) => setNote(e.target.value)} placeholder="可空" />
      </label>
      <div className="flex items-center justify-between">
        <span className="font-mono text-[11px] text-neutral-500">
          D2R.exe -mod {modName || "?"} {parsedArgs.join(" ")}
        </span>
        <div className="flex gap-2">
          <button className="rounded-lg border border-neutral-700 px-3 py-1 text-xs hover:bg-neutral-800/60" onClick={props.onCancel}>
            取消
          </button>
          <button
            className="rounded-lg bg-neutral-100 px-3 py-1 text-xs font-semibold text-neutral-950 disabled:opacity-50"
            disabled={!name.trim() || !modName.trim()}
            onClick={() =>
              props.onSave({
                id: props.profile?.id ?? newId("prof"),
                name: name.trim(),
                modName: modName.trim(),
                extraArgs: parsedArgs,
                note: note.trim(),
                createdAt: props.profile?.createdAt ?? Date.now(),
              })
            }
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
