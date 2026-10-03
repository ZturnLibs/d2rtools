# D2R 社区工具需求调研报告

> 版本：v1 · 2026-10 · 作为产品方向核心参考
> 方法：Reddit / 暴雪官方论坛 / Nexus Mods / GitHub / 凯恩之角 / NGA / 贴吧 / B站 / 淘宝-闲鱼整合包渠道 的公开内容桌面调研（证据 URL 见文末引用）
> 结论已合并 5 份分主题调研纪要：英文社区、竞品生态盘点、中文社区、存档/仓库/物品、mod 生态

---

## 0. 摘要（TL;DR）

1. **人群定位不变且被验证**：核心用户是 PC 单机离线/整合包玩家；BNet 在线玩家与主机玩家明确排除。中文社区因访问战网需加速器，"离线单机 + 整合包"生态庞大，且信息质量差、灰色收费多——一个免费、中文、开箱即用的工具箱本身就是差异化。
2. **最大痛点是存档安全**（官方永不修、社区只有"手动复制文件夹"级方案），我们的自动快照 + zip 备份正中空白，是差异化最强的功能，应升级为产品核心卖点。
3. **已覆盖方向全部成立**：mod 库 + 一键启动、大仓库向导、存档转移、.fltr 预设管理，与社区高频痛点一一对应。
4. **四大高价值空白**，按优先级：① 只读存档体检/物品清单（.d2s/.d2i 解析生态成熟，中文玩家无趁手工具）；② mod 更新检测 + 游戏补丁后兼容提醒（竞品都没做好）；③ 掉落过滤器"中文预设分发/订阅"（对标 D4 社区模式，官方已内置 filter 改变了格局）；④ 替换大仓库前的"物品搬家/合并"提示。
5. **合规红线**：不做存档修改器（赛道拥挤 + ToS 灰色），只读解析起步；不做 BNet 在线侧任何改客户端功能。

---

## 1. 玩家分层与需求边界

| 人群 | 规模/特征 | 需求 | 我们的态度 |
|------|-----------|------|-----------|
| PC 单机离线 / 整合包（中文为主） | 中文社区主力工具消费群；整合包形态为"游戏本体+mod+存档"整包（百度网盘/淘宝） | 存档安全、大仓库、mod 管理与一键启动、掉落过滤、路径/编码防呆 | **核心用户** |
| PC 正版离线玩家（英文社区） | Nexus + D2RMM 生态，mod 多为单 mod 或 D2RMM 格式 | D2RMM 之外的启动档案管理、mod 更新检测 | 次级，靠 D2RMM 兼容触达回流中文玩家 |
| BNet 在线 | 需求=交易/DClone/多开；**禁用一切改客户端工具** | 不可进入 | 排除 |
| 主机（PS/Xbox/Switch） | 无文件系统访问，存档曾大规模损坏但无任何备份手段 | 工具不可达 | 排除 |

版本环境变化（重要输入）：D2R "Reign of the Warlock" 更新后**官方内置 loot filter（.fltr）**，并登陆 Steam/Game Pass。→ 我们的 .fltr 预设管理方向正确，但价值点应从"编辑器"转向"中文预设库 + 订阅分发"；Game Pass 安装路径不同是新的兼容性探测点。

---

## 2. 需求全景：已满足 / 已覆盖 / 空白

### 2.1 已被现有工具满足（不必重造，做集成或互补）

| 需求 | 现有方案 | 说明 |
|------|----------|------|
| 多 mod 无冲突合并安装 | **D2RMM**（事实标准，mod.js 声明式） | 不做竞争，做"前置层"：检测、启动参数、存档隔离、可集成其输出 |
| 存档编辑/修改器 | d2s-editor、D2Emu、D2Runewizard Hero Editor、halbu 等 | 赛道拥挤且合规风险高，**明确不做** |
| modding 工具链 | CascView/MPQ Editor/D2 Excel | 纯作者工具，英文、无引导，普通玩家无感 |
| 资料查询 | D2Runewizard（符文之语）、diablo2.io | 已被占位；可内置轻量中文符文之语查询页作为锦上添花 |
| 多开 | d2r-handler 等 | 偏 BNet、随补丁失效、有封禁争议，不碰 |

### 2.2 我们已覆盖且被社区验证的需求（继续加强）

