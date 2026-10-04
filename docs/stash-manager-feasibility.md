# 大箱子（.d2i）整理/合并/拆分管理 · 可行性评估

> 版本：v1 · 2026-10 · 基于社区调研（见 `community-research.md`）与格式源码实证
> 结论：能做，TS 技术栈有现成依赖；风险集中在"写入时机"与"版本适配"，均可工程化规避。建议两步走：先只读清单，再带护栏的写入。

---

## 1. 结论摘要

| 问题 | 答案 |
|------|------|
| 是否违反合规/ToS？ | 否。仅限单机离线（BNet 存档在服务器，工具本就够不着）；功能定位是"仓库搬运工"——只改物品坐标，不改物品体、不造物品，与存档修改器划清界限 |
| 技术是否支持？ | ✅ 支持。npm 包 `d2s`（dschu012，纯 TS）带完整 d2i 读写；youdz/d2-stash-organizer（TS 开源）已实现同类功能可借鉴 |
| 主要风险？ | ① 游戏运行中写入被内存状态覆盖；② 格式随版本破坏（当前 v105/RotW）；③ 游戏机制性约束（如多火炬消失）；④ npm 包自身两处 bug |

## 2. 格式机制（设计输入）

- `.d2i` = **N 个 sector 顺序拼接，每页一个 sector；每个 sector 自带一份 64 字节小头**：`magic 0xAA55AA55 | hardcore u32 | version u32 | sharedGold u32 | sectorSize u32 | 44B 保留`，随后该页 `JM` 开头的物品位流。两处易错点（2026-10 实机文件 + lib 源码双重验证）：**hardcore 语义反着存（0 = 硬核，lib `ReadUInt32()==0`）**；页数 = `floor(文件长度 / sectorSize)`（不是减一次 64B 头——每个 sector 都有头）。证据：[`dschu012/d2s` `src/d2/stash.ts`](https://github.com/dschu012/d2s/blob/master/src/d2/stash.ts)，实机交叉验证见 M10 `scripts/m10-probe.ts`（HC 文件头部读取与 lib 全解析逐字段一致）
- **文件不编码总页数/格子布局**：页数由文件长度推出；格子布局由 mod 的 `bankexpansionlayouthd` 决定（[Nexus 教程](https://www.nexusmods.com/diablo2resurrected/videos/19)、[国内 mod 文档](https://www.wolai.com/teamind/weEykLZBvaHuZGc98WTF4r)）。→ 不同页数 d2i 可互换，游戏按文件内容解析
- 物品编码与 .d2s 同源：version≥0x61 物品类型走 Huffman 变长码；位置字段 x/y 各 4 bit、**页索引 3 bit（0–7）**；其余同 LoD v96（[D2CE 格式文档](https://github.com/WalterCouto/D2CE/blob/main/d2s_File_Format.md)）
- **"合并/拆分"的本质 = 搬物品坐标，物品体原样搬运**（d2-stash-organizer 正是此设计）

### 坐标字段的容量上限（重要约束）
x/y 各 4 bit（≤15）、页索引 3 bit（≤8 页）。**超过 8 页或更大网格的 mod 会溢出这些字段**——整理布局时必须按当前 mod 的实际页数/网格生成目标坐标，不可越界。

## 3. 现有实现盘点

| 项目 | 读 d2i | 写 d2i | mod 大箱子 | 备注 |
|------|--------|--------|-----------|------|
| `d2s`（npm，TS） | ✅ | ✅ | `extendedStash` 配置未生效（见 §5-B1，读路径已证实惰性） | 我方首选依赖 |
| youdz/d2-stash-organizer（TS） | ✅ | ✅ | PlugY/d2i | 已实现自动分类整理+跨箱搬物+**数量守恒硬校验**，`src/scripts` 可研读 |
| gomule-d2r（Java） | ✅ | ✅ | 默认 3 页验证 | 多条写入警告的来源 |
| D2CE（C++/C#） | ✅ | ✅ | 仅标准 d2i | v2.16 加 d2i 导入导出 |
| halbu（Rust） | .d2s v99/v105 | ❌ | — | v105 支持参考 |
| nokka/d2s（Go） | ❌ | ❌ | — | |

**结论**：无成熟中文桌面工具做过 D2R 大箱子整理——调研报告 I2 空白点确认成立。

## 4. 风险清单与对策

| # | 风险 | 实据 | 对策 |
|---|------|------|------|
| R1 | **游戏运行中写入被覆盖**：D2R 将仓库常驻内存，退出时才落盘 | [GoMule-d2r README](https://github.com/pairofdocs/gomule-d2r)、[D2R-Stash-Manager](https://github.com/dkwasny/D2R-Stash-Manager) 均明示"使用时必须关游戏" | 写入前检测 D2R.exe 进程，存在则拒绝+引导关闭；经本工具启动的游戏天然可控（已知 PID） |
| R2 | **格式随版本破坏**：v97→v98(Huffman+UTF-8)→v99→v105(RotW)；checksum 错游戏直接拒载 | [halbu](https://github.com/feored/halbu) 是目前少数支持 v105 的库；Infernal Edition 后旧编辑器集体失效（[PSA](https://www.reddit.com/r/Diablo_2_Resurrected/comments/1r2y2nu/psa_offline_save_files_postinfernal_edition/)） | 写入前校验 version，不认识的版本**只读拒绝写**；写后重算 checksum 并回读验证 |
| R3 | **游戏机制性物品丢失**：如一个角色随身箱放多个地狱火炬会消失 | GoMule-d2r 警告 | 搬移规则内置已知约束校验（至少火炬类）；整理以"向导预览+确认"呈现，不做静默全自动 |
| R4 | **游戏自身也会零化存档** | [官方论坛 corruption 帖](https://us.forums.blizzard.com/en/d2r/t/offline-character-save-file-corruption/73752) | 写入前强制快照（已有存档管家能力），写坏可一键回滚——这恰是"备份先行"产品叙事的落地场景 |
| R5 | **HC/SC 与 mod 存档目录混淆**：SharedStashHardCoreV2 / mods\\<savepath> 各有独立 d2i | 调研已知坑 | 按 savepath 分组展示，跨组搬移需显式确认 |

## 5. 已知实现坑（npm 包 `d2s`）

1. **B1 · `extendedStash` 未生效**：`readStashPart` 硬传 `defaultConfig`（stash.ts:114）。**2026-10 复核（2.0.36 实读源码）：该 flag 在读路径是死代码**——items.js 无任何消费点，物品位置字段定宽（invloc:4/x:4/y:4/page:3 bit），网格尺寸由 mod 数据文件而非存档文件决定。**只读清单无需 patch**；B1/B2/B3 一并留在写路径里程碑（M11）处理。
2. **B2 · 写路径 version 硬编码 0x62**（`writeStashSection`）——v105 存档需扩展版本处理。
3. **B3 · sharedGold 每 sector 重复存储**——合并/拆分多页时须保持各 sector 一致。
4. **版本常量表只带 v96/v99**：v105 存档以 v99 常量读兼容（halbu 先例），需显式传 constants + 注册 105→99 别名，勿让库自查版本。

## 6. 落地形态建议（两步走，风险递降）

**第一步 · 只读物品清单（零风险，建议下一里程碑）**
- 解析 d2i + 各 savepath 下角色 .d2s：按页/分类（符文、宝石、暗金、套装…）展示，支持搜索
- 顺带产出两个已排期价值：① 大仓库向导的"替换前物品搬家提示"；② 存档体检的角色/仓库概览（调研 P1）
- 无需 patch：B1 经复核在读路径惰性（见 §5），显式传 constants 即可

**第二步 · 合并/拆分写入（带护栏）**
- 向导流程：选源（多个 d2i / 角色）→ 目标布局预览（按当前 mod 页数/网格生成合法坐标）→ 确认
- 写入管线：D2R 进程检测 → 强制快照 → 写 d2i → checksum 回读验证 → 物品数量守恒校验（借鉴 d2-stash-organizer 硬校验）→ 提示"重启游戏生效"
- 远期可叠加：自动分类整理预设、Grail 追踪（I2）、旧 d2i 物品注入新大箱子（调研 P4/痒点 I3）

## 7. 工作量粗估

| 项 | 量级 |
|----|------|
| 接入 d2s 依赖（只读免 patch；B1/B2 留写路径） | 小 |
| 只读清单 UI（复用现有工具页骨架） | 中 |
| 写管线（进程检测/快照/校验，复用存档管家服务） | 中 |
| 布局引擎（分类规则 + 坐标合法化） | 中–大，主要工作量 |
| 合并/拆分向导 UI | 中 |
