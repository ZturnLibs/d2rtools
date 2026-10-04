/** One mod variant card: identity, save badge, install state, actions. */
import type { AppConfigView, ModInfo } from "../../lib/types";

export type UpdateStateView = NonNullable<AppConfigView["updateState"][string]>;

export function ModCard(props: {
  mod: ModInfo;
  installed: boolean;
  record: AppConfigView["installed"][string] | undefined;
  suggestedArgs: string[];
  sizeHint?: string;
  scriptsCount?: number;
  updateState?: UpdateStateView | null;
  updateChecking?: boolean;
  onInstall: () => void;
  onUninstall: () => void;
  onLaunch: (args: string[]) => void;
  onReadme: () => void;
  onOpenDir: () => void;
  onScripts?: () => void;
  onCheckUpdate?: () => void;
  onApplyUpdate?: () => void;
}) {
  const { mod, installed, record, suggestedArgs, updateState } = props;
  const title = mod.displayName ? `${mod.displayName}（${mod.name}）` : mod.name;
  const shared = mod.savepath.trim() === "../";
  const ext = mod.sourceId === "external";

  return (
    <div className="flex flex-col rounded-xl border border-neutral-800 bg-[#11141b] p-4 transition-colors hover:border-neutral-700">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-neutral-100" title={title}>
            {title}
          </h3>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
            {mod.variant && <Chip>{mod.variant}</Chip>}
            <Chip tone={shared ? "amber" : "cyan"}>{shared ? "共用主存档" : `独立存档 ${mod.savepath}`}</Chip>
            {installed && (
              <Chip tone="green">
                已安装{record ? (record.mode === "hardlink" ? " · 硬链接" : " · 复制") : ""}
              </Chip>
            )}
            {(props.scriptsCount ?? 0) > 0 && <Chip tone="cyan">作者脚本 ×{props.scriptsCount}</Chip>}
            {updateState?.supported && !updateState.error && (
              <Chip tone={updateState.hasUpdate ? "amber" : "green"}>
                {updateState.hasUpdate
                  ? `可更新 ${updateState.localVersion ?? "?"} → ${updateState.remoteVersion ?? "?"}`
                  : `已是最新${updateState.localVersion ? ` ${updateState.localVersion}` : ""}`}
              </Chip>
            )}
            {updateState?.error && (
              <Chip tone="amber" title={updateState.error}>
                更新源异常
              </Chip>
            )}
          </div>
        </div>
        {props.sizeHint && <span className="shrink-0 text-[11px] text-neutral-600">{props.sizeHint}</span>}
      </div>

      <div className="mt-3 rounded-md bg-neutral-900/70 px-2.5 py-1.5 font-mono text-[11px] text-neutral-400">
        建议参数：{suggestedArgs.join(" ")}
      </div>
      {mod.parseWarning && (
        <p className="mt-2 text-[11px] text-amber-500/90" title={mod.parseWarning}>
          ⚠ {mod.parseWarning}
        </p>
      )}
      {updateState?.error && (
        <p className="mt-2 text-[11px] text-amber-500/90" title={updateState.error}>
          ⚠ 更新检查失败：{updateState.error}
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-1.5 border-t border-neutral-800/60 pt-3">
        {installed ? (
          <>
            <Btn primary onClick={() => props.onLaunch(suggestedArgs)}>
              ▶ 启动
            </Btn>
            <Btn onClick={props.onUninstall}>卸载</Btn>
          </>
        ) : (
          <Btn primary onClick={props.onInstall}>
            安装
          </Btn>
        )}
        {installed && (
          <Btn onClick={props.onCheckUpdate} disabled={props.updateChecking}>
            {props.updateChecking ? "检查中…" : "检查更新"}
          </Btn>
        )}
        {installed && updateState?.hasUpdate && updateState.downloadUrl && (
          <Btn primary tone="upgrade" onClick={props.onApplyUpdate}>
            ↑ 升级
          </Btn>
        )}
        {ext && (
          <span className="self-center text-[11px] text-neutral-600" title="该 mod 不在已登记来源中（zip 导入或手动拷贝），卸载后需重新导入">
            外部 mod
          </span>
        )}
        {mod.readmePath && <Btn onClick={props.onReadme}>说明</Btn>}
        {(props.scriptsCount ?? 0) > 0 && <Btn onClick={() => props.onScripts?.()}>脚本</Btn>}
        <Btn onClick={props.onOpenDir}>打开目录</Btn>
      </div>
    </div>
  );
}

function Chip(props: { children: React.ReactNode; tone?: "cyan" | "amber" | "green"; title?: string }) {
  const tones = {
    cyan: "border-cyan-500/30 bg-cyan-500/10 text-cyan-300",
    amber: "border-amber-500/30 bg-amber-500/10 text-amber-300",
    green: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  } as const;
  return (
    <span
      title={props.title}
      className={`rounded border px-1.5 py-0.5 ${props.tone ? tones[props.tone] : "border-neutral-700 bg-neutral-800/60 text-neutral-400"}`}
    >
      {props.children}
    </span>
  );
}

function Btn(props: {
  children: React.ReactNode;
  onClick?: () => void;
  primary?: boolean;
  tone?: "upgrade";
  disabled?: boolean;
}) {
  const cls = props.disabled
    ? "rounded-lg border border-neutral-800 px-3 py-1 text-xs text-neutral-600"
    : props.primary && props.tone === "upgrade"
      ? "rounded-lg bg-amber-400 px-3 py-1 text-xs font-semibold text-neutral-950 transition-transform active:translate-y-px hover:bg-amber-300"
      : props.primary
        ? "rounded-lg bg-neutral-100 px-3 py-1 text-xs font-semibold text-neutral-950 transition-transform active:translate-y-px"
        : "rounded-lg border border-neutral-700 px-3 py-1 text-xs text-neutral-300 transition-colors hover:border-neutral-500 hover:bg-neutral-800/60";
  return (
    <button onClick={props.onClick} disabled={props.disabled} className={cls}>
      {props.children}
    </button>
  );
}
