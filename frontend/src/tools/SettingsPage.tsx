/**
 * Settings: game dir (typed or picked), validation feedback, sources
 * overview. Saving auto-creates <game>\mods and persists to config.
 */
import { useState } from "react";
import { invoke, errMsg } from "../lib/ipc";
import { formatTime } from "../lib/decode";
import { APP_VERSION } from "../../../src/services/config.js";
import type { AppConfigView, ValidationView } from "../lib/types";

// ztron 库版本（只取 package.json 静态数据——tjs 无可查询的运行时版本）。
// 这些包的 exports 没放 ./package.json 子路径，所以走相对路径进 node_modules。
import corePkg from "../../../node_modules/@zturnlibs/ztron-core/package.json";
import reactPkg from "../../../node_modules/@zturnlibs/ztron-react/package.json";
import ffiPkg from "../../../node_modules/@zturnlibs/ztron-runtime-ffi/package.json";
const ZTRON_VERSIONS = {
  core: corePkg.version,
  react: reactPkg.version,
  ffi: ffiPkg.version,
} as const;

const inputCls =
  "w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-neutral-500";

export function SettingsPage(props: {
  config: AppConfigView;
  validation: ValidationView | null;
  refreshConfig: () => void;
}) {
  const [gameDir, setGameDir] = useState(props.config.gameDir ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<ValidationView | null>(props.validation);

  async function browse() {
    setError("");
    try {
      const res = await invoke("d2r:pickFolder", { title: "选择 D2R 游戏目录（D2R.exe 所在目录）" });
      if (res.path) setGameDir(res.path);
    } catch (err) {
      setError(errMsg(err));
    }
  }

  async function save() {
    setError("");
    setBusy(true);
    try {
      const res = await invoke("d2r:setGameDir", { gameDir });
      setSaved(res.validation);
      props.refreshConfig();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    /* 无独立页头：整页内滚；滚动容器通栏到窗体右缘，滚动条贴边 */
    <div className="h-full min-w-0 overflow-y-auto px-6 pb-6 pt-6">
      <div className="mx-auto max-w-2xl space-y-6">
      <section>
        <h2 className="mb-1 text-base font-semibold">游戏目录</h2>
        <p className="mb-3 text-xs text-neutral-500">
          D2R.exe 所在目录。路径含中文 / 特殊字符没有问题，工具用数组方式传参。
        </p>
        <div className="flex gap-2">
          <input
            className={inputCls}
            value={gameDir}
            onChange={(e) => setGameDir(e.target.value)}
            placeholder="例如 D:\Games\Diablo II Resurrected – Infernal Edition"
          />
          <button className="shrink-0 rounded-lg border border-neutral-700 px-3 text-sm hover:bg-neutral-800/60" onClick={() => void browse()}>
            浏览…
          </button>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <button
            className="rounded-lg bg-neutral-100 px-4 py-1.5 text-sm font-semibold text-neutral-950 transition-transform active:translate-y-px disabled:opacity-50"
            disabled={busy || !gameDir.trim()}
            onClick={() => void save()}
          >
            {busy ? "保存中…" : "保存并校验"}
          </button>
          {saved && (
            <span className="text-xs text-neutral-400">
              {saved.exists ? "目录 ✓" : "目录 ✗"} · {saved.hasD2R ? "D2R.exe ✓" : "D2R.exe ✗"} ·{" "}
              {saved.hasModsDir ? "mods\\ ✓" : "mods\\ 待创建"}
            </span>
          )}
        </div>
        {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
      </section>

      <section>
        <h2 className="mb-2 text-base font-semibold">已登记的整合包来源（{props.config.sources.length}）</h2>
        <div className="space-y-2">
          {props.config.sources.length === 0 && (
            <p className="text-sm text-neutral-500">还没有来源——去「Mod 管理」页添加整合包目录。</p>
          )}
          {props.config.sources.map((s) => (
            <div key={s.id} className="rounded-lg border border-neutral-800 bg-[#11141b] px-4 py-2.5">
              <div className="text-sm font-medium text-neutral-200">{s.label}</div>
              <div className="truncate text-xs text-neutral-500" title={s.path}>
                {s.path}
              </div>
              <div className="text-[11px] text-neutral-600">登记于 {formatTime(s.addedAt)}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="border-t border-neutral-800/60 pt-4 text-xs text-neutral-600">
        <h2 className="mb-2 text-base font-semibold text-neutral-200">关于</h2>
        <p>
          D2R 工具箱 {APP_VERSION} · com.zyj.d2rbox
          · ztron {ZTRON_VERSIONS.core}（react {ZTRON_VERSIONS.react} / runtime-ffi {ZTRON_VERSIONS.ffi}）
        </p>
        <p className="mt-1">存档根目录：%UserProfile%\Saved Games\Diablo II Resurrected</p>
      </section>
      </div>
    </div>
  );
}