| 我们已有 | 社区证据 | 加强方向 |
|----------|----------|----------|
| 存档备份/还原/自动快照/zip | 存档损坏长期是官方论坛头号热点；社区唯一对策是手动备份；"D2RMM 用完后存档丢失"是中文区经典求助帖；2022.11 官方 bug 清空共享仓库、2025.11 国服非赛季存档异常 | **升级为默认动作**：安装/切换 mod、替换仓库前强制快照；退出游戏后增量备份；崩溃后提醒恢复。这是产品第一卖点 |
| mod 库 + 一键启动 + 参数知识库 | "-mod/-txt 误用""装了没效果"是中英文论坛高频求助；r/D2RMODS 已出现第三方 Companion Launcher 证明需求成立 | 补 D2RMM 格式兼容（识别 mod.js 元数据纳入库）；路径自检（中文路径/超长路径/Game Pass 路径） |
| 大仓库替换向导 | Expanded Stash 类 mod 长期热门；替换 d2i 后旧物品消失是高频事故；中文整合包大背包+大箱子是标配 | 替换前"物品搬家/转移提示"；HC/SC 页数不一致检测；多页 d2i 版本适配提示 |
| 存档转移 | 重装系统/换机丢档教程遍地；mod 存档↔主存档需手工复制 | 补向导式"mod↔主存档"双向转移（自动发现 mod 存档目录） |
| .fltr 预设管理 | 官方内置 filter 后社区转向；编写门槛高、无中文预设 | 转向"中文预设库 + 订阅/更新 + 一键启用" |

### 2.3 空白点：痛点（未被满足的真实痛苦）

| # | 空白 | 证据 | 建议 |
|---|------|------|------|
| P1 | **只读存档体检 + 物品清单**（坏档检测、8KB 装备丢失预警、仓库可视化导出） | 解析库生态成熟（nokka/d2s、@dschu012/d2s、halbu）；Infernal Edition 改格式后旧编辑器集体失效引发 PSA 求助；中文非技术玩家无趁手工具 | 基于 @dschu012/d2s（JS，技术栈契合）做只读检视器，风险低、差异化强 |
| P2 | **mod 更新检测 + 补丁后兼容提醒** | Nexus Tracked Mods 通知长期损坏被抱怨；竞品 D2RLaunch-WPF 内置作者更新 URL 检查验证需求；D2RMM FAQ 第一条就是"游戏更新了怎么办" | 支持 Nexus URL / 作者托管 json 版本源 + 本地比对；游戏补丁后提示哪些 mod 可能失效 → 已出专项评估：`mod-update-download-feasibility.md`（D2RLaunch 约定 + 作者直链下载） |
| P3 | **中文整合包"健康检查"**（中文路径、杀毒误报、游戏变英文、mod 版本适配） | 免安装版反复提示路径限制；bat 乱码；offline.dll 被误杀；"用了 mod 游戏变英文"高频 | 作为引流型免费功能：一键体检 + 修复指引 |

### 2.4 空白点：痒点（有更好，没有也行）

| # | 痒点 | 说明 |
|---|------|------|
| I1 | 掉落过滤器中文预设分发平台（订阅制） | 对标 D4 的 infinitybuilds.gg 模式，D2R 侧缺失 |
| I2 | Grail/收藏追踪、物品检索报表 | GoMule 需 Java、版本升级即失效；免 Java、中文界面的轻量替代 → 已做可行性评估：`stash-manager-feasibility.md` |
| I3 | 大仓库替换前的旧 d2i 物品注入/合并 | 高价值但工作量大，列入远期 |
| I4 | 内置中文符文之语/资料速查页 | 教育属性强，成本低 |
| I5 | 整合包"配方"导出/导入（mod 集 + 参数 + 过滤器 + 存档配置打包分享） | 天然形成分发渠道，连接整合包作者生态 |

---

## 3. 竞品速览

| 工具 | 满足 | 短板（=我们的空间） |
|------|------|---------------------|
| D2RMM | mod 合并安装，英文生态事实标准 | 不管理传统 mpq 整合包；无中文生态；CASC 路径报错频发；无更新检查；与存档管理脱节 |
| d2s 编辑器（多个） | 存档修改 | 格式版本适配差；合规风险；我们只做只读 |
| D2RLaunch-WPF | 单 mod 启动 + 作者更新检查 | 英文、单 mod、无整合包/存档配套 |
| GoMule（D2RMM 移植版） | 仓库物品清点 | 需 Java、随版本失效、中文不友好 |
| 淘宝/网盘"懒人包" | 开箱即玩 | 无版本管理、无更新、无备份、来源不明、高溢价——我们是对其的免费合法替代 |

## 4. 对产品路线图的输入

结合 product-plan.md 现有里程碑（M1–M6 已落地）：

**近期（巩固 + 引流）**
1. 存档保护升级为产品核心叙事：默认动作化（装 mod/换仓库前强制快照、退出增量备份）——正中社区第一痛点。
2. 新增"环境健康检查"工具页（P3）：路径/编码/杀毒/语言/版本适配一键体检。低成本、高传播性。
3. 大仓库向导补"物品搬家提示"+ HC/SC 检测。

