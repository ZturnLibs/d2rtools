/**
 * Mod 管理 page: sources → mod cards grouped by variant → profiles.
 * Owns uninstall preflight, readme viewer, launch notices.
 */
import { useEffect, useMemo, useState } from "react";
import { invoke, useCommand, errMsg } from "../../lib/ipc";
import { b64ToBytes, decodeText } from "../../lib/decode";
import { Modal } from "../../components/Modal";
import { btnGhost } from "../../App";
import type { AppConfigView, ModInfo, ProfileView } from "../../lib/types";
import { SourceList } from "./SourceList";
import { ModCard } from "./ModCard";
import { InstallDialog } from "./InstallDialog";
import { ProfileBar } from "./ProfileBar";
import { ParamHelp } from "./ParamHelp";

interface Preflight {
  installed: boolean;
  savepath: string | null;
  usesRootSaves: boolean;
  saveDir: string | null;
  saveDirExists: boolean;
}

export function ModManagerPage(props: {
  config: AppConfigView;
  refreshConfig: () => void;
  goToSettings: () => void;
}) {
  const { config } = props;
  const mods = useCommand("d2r:listMods", {});
  const [installTarget, setInstallTarget] = useState<ModInfo | null>(null);
  const [uninstallTarget, setUninstallTarget] = useState<{ mod: ModInfo; preflight: Preflight } | null>(null);
  const [readme, setReadme] = useState<{ mod: ModInfo; text: string; encoding: string } | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [scanWarnings, setScanWarnings] = useState<string[]>([]);

  // Re-pull install state whenever knownMods change (after scan/remove).
  useEffect(() => {
    mods.refresh();
  }, [config.knownMods]);

  const grouped = useMemo(() => {
    const map = new Map<string, ModInfo[]>();
    for (const m of mods.data?.mods ?? []) {
      const list = map.get(m.variant) ?? [];
      list.push(m);
      map.set(m.variant, list);
    }
    return [...map.entries()];
  }, [mods.data]);

  async function launch(modName: string, extraArgs: string[]) {
    setError("");
    setNotice("");
    try {
      const res = await invoke("d2r:launch", { modName, extraArgs });
      setNotice(`已启动 D2R.exe（pid ${res.pid}）：-mod ${modName} ${extraArgs.join(" ")}`);
    } catch (err) {
      setError(errMsg(err));
    }
  }

  async function askUninstall(mod: ModInfo) {
    setError("");
    try {
      const preflight = await invoke("d2r:uninstallPreflight", { name: mod.name });
      setUninstallTarget({ mod, preflight });
    } catch (err) {
      setError(errMsg(err));
    }
  }

  async function confirmUninstall() {
    if (!uninstallTarget) return;
    setError("");
    try {
      await invoke("d2r:uninstallMod", { name: uninstallTarget.mod.name });
      setUninstallTarget(null);
      mods.refresh();
      props.refreshConfig();
      setNotice(`已卸载 ${uninstallTarget.mod.name}（存档未动）`);
    } catch (err) {
      setError(errMsg(err));
    }
  }

  async function showReadme(mod: ModInfo) {
    if (!mod.readmePath) return;
    setError("");
    try {
      const res = await invoke("d2r:readTextB64", { path: mod.readmePath });
      if (!res.b64) {
        setError("说明文件为空或过大");
        return;
      }
      const { text, encoding } = decodeText(b64ToBytes(res.b64));
      setReadme({ mod, text, encoding });
    } catch (err) {
      setError(errMsg(err));
    }
  }

  async function saveProfiles(profiles: ProfileView[]) {
    setError("");
    try {
      await invoke("d2r:saveProfiles", { profiles });
      props.refreshConfig();
    } catch (err) {
      setError(errMsg(err));
    }
  }

  if (!config.gameDir) {
    return (
      <div className="mx-auto mt-16 max-w-md text-center">
        <p className="text-sm text-neutral-400">先设置游戏目录，才能安装和启动 MOD。</p>
        <button className={btnGhost + " mt-3"} onClick={props.goToSettings}>
          去设置 →
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Mod 管理</h2>
          <p className="text-xs text-neutral-500">
            登记整合包目录 → 扫描变体 → 安装到游戏 mods\ → 按正确参数启动。
          </p>
        </div>
        <button className={btnGhost} onClick={() => setHelpOpen(true)}>
          参数知识库
        </button>
      </div>

      <SourceList sources={config.sources} onChanged={props.refreshConfig} onWarnings={setScanWarnings} />

      {scanWarnings.length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-300">
          <div className="mb-1 font-semibold">扫描提示</div>
          <ul className="list-inside list-disc space-y-0.5">
            {scanWarnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
          <button className="mt-1 text-neutral-400 hover:text-neutral-200" onClick={() => setScanWarnings([])}>
            知道了
          </button>
        </div>
      )}

      <ProfileBar
        profiles={config.profiles}
        mods={mods.data?.mods ?? []}
        onLaunchProfile={(p) => void launch(p.modName, p.extraArgs)}
        onSaveProfiles={saveProfiles}
      />

      {(notice || error) && (
        <div className={`rounded-lg border px-4 py-2 text-sm ${error ? "border-red-500/30 bg-red-500/10 text-red-300" : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"}`}>
          <span>{error || notice}</span>
          <button className="ml-3 text-xs text-neutral-400 hover:text-neutral-200" onClick={() => { setNotice(""); setError(""); }}>
            关闭
          </button>
        </div>
      )}

      {mods.loading && <p className="text-sm text-neutral-500">读取 MOD 状态…</p>}
      {mods.error && <p className="text-sm text-red-400">{mods.error}</p>}

      {grouped.length === 0 && !mods.loading && (
        <div className="mx-auto mt-10 max-w-md rounded-2xl border border-dashed border-neutral-800 p-8 text-center text-sm text-neutral-500">
          还没有 MOD——点上方「添加整合包目录」登记术士君临的文件夹（游戏目录本身也可以，工具会自动跳过已安装区）。
        </div>
      )}

      {grouped.map(([variant, list]) => (
        <section key={variant || "_"} className="space-y-2">
          {variant && <h3 className="text-xs font-semibold tracking-wide text-neutral-500">{variant}</h3>}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
            {list.map((m) => (
              <ModCard
                key={m.key}
                mod={m}
                installed={mods.data?.installed[m.name] ?? false}
                record={config.installed[m.name]}
                suggestedArgs={mods.data?.suggestedArgs[m.name] ?? ["-mod", m.name]}
                onInstall={() => setInstallTarget(m)}
                onUninstall={() => void askUninstall(m)}
                onLaunch={(args) => void launch(m.name, args.slice(2))}
                onReadme={() => void showReadme(m)}
                onOpenDir={() => void invoke("d2r:openDir", { path: m.sourcePath })}
              />
            ))}
          </div>
        </section>
      ))}

      {installTarget && (
        <InstallDialog
          mod={installTarget}
          installed={mods.data?.installed[installTarget.name] ?? false}
          onClose={() => setInstallTarget(null)}
          onDone={() => {
            mods.refresh();
            props.refreshConfig();
          }}
        />
      )}

      {uninstallTarget && (
        <Modal
          title={`卸载 ${uninstallTarget.mod.displayName ?? uninstallTarget.mod.name}`}
          onClose={() => setUninstallTarget(null)}
          footer={
            <>
              <button className={btnGhost} onClick={() => setUninstallTarget(null)}>
                取消
              </button>
              <button
                className="rounded-lg bg-red-500/90 px-4 py-1.5 text-sm font-semibold text-white hover:bg-red-500"
                onClick={() => void confirmUninstall()}
              >
                确认卸载（不动存档）
              </button>
            </>
          }
        >
          <div className="space-y-2 text-sm">
            <p>
              将删除游戏目录下的 <code className="text-cyan-300">mods\{uninstallTarget.mod.name}</code>。
            </p>
            {uninstallTarget.preflight.usesRootSaves ? (
              <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                该 MOD 的 savepath 指向主存档（Saved Games\Diablo II Resurrected）——卸载<b>不会删除任何存档</b>，但重装前游戏会继续读写主存档。
              </p>
            ) : uninstallTarget.preflight.saveDir ? (
              <p className="text-xs text-neutral-400">
                独立存档目录：<code className="text-cyan-300">{uninstallTarget.preflight.saveDir}</code>
                {uninstallTarget.preflight.saveDirExists ? "（已存在，将保留）" : "（尚未生成）"}
              </p>
            ) : null}
          </div>
        </Modal>
      )}

      {readme && (
        <Modal wide title={`说明 · ${readme.mod.displayName ?? readme.mod.name}`} onClose={() => setReadme(null)}>
          <p className="mb-2 text-[11px] text-neutral-600">编码：{readme.encoding}</p>
          <pre className="whitespace-pre-wrap font-mono text-xs leading-5 text-neutral-300">{readme.text}</pre>
        </Modal>
      )}

      {helpOpen && (
        <Modal wide title="启动参数知识库" onClose={() => setHelpOpen(false)}>
          <ParamHelp />
        </Modal>
      )}
    </div>
  );
}
