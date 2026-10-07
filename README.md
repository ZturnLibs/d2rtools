<div align="center">

<img src="icon/app-icon.png" alt="D2R 工具箱" width="128" />

# D2R 工具箱 · Horadric Kit

**面向中文 D2R 整合包玩家的桌面工具箱 —— 装 Mod、记参数、管存档、保仓库，一键直达游戏。**

[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-blue)](../../releases)
[![Version](https://img.shields.io/badge/version-0.2.0-orange)](ztron.conf.json)
[![Built with](https://img.shields.io/badge/built%20with-ztron%20·%20React%2019-7c3aed)](#技术架构)
[![Milestones](https://img.shields.io/badge/milestones-M1%E2%80%93M11%20%E2%9C%94-success)](#里程碑)
[![License](https://img.shields.io/badge/license-%E8%87%AA%E5%AE%9A%E4%B9%89%C2%B7%E5%95%86%E7%94%A8%E9%9C%80%E6%8E%88%E6%9D%83-red)](LICENSE.md)

</div>

---

## 这是什么

玩 D2R 中文整合包（如"术士君临"）时，总有一堆记不住的事：

- EJ 开荒版要加 `-txt`，VIPer 大型整合**不能**加 `-txt`……记错就白屏
- 每个变体一套启动参数，桌面快捷方式建了一排
- 换大仓库 `.d2i` 前忘了备份，几页仓库物品瞬间清空
- 作者提供的 bat 开关（掉落过滤 / 自动拾取）要切到对应目录手动跑，输出还全是 GBK 乱码

**D2R 工具箱把这一切装进一个 GUI**：扫描整合包仓库 → 识别 mod 与变体 → 正确参数一键启动 → 启动前自动备份存档 → 仓库替换有警告有回滚 → 作者脚本变成卡片上的按钮。

> 定位差异：[D2RMM](https://github.com/mysterionn/D2RMM) 面向 Nexus 英文 mod 的声明式合并；本工具面向中文整合包的 **"原始 MPQ + 启动参数 + 作者脚本"** 生态，管安装、启动、存档、配置开关，**不做 mod 内容合并**。

## 功能总览

| 工具 | 能力 |
|------|------|
| 🧰 **Mod 管理** | 整合包仓库扫描（自动识别 `modinfo.json` / MPQ、修正嵌套层级）· 卡片式变体列表 · 复制/硬链接两种安装方式 · 卸载前存档预检 · 启动配置档（Profile）+ 一键启动 + 桌面快捷方式导出 · 内置参数知识库（`-mod` / `-txt` / `-direct` / `-w` …） |
| 💾 **存档管家** | 按 savepath 分组的存档总览（主存档 ↔ 各 mod 独立存档）· 带时间戳的快照备份（可选范围 + 备注 + 自动清理旧份）· 一键还原（还原前自动再备一份当前状态）· **启动游戏前静默自动备份**（不阻塞启动）· 主存档 ↔ mod 存档之间的角色转移（copy / move） |
| 📦 **仓库向导** | 任何"用作者 `.d2i` 替换共享仓库"的操作泛化为三步向导：① 检测现有仓库非空 → 醒目警告 ② 自动备份现有 stash ③ 替换并可回滚 · 游戏运行中拒绝替换 |
| 🔌 **作者脚本** | 扫描 `mods\<mod>\` 下的作者 bat 脚本，变成 GUI 按钮 · 静态分析副作用（杀游戏进程 / 拉起游戏 / 有 pause）并显式提示 · GBK 输出实时转码流式显示 · 缺失目标文件预警 |

## 快速开始

### 环境要求

- Windows 10 / 11（依赖 WebView2 运行时，Win11 自带）
- Node.js ≥ 22 + pnpm
- 从源码构建额外需要：VS Build Tools（MSVC）、CMake、NSIS（打包用）—— 原生链可复用本地 ztron 仓库产物

### 开发

```bash
pnpm install        # 安装依赖（含 ztron-runtime-ffi 的 pnpm patch）
pnpm dev            # 启动桌面应用（Vite HMR 热更新前端）
pnpm typecheck      # TS 类型检查
```

> 注意：后端（`src/**`）修改需重启 `pnpm dev`，只有前端享受 HMR。
> 原生链（`tjs.exe` / `ztron-host.exe` / `webview.dll`）默认取自本地 ztron 仓库的 `native/libs`，可用 `ZTRON_NATIVE_LIBS` 环境变量重定向。

### 打包

```bash
pnpm build          # ztron build → dist/D2RBox/ + NSIS 安装包
```

产物：`dist/D2RBox/`（绿色版，含 `ztron-launcher.exe`）与 `dist/nsis/D2R工具箱_<版本>_setup.exe`（安装包，带赫拉迪克方块图标）。

## 技术架构

基于 **ztron** —— 一个 Tauri 式的全 TypeScript 桌面框架（TS 后端跑在 tjs/TxikiJS 运行时，Win32 原生 host + WebView2）：

```
┌─────────────────────────────────────────────────────┐
│  frontend/          React 19 + Tailwind v4 (Vite)   │
│  按工具组织路由：Mod管理 / 存档管家 / 仓库向导 / 设置   │
└──────────────────────┬──────────────────────────────┘
                       │  ztron commands（codegen 生成类型绑定）
┌──────────────────────▼──────────────────────────────┐
│  src/               TS 后端（tjs 运行时）             │
│  services/ 按领域拆分：scan · install · launch ·     │
│  saves · stash · authscripts · config · paths        │
└──────────────────────┬──────────────────────────────┘
                       │  tjs:fs / shell / dialog / channel
┌──────────────────────▼──────────────────────────────┐
│  原生层   ztron-host.exe (Win32) + webview.dll        │
│           D2R.exe 启动 · bat 子进程 · 文件操作         │
└─────────────────────────────────────────────────────┘
```

前端与后端之间共注册 **30 个 `d2r:*` 命令**（见 `src/commands.ts`），由 `ztron codegen` 生成端到端类型绑定；安装进度与脚本输出通过 **channel 流式推送**到前端。

### 项目结构

```
d2r-research/
├── src/                  # TS 后端
│   ├── commands.ts       # 全部 d2r:* 命令定义（参数/结果类型内联）
│   ├── main.ts           # 应用入口：窗口 + 命令注册
│   └── services/         # 按领域一个服务
│       ├── scan.ts       #   整合包仓库扫描（modinfo.json / MPQ 识别）
│       ├── install.ts    #   安装/卸载（复制 / 硬链接）+ 预检
│       ├── launch.ts     #   D2R.exe 启动 · .lnk 快捷方式导出
│       ├── saves.ts      #   存档总览 · 快照备份 · 还原 · 角色转移
│       ├── stash.ts      #   共享仓库 .d2i 替换向导
│       ├── authscripts.ts#   作者 bat 扫描 + 副作用静态分析 + 受控运行
│       ├── config.ts     #   持久化配置（游戏目录/来源/配置档/备份策略）
│       └── paths.ts      #   游戏目录/存档目录路径语义
├── frontend/             # React 19 + Tailwind v4 前端
│   └── src/tools/        #   ModManager / SavesPage / VaultPage / SettingsPage
├── scripts/              # dev / build 包装脚本 · 图标流水线 · 探针
├── icon/                 # 赫拉迪克方块 SVG → ICO/PNG（scripts/make-icon.mjs）
├── patches/              # pnpm patch：ztron-runtime-ffi 修复
└── ztron.conf.json       # 应用清单（窗口/打包/图标）
```

### 值得一提的工程细节

- **中文路径与特殊字符**：游戏目录形如 `Diablo II Resurrected – Infernal Edition`（含 en-dash 与空格），所有子进程调用一律走参数数组，绝不拼接命令行字符串
- **GBK 自动探测**：作者 txt / bat 输出按 GBK↔UTF-8 自动探测解码，脚本输出经 channel 逐行实时转码显示
- **伴生后缀陷阱**：Windows 下 `exec` bat 会把同目录同名其他后缀文件一并拉起，脚本运行做了防护
- **存档槽模型**：`root` 与 `mods/<name>` 两类槽位，`savepath="../"` 的 mod 正确归组到主存档，避免误导
- **幂等安全网**：还原前自动备份当前状态、stash 替换前强制预检 + 备份、卸载前探测该 mod 的存档目录
- **pnpm patch**：修补 `ztron-runtime-ffi` 缺失模块导致的静默退出问题

## 里程碑

| 里程碑 | 内容 | 状态 |
|--------|------|------|
| **M0** | ztron Windows 开发链路（Win32 host 移植 · tjs 运行时 · 打包链） | ✅ |
| **M1** | 工具箱骨架 + Mod 库 + 一键启动（6 变体全通过实机验收） | ✅ `358e40a` |
| **M2** | 存档管家 + 大仓库向导（备份/还原/自动备份 · stash 警告+回滚） | ✅ `a063979` |
| **M3** | 作者脚本受控运行 + 存档转移 + NSIS 打包 | ✅ `d4b1c4a` |
| **M5** | 掉落过滤管理（.fltr 预设原生管理 + 工具页） | ✅ |
| **M6** | 存档管家扩容（zip 压缩备份 + config 配置快照槽 + 占用显示） | ✅ |
| **M7** | 物品清单只读页 + 存档保护默认动作化 | ✅ |
| **M8** | 环境体检页（14 项一键体检 + 修复指引 + 复制报告） | ✅ |
| **M9** | mod 更新三件套（在线清单 + zip 导入/作者直链 + 更新检测） | ✅ |
| **M10** | 大仓库向导增强（替换前物品搬家提示 + HC/SC 一致性检测） | ✅ `dd45bea` |
| **M11** | 大箱子合并/拆分写入（多源多目标装箱 + 护栏写管线 + d2s 包 B2 修复） | ✅ `3d8c11c` |
| 后续 | .fltr 中文预设订阅 · 配方导出/导入 · 符文之语速查 · Grail 追踪 · Nexus key 集成 · 补丁兼容矩阵 | 🗺️ 规划中 |

## 授权协议

本项目采用自定义授权协议，全文见 [LICENSE.md](LICENSE.md)：

- ✅ **个人娱乐、学习研究、社群内免费分享** —— 免费使用、修改与分发（须保留版权与协议声明）
- ❌ **商业使用**（出售、付费整合包、收费代装/托管、商业宣传等）—— 须**事先取得作者书面授权并付费**
- 授权洽谈：[GitHub Issues](https://github.com/ZturnLibs/d2rtools/issues)

## 免责声明

本项目面向 **单机离线** D2R 玩家的 mod 与存档管理，不修改游戏内存、不联网、不触碰战网。使用 mod 与替换存档请自行承担风险——工具会在每个危险操作前自动备份，但请在替换大仓库等操作前确认备份可用。

---

<div align="center">

`React 19` · `Tailwind v4` · `TypeScript` · `ztron` · `tjs (TxikiJS)` · `WebView2` · `NSIS`

</div>