**中期（差异化扩展，候选下一里程碑）**
4. 只读存档体检 + 物品清单（P1）：依赖 @dschu012/d2s，先角色列表/坏档预警，后仓库可视化。→ 大箱子整理/合并/拆分已出专项评估：`stash-manager-feasibility.md`（结论：可行，建议先只读清单、再带护栏写入）
5. mod 更新检测（P2）：支持 Nexus/作者托管版本源。

**远期（痒点，视资源）**
6. .fltr 中文预设订阅分发（I1）；整合包配方分享（I5）；符文之语速查（I4）。

**不做清单（明确排除）**：存档修改器本体、BNet 在线侧工具、主机端、多开、资料型 Web 站。

---

## 5. 主要证据引用

- 存档损坏/丢失：[官方论坛自救帖](https://us.forums.blizzard.com/en/d2r/t/solution-how-to-recovery-your-corrupteddisappeared-offline-character/30909)、[corruption 集中帖](https://us.forums.blizzard.com/en/d2r/t/offline-character-save-file-corruption/73752)、[reddit 丢档帖](https://www.reddit.com/r/diablo2/comments/16r0y1h/offline_character_disappeared_d2r/)、[中文备份教程](https://www.diablofans.com.cn/wz/166197.html)、[国服存档异常公告](https://d2.blizzard.cn/news/20251121/42929_1272408.html)
- 2022.11 官方清空共享仓库 bug：[PCGamesN](https://www.pcgamesn.com/diablo-2-resurrected/bug-shared-stash)、[Reddit](https://www.reddit.com/r/Diablo/comments/yk51qv/diablo_ii_resurrected_patch_252_items_in_shared/)
- D2RMM 痛点：[CASC 路径报错](https://forums.nexusmods.com/topic/13531518-diablo-2-resurrected-d2rmm-wont-install-mods-due-to-error/)、[卸载残留](https://www.reddit.com/r/Diablo_2_Resurrected/comments/1iisulf/d2rmm_mod_crashes_game_uninstall_the_mod_game/)、[存档丢失求助（中文）](https://www.233leyuan.com/post-detail/2058805344609779712)、[GitHub](https://github.com/olegbl/d2rmm)
- Launcher/profile 需求：[r/D2RMODS Companion Launcher](https://www.reddit.com/r/D2RMODS/)、[多参数冲突帖](https://www.reddit.com/r/Diablo_2_Resurrected/comments/suvhc4/multiple_additional_command_line_arguments_at/)
- Mod 更新检测：[Nexus 通知失效抱怨](https://forums.nexusmods.com/topic/3893885-notifications-from-mods-broken/)、[D2RLaunch-WPF](https://github.com/locbones/D2RLaunch-WPF)
- 官方内置 loot filter：[Icy Veins](https://www.icy-veins.com/d2/news/diablo-2-resurrected-gets-a-dedicated-trading-loot-filter-hub/)、[主机端不可用抱怨](https://www.reddit.com/r/diablo2/comments/1r5v9k6/loot_filter_useless_on_console/)
- 大仓库：[Expanded Stash](https://www.nexusmods.com/diablo2resurrected/mods/173)、[替换后物品消失教程](https://www.nexusmods.com/diablo2resurrected/videos/19)、[中文无限仓库帖](https://www.reddit.com/r/Diablo_2_Resurrected/comments/rexlmx/how_to_have_infinite_stash_on_d2r/?tl=zh-hans)
- .d2s/.d2i 解析库：[nokka/d2s](https://github.com/nokka/d2s)、[@dschu012/d2s](https://www.npmjs.com/package/@dschu012/d2s)、[halbu](https://github.com/feored/halbu)、[Infernal Edition 格式失效 PSA](https://www.reddit.com/r/Diablo_2_Resurrected/comments/1r2y2nu/psa_offline_save_files_postinfernal_edition/)、[8KB 装备丢失案例](https://www.douyin.com/shipin/7299770347807868955)
- 中文生态：[NGA 离线版求助](https://bbs.nga.cn/read.php?tid=47492464)、[淘宝懒人包避坑](https://tvgame.taobao.com/topic/youxixiugaiqi_230/b71dd116f1acba35267b30c588ef2c77.html)、[3DM 路径限制帖](https://bbs.3dmgame.com/thread-6440251-1-1.html)、[uuidd/D2RMod](https://github.com/uuidd/D2RMod)、[国人 .fltr Tauri 版](https://gitee.com/ghostweo/d2r-item-filter)
- 存档编辑器（不做）：[d2s-editor](https://d2seditor.vercel.app/)、[D2Emu](https://d2emu.com/hero)、[封号焦虑帖](https://www.reddit.com/r/Diablo_2_Resurrected/comments/1qihn5o/)

> 局限：QQ 群内容不公开；贴吧/NGA 部分需登录；社区热度以可公开抓取页面为准。
