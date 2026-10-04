/**
 * Toolbox shell: fixed left nav switching between tools (M1: Mod 管理 +
 * 设置; M2: 存档管家 + 仓库向导). Config is loaded once here and passed
 * down with a refresh handle.
 */
import { useState } from "react";
import { useCommand } from "./lib/ipc";
import type { AppConfigView } from "./lib/types";
import { ModManagerPage } from "./tools/ModManager/ModManagerPage";
import { SettingsPage } from "./tools/SettingsPage";
import { SavesPage } from "./tools/SavesPage";
import { VaultPage } from "./tools/VaultPage";
import { FilterPage } from "./tools/FilterPage/FilterPage";
import { ItemPage } from "./tools/ItemPage";
import { HealthPage } from "./tools/HealthPage";
import { StorePage } from "./tools/StorePage/StorePage";
import { ExitGuardWatcher } from "./components/ExitGuardWatcher";

type TabId = "mods" | "store" | "saves" | "vault" | "items" | "filter" | "health" | "settings";

const TABS: { id: TabId; label: string; hint: string }[] = [
  { id: "mods", label: "Mod 管理", hint: "整合包扫描 / 安装 / 启动" },
  { id: "store", label: "Mod 库", hint: "在线清单 / zip 导入 / 更新" },
  { id: "saves", label: "存档管家", hint: "快照备份 / 一键还原" },
  { id: "vault", label: "仓库向导", hint: "共享仓库 .d2i 替换" },
  { id: "items", label: "物品清单", hint: "仓库/角色浏览与搜索" },
  { id: "filter", label: "过滤管理", hint: "掉落过滤预设" },
  { id: "health", label: "环境体检", hint: "一键体检 / 修复指引" },
  { id: "settings", label: "设置", hint: "游戏目录 / 来源" },
];

export default function App() {
  const [tab, setTab] = useState<TabId>("mods");
  const config = useCommand("d2r:getConfig", {});

  if (config.error) {
    return (
      <Centered>
        <p className="text-red-400">后端连接失败：{config.error}</p>
        <button className={btnGhost} onClick={config.refresh}>
          重试
        </button>
      </Centered>
    );
  }
  if (!config.data) {
    return <Centered><p className="animate-pulse text-neutral-500">加载中…</p></Centered>;
  }

  const cfg = config.data.config;
  const validation = config.data.validation;

  return (
    <div className="flex h-screen bg-[#0a0c10] text-neutral-100">
      <aside className="flex w-52 shrink-0 flex-col border-r border-neutral-800/80 bg-[#0d1017]">
        <div className="px-5 py-5">
          <h1 className="text-base font-bold tracking-wide">D2R 工具箱</h1>
          <p className="mt-0.5 text-[11px] text-neutral-500">Horadric Kit · M9</p>
        </div>
        <nav className="flex-1 space-y-1 px-3">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`w-full rounded-lg px-3 py-2 text-left transition-colors ${
                tab === t.id
                  ? "bg-violet-500/15 text-violet-300"
                  : "text-neutral-400 hover:bg-neutral-800/50 hover:text-neutral-200"
              }`}
            >
              <span className="block text-sm font-medium">{t.label}</span>
              <span className="block text-[11px] text-neutral-600">{t.hint}</span>
            </button>
          ))}
        </nav>
        <div className="border-t border-neutral-800/60 px-5 py-3 text-[11px] text-neutral-600">
          {cfg.gameDir ? (
            <span className="block truncate" title={cfg.gameDir}>
              游戏：{cfg.gameDir}
            </span>
          ) : (
            <span className="text-amber-500">未设置游戏目录</span>
          )}
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        {!cfg.gameDir && tab !== "settings" && (
          <div className="flex shrink-0 items-center justify-between border-b border-amber-500/30 bg-amber-500/10 px-6 py-2.5 text-sm text-amber-300">
            <span>尚未设置游戏目录，Mod 管理暂不可用。</span>
            <button className={btnGhost} onClick={() => setTab("settings")}>
              去设置 →
            </button>
          </div>
        )}
        {validation && !validation.hasD2R && tab !== "settings" && (
          <div className="flex shrink-0 items-center justify-between border-b border-red-500/30 bg-red-500/10 px-6 py-2.5 text-sm text-red-300">
            <span>游戏目录下找不到 D2R.exe，请检查设置。</span>
            <button className={btnGhost} onClick={() => setTab("settings")}>
              去设置 →
            </button>
          </div>
        )}
        {/* 外壳永不整体滚动：七个页面全部自管布局（页头固定+页内滚动，滚动容器通栏到窗体右缘，滚动条贴边） */}
        <div className="min-h-0 flex-1 overflow-hidden">
          {tab === "items" && <ItemPage />}
          {tab === "saves" && <SavesPage config={cfg} refreshConfig={config.refresh} />}
          {tab === "filter" && <FilterPage config={cfg} goToSettings={() => setTab("settings")} />}
          {tab === "mods" && (
            <ModManagerPage
              config={cfg}
              refreshConfig={config.refresh}
              goToSettings={() => setTab("settings")}
            />
          )}
          {tab === "store" && <StorePage config={cfg} goToSettings={() => setTab("settings")} />}
          {tab === "vault" && <VaultPage goToSaves={() => setTab("saves")} />}
          {tab === "health" && <HealthPage config={cfg} goToSettings={() => setTab("settings")} />}
          {tab === "settings" && (
            <SettingsPage
              config={cfg}
              validation={validation}
              refreshConfig={config.refresh}
            />
          )}
        </div>
      </main>

      {/* 全局：游戏退出后的存档守护提醒（丢失 → 模态窗一键还原；变化 → 轻提示） */}
      <ExitGuardWatcher />
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3 bg-[#0a0c10] text-neutral-100">
      {children}
    </div>
  );
}

export const btnGhost =
  "rounded-lg border border-neutral-700 px-3 py-1.5 text-sm text-neutral-200 transition-colors hover:border-neutral-500 hover:bg-neutral-800/60";
