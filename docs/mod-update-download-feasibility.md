# Mod 检查 / 更新检测 / 在线 mod 库 · 可行性评估

> 版本：v1 · 2026-10 · 基于社区调研（见 `community-research.md` P2）与 Nexus API 文档、现有工具实证
> 结论：更新检测与 mod 库清单放心做；"下载安装"限定"作者直链"模式，不做文件中转、不内置中文整合包源、Nexus 下载降级为可选。

---

## 1. 分块结论

| 能力 | 结论 | 机制 |
|------|------|------|
| 已安装 mod 更新检查 | ✅ 做 | D2RLaunch 约定：modinfo.json 注释段 `Mod Version` + 静态直链 config json，启动时拉取比对 |
| mod 库在线列表 | ✅ 做 | 自维护 JSON 清单（本仓库 GitHub），纯元数据（名称/类型/版本/作者/源链接/更新源 URL） |
| 下载安装 | ⚠️ 限定通道 | 仅"作者直链"（GitHub/网盘公开直链）；Nexus 走用户自带 key 的可选集成；中文源维持手动导入 |

## 2. 更新检测机制（复制 D2RLaunch-WPF 约定）

- 范本：[locbones/D2RLaunch-WPF](https://github.com/locbones/D2RLaunch-WPF)（GPL 开源，机制全部写在 README）
- mod 作者在 `modinfo.json` 注释段写死：
  - `Mod Version: 0.1.2.3`
  - `Mod Config Download: <直链 json>`（含 version + 下载链接，链接永久不变）
  - `Mod Download: <直链 zip>`（GitHub zip / Google Drive / Dropbox dl=1 等静态直链）
- 工具：启动时拉远端 config json → 比对版本 → 有新版提示 → 用户确认后下载 zip、备份旧文件、解压覆盖
- 作者零编码接入，英文社区已有同习惯；这是社区唯一广泛采用的事实标准（无更正式 schema）
- 已知坑：作者服务器配额超限会 403/429（D2RLaunch 实际遭遇过）；config 应带超时与失败降级

元数据现状：D2RMM mod.json 有 `name/description/author/website/version`（[DOCS.md](https://github.com/olegbl/d2rmm/blob/master/DOCS.md)）；原生 modinfo.json 事实标准只有 `name/savepath`。→ 我们对整合包生态推广上述注释段约定，同时兼容读取 D2RMM 的 version 字段。

## 3. 下载通道合规矩阵

| 通道 | 可行性 | 关键事实 |
|------|--------|----------|
| 作者直链 | ✅ 主力 | 文件始终在作者原始源；工具只存元数据与链接。先例：D2R-Reimagined launcher |
| Nexus API 查询 | ✅ 可合规 | [v3 REST API](https://api-docs.nexusmods.com/) 支持 mod 信息/文件列表/版本链查询；个人 key 免费生成；面向公众发布需向 support@nexusmods.com 注册应用 |
| Nexus API 下载 | ⚠️ 可选降级 | 需用户自己的 key + SSO 授权（先例：Reimagined launcher）；非会员速率/次数限制严格，免费用户体验差；禁止替用户保存 key、禁止抓全量 rehost（[AUP](https://help.nexusmods.com/article/114-api-acceptable-use-policy)）。投入产出不匹配，**不进首发** |
| 中文整合包源（QQ群/百度网盘/淘宝） | ❌ 不做 | 全部无程序化接口（网盘需登录+验证码）；再分发侵权风险高；维持手动导入 zip |

**红线**：绝不将 mod 文件 rehost 到自有服务器/网盘。Nexus 作者权限页普遍声明禁止再分发，[有真实诉讼争议](https://lawfold.com/skyrim-mod-lawsuit-drama/)。淘宝"懒人包"模式（付费转售整合包）是负面样板。

## 4. 与现有架构的落点

- **更新源 URL** 是三个功能共用的核心元数据：mod 卡片扩展字段（updateUrl / version / downloadUrl），存 modLibrary 服务与 store 配置
- **mod 库清单**：`capabilities/` 或独立 GitHub 仓库的 `mod-index.json`；前端新增"mod 库"工具页（浏览/搜索/详情/安装）
- **安装管线复用**：下载 zip → 校验 → 走现有"扫描识别 modinfo.json/修正嵌套层级/复制或硬链接到游戏 mods\"逻辑（与本地仓库目录导入共用）
- **更新检测触发**：工具启动时 + mod 库页手动刷新；写入 store 记录的 `lastChecked` 避免频繁请求
- 更新/安装前强制快照存档（复用存档管家）——mod 升级破坏存档是社区高发事故

## 5. 风险清单

| # | 风险 | 对策 |
|---|------|------|
| R1 | 作者直链失效/配额超限（403/429） | 失败降级为"跳转源页面手动下载"；清单项标记健康状态 |
| R2 | 更新安装破坏现有存档/版本不兼容 | 安装前强制快照 + modinfo 里游戏版本要求提示；补丁后兼容矩阵提醒（调研 P2 后半） |
| R3 | 恶意 zip（整合包生态来源复杂） | 下载后只解压到临时目录→扫描 modinfo.json 存在性→拒绝可执行文件/脚本，再入 mods 目录 |
| R4 | Nexus ToS 违规（key 管理/rehost） | 不做下载代理；key 仅存用户本机 store，不明文上传 |
| R5 | 清单维护成本 | 第一期仅收录少量验证过的源（术士君临 + 已知的英文大 mod），不追求全量 |

## 6. 分期建议

1. **第一期（建议立项）**：modinfo 注释段更新约定 + 更新检测 + mod 库清单（GitHub JSON）+ 作者直链下载安装。三件套共用一套元数据。
2. **第二期（可选）**：Nexus 查询集成（用户自带 key）、补丁后 mod 兼容矩阵提醒、mod 库用户投稿入口。

对应社区调研空白点：P2（mod 更新检测）+ 痒点 I1（订阅/分发模式的 mod 形态版）。
