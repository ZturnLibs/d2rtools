# D2R 工具箱 · 产品方案（第一期）

> 状态：讨论稿 v1 · 2026-10
> 背景：解决"每次手动配置/修改参数才能用 mod"的痛点；工具定位不限于 mod 管理，后续是一类工具集合。

## 1. 定位与命名

- **一句话定位**：面向中文 D2R 整合包玩家的桌面工具箱——安装 mod、记参数、管存档、保仓库，一键直达游戏。
- **与 D2RMM 的差异**：D2RMM 面向 Nexus 英文 mod 的 `mod.js` 声明式合并格式；本工具面向中文整合包的"原始 MPQ + 启动参数 + 作者脚本"生态，管安装/启动/存档/配置开关，不做 mod 内容合并。
- **命名**（待定）：候选 `D2R Toolbox` / `赫拉迪克工具箱 (Horadric Kit)` / `D2R Companion`。架构上"工具"是可插拔模块，mod 管理只是第一个工具。
- **目标用户**：本人 + 群友/社群。需考虑任意游戏路径、任意整合包来源、界面引导完善。

## 2. 环境事实（调研结论，设计的输入）

- 游戏目录：`D:\Games\Diablo II Resurrected – Infernal Edition`（单机离线版，BNet_Emu；路径含 en-dash `–` 与中空格，所有路径处理必须容忍）
- mod 机制：`<游戏目录>\mods\<mod名>\<mod名>.mpq`（mpq 文件或解压文件夹），`modinfo.json` 的 `savepath` 决定存档隔离位置；启动参数 `-mod <名> [-txt]`
- 存档目录：`%UserProfile%\Saved Games\Diablo II Resurrected`，含角色 `.d2s` 系列、共享仓库 `SharedStash*.d2i`、`Settings.json`、`lootfilter.json`、`.fltr`，以及 `mods\<savepath>\` 的 per-mod 存档
- 现有整合包"术士君临"含 2 套 6 变体：
  - EJ 开荒版：`-mod EJ -txt`，独立存档（savepath=EJ）
  - VIPer 大型整合 5 变体：`VIPer_cs`(地狱降临)/`VIPer`(主播)/`VIPer_hp`(爽玩)/`VIPer_new`(萌新)/`VIPer_ds`(炼狱)，**不能带 -txt**，savepath="../"（共用主存档）
- 作者脚本：7页大仓库 stash 替换（有清空风险）、SwitchNoDrop.bat（掉落过滤）、SwitchAutoRunFile.bat（自动拾取）、存档备份/还原 bat（GBK 编码、乱码、taskkill 杀进程）

## 3. 第一期功能（4 个模块）

### 3.1 Mod 库 + 一键启动

- **Mod 源管理**：用户登记若干"整合包仓库目录"（如术士君临目录）；扫描识别 `modinfo.json`/`.mpq`，自动修正嵌套层级（如 `1.第一种开荒用/mods/EJ`）
- **Mod 卡片**：名称、变体列表、启动参数、savepath、作者说明（读取附带 txt，按 GBK/UTF-8 自动探测编码）、来源目录
- **安装/卸载**：复制（默认）或硬链接到游戏 `mods\`；卸载前检查该 mod 的存档目录并提示
- **启动配置档（Profile）**：= mod 变体 + 参数（`-mod X [-txt]` 等）+ 备注；一键启动 `D2R.exe`；可导出桌面快捷方式（生成 `.bat` 或 `.lnk`）
- **参数知识库**：内置常见参数（`-mod/-txt/-direct/-w/-sndbkg` 等）说明，防止"EJ 要 -txt、VIPer 不能 -txt"这类记错

### 3.2 存档备份/还原

- 存档总览：按 savepath 分组列出角色与仓库文件，显示修改时间、大小
- **快照备份**：把存档目录（或指定 savepath 子集）打成带时间戳的备份（文件夹复制或 zip）；保留最近 N 份，可备注
- **一键还原**：选中快照回滚；还原前自动再备一份当前状态（防误操作）
- **启动前自动备份**（可开关）：每次经工具启动游戏时静默快照

### 3.3 大仓库（共享 Stash）替换向导

- 场景泛化：任何"用作者提供的 `.d2i` 替换现有共享仓库"的操作
- 向导三步：① 检测当前 stash 非空 → 醒目警告"替换将清空现有共享仓库内容"，建议先转移物品；② 自动备份现有 stash；③ 替换并记录可回滚
- 附带：存档目录下 `SharedStashSoftCoreV2备份` 这类手工备份也纳入管理视图

### 3.4 作者脚本（bat 开关）集成

- **第一期**：把 bat 开关登记为 mod 卡片上的 GUI 按钮，点击即以正确工作目录调用原 bat（捕获输出、转码 GBK 显示）；标记"会杀游戏进程"类副作用
- **第二期**：对高频开关做原生实现（如掉落过滤的规则文件拼装逻辑已在 bat 中完全可读，可用 TS 重写为即时切换 + 预览）

> 调研更新（M5）：SwitchNoDrop/SwitchAutoRunFile 为 MDK 体系残留脚本，术士君临包内规则碎片缺失、bat 实际不可运行；掉落过滤落地为游戏自带 .fltr 预设管理工具。

## 4. 扩展性设计（工具集合）

- 前端按"工具"组织：左侧工具导航（Mod 管理 / 存档管家 / 仓库向导 / 设置），每个工具是独立路由模块
- 后端按"能力"组织：`services/` 下每个领域一个服务（modLibrary、saveManager、stashWizard、scriptRunner），通过 ztron commands 暴露给前端，`ztron codegen` 生成类型绑定
- 配置持久化：ztron store 插件（游戏路径、仓库目录列表、备份保留策略、各工具设置）
- 后续候选工具：~~lootfilter/.fltr 管理~~（已落地 M5）、~~Settings.json 备份~~与 zip 压缩备份（已落地 M6）、存档转移（主存档 ↔ mod 存档）、mod 更新检测（仍留待社群渠道决策）

## 5. 技术架构

- **框架**：ztron（Tauri 式，全 TS，`C:\Users\ZYJ\orca\ztron` 本地仓库），模板 `react-ts`（React 19 + Tailwind v4）
- **项目位置**：`C:\Users\ZYJ\orca\projects\d2r-research`（monorepo 内新建 app，或 ztron init 生成后迁入）
- **用到的 ztron 插件**：fs（扫描/复制/备份）、shell（启动 D2R.exe、调 bat）、dialog（选目录）、store（配置）、path、opener、process、notification
- **关键技术点**：
  - 中文路径/en-dash：一律宽字符安全的方式传参（shell 插件数组参数，不拼字符串）
  - GBK 编码：作者 txt/bat 输出按 GBK 解码（TextDecoder('gbk')）
  - MPQ 识别：文件魔数 `MPQ` 头或解压文件夹内 `modinfo.json`
  - 备份：先文件夹复制（简单可靠），zip 压缩作为后续优化

## 6. ztron Windows 补全计划（并行工作流）

现状评估（2026-10 实测仓库 v0.3.7）：README 称"host 骨架已就位"偏乐观——`host_windows.c` 是真 Win32 代码（671 行），但共享层 `host.c` 是 POSIX-only（pthread/socket），MSVC 无法编译；webview 补丁的纯虚函数在 Windows 后端无实现。TS 层全部跨平台就绪。

按阻塞顺序的工作项：

| # | 工作项 | 涉及文件 | 说明 |
|---|--------|----------|------|
| W1 | host.c 的 _WIN32 移植 | `native/host/host.c` | winsock + Win32 线程替换 pthread/POSIX socket，线协议不变（runtime-ffi 无需动）。**关键路径** |
| W2 | webview 补丁兼容 | `scripts/patches/webview-local.patch` | `set_scheme_handler_impl` 给默认空实现（先能编）；后续补 WebView2 scheme handler（ztron:// 生产资源） |
| W3 | tjs Windows 运行时 | 环境 | 快速通道 `winget install Saghul.TxikiJS` + `ZTRON_TJS`；正式通道 CMake/MSVC 构建 pinned ref |
| W4 | CLI 识别 .exe | `packages/cli/src/native-locate.ts`、`doctor.ts` | win32 下 `ztron-host.exe`/`tjs.exe`；BUNDLED_PKG 按平台参数化 |
| W5 | build-native.sh Windows 分支 | `scripts/build-native.sh` | MSVC 环境探测、`build/Release/tjs.exe` 路径、webview.lib 链接 |
| W6 | Windows 打包 | `packages/cli/src/index.ts` buildApp、新增 `launcher_windows.c` | tjs compile → `ztron-backend.exe` + host + webview.dll + 启动器；NSIS 脚本生成已在 `bundler.ts`（纯 TS，待真机验证） |
| W7 | 发布链路 | `.github/workflows/publish.yml`、`packages/native-win32-x64/` | npm 平台包 + optionalDependencies |

工具链前置：VS Build Tools（MSVC + C++ CMake）、CMake。本机已有 Node 22.17 + pnpm 9.11，`pnpm test` 应可直接跑（CI windows-latest 已绿）。

验证阶梯：`pnpm test` → hello example `ztron dev` → `ztron check`（86 项 FULL_OK 门禁）→ `ztron build` → 本工具实机使用。

## 7. 里程碑

| 里程碑 | 内容 | 验收 |
|--------|------|------|
| M0 | ztron Windows dev 链路（W1–W5） | hello example 在 Windows 弹出窗口；ztron check 通过 |
| M1 | 工具箱骨架 + Mod 库 + 一键启动 | 术士君临 6 变体全部可安装、可带正确参数启动 |
| M2 | 存档管家 + 大仓库向导 | 备份/还原/自动备份可用；stash 替换有警告有回滚 |
| M3 | bat 开关集成 + 打磨 + NSIS 打包（W6/W7） | 群友可装 exe 即用 |

## 8. 风险与开放问题

1. **W1 工作量**：host.c 的 socket/线程层移植是第一阻塞点，需要 C 层调试（本机需装 MSVC 工具链）
2. **生产模式资源加载**：dev 走 Vite http 无问题；打包后 ztron:// 需 WebView2 scheme handler（W2 的完整版），否则 build 产物白屏
3. **savepath="../" 语义**：VIPer 共用主存档，工具在"存档总览"里要正确归组，避免误导用户以为有独立存档
4. **bat 副作用**：作者脚本会 `taskkill /f /im D2R.exe`，集成时必须显式提示
5. 开放问题：产品名待定；mod 更新检测/分发是否做（涉及社群发布渠道）留待第一期后讨论
