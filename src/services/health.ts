/**
 * M8 环境体检：read-only probes of the game environment — path shape /
 * length / protected installs, emu-pack language config, game version,
 * antivirus-victim core files, save dir and system settings. Detection
 * only: nothing here writes to user files, fix guidance is text for the
 * UI. The Windows-side facts (version, long-paths registry, process,
 * Defender exclusions, OS) are gathered in ONE consolidated PowerShell
 * spawn (probeSystemWindows); every group degrades independently to
 * info-level "未能读取" items when a probe fails — runHealthCheck never
 * throws.
 */
import { runPowerShell, parseOkMap } from "./ps.js";
import {
  validateGameDir,
  saveRoot,
  joinPath,
  pathExists,
  isValidModName,
  modsDir,
} from "./paths.js";

export type HealthStatus = "ok" | "info" | "warn" | "fail";
export type HealthGroup = "path" | "lang" | "version" | "av" | "saves" | "system";

export interface HealthCheckItem {
  id: string;
  group: HealthGroup;
  title: string;
  status: HealthStatus;
  detail: string;
  /** warn/fail 时的一句话结论；ok/info 恒为 null。 */
  fixSummary: string | null;
  /** 小白向分步指引；ok/info 恒为 []。 */
  fixSteps: string[];
}

export interface HealthCheckResult {
  gameDir: string | null;
  durationMs: number;
  items: HealthCheckItem[];
}

/** 整合包（BNet_Emu 离线补丁）运行必需、也是杀毒误报最常见受害者的文件。 */
export const CORE_EMU_FILES = ["WinHttp.dll", "D2R_loader.dll", "steam_api64.dll"] as const;

const REG_OPEN_LONG_PATHS =
  "Win+R 输入 regedit 打开注册表编辑器，定位到 HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\FileSystem，把 LongPathsEnabled 改为 1 后重启电脑";

// ---------------------------------------------------------------------------
// Pure helpers (vitest-covered)
// ---------------------------------------------------------------------------

/** The consolidated probe script: five __D2R_OK__key=value lines + done sentinel. */
export function buildSystemProbeCommand(): string {
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
    "try { $v=(Get-Item -LiteralPath $env:D2R_EXE -ErrorAction Stop).VersionInfo.ProductVersion; Write-Output \"__D2R_OK__version=$v\" } catch { Write-Output '__D2R_OK__version=' }",
    "try { $lp=(Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\FileSystem' -Name LongPathsEnabled -ErrorAction Stop).LongPathsEnabled; Write-Output \"__D2R_OK__longPaths=$lp\" } catch { Write-Output '__D2R_OK__longPaths=' }",
    "if (Get-Process -Name 'D2R' -ErrorAction SilentlyContinue) { Write-Output '__D2R_OK__running=1' } else { Write-Output '__D2R_OK__running=0' }",
    "try { Write-Output \"__D2R_OK__osVersion=$([System.Environment]::OSVersion.VersionString)\" } catch { Write-Output '__D2R_OK__osVersion=' }",
    "try { $mp=Get-MpPreference -ErrorAction Stop; Write-Output \"__D2R_OK__defenderEx=$($mp.ExclusionPath -join '|')\" } catch { Write-Output '__D2R_OK__defenderEx=' }",
    "Write-Output '__D2R_OK__done=1'",
  ].join("\n");
}

/** Decode ini bytes: sniff BOM (UTF-8 / UTF-16LE / BE), fall back to UTF-8. */
export function decodeIniText(bytes: Uint8Array): string {
  const has = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  try {
    if (has(0xef, 0xbb, 0xbf)) return new TextDecoder("utf-8").decode(bytes.subarray(3));
    if (has(0xff, 0xfe)) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
    if (has(0xfe, 0xff)) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  } catch {
    /* decoder label missing — fall through */
  }
  return new TextDecoder("utf-8").decode(bytes);
}

/** Parse BNet_Emu.ini: case/whitespace/CRLF tolerant key=value scan. */
export function parseBNetEmuIni(text: string): { locale: string | null; localeAudio: string | null } {
  let locale: string | null = null;
  let localeAudio: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#") || line.startsWith("[")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    if (key === "locale" && locale === null) locale = value || null;
    else if (key === "localeaudio" && localeAudio === null) localeAudio = value || null;
  }
  return { locale, localeAudio };
}

/** Path character analysis: non-ASCII presence and named special classes. */
export function analyzePathShape(gameDir: string): { length: number; nonAscii: boolean; specials: string[] } {
  const specials: string[] = [];
  if (/[\u4e00-\u9fff]/.test(gameDir)) specials.push("中文");
  if (gameDir.includes("\u2013")) specials.push("en-dash（–）");
  const nonAscii = /[^\x00-\x7F]/.test(gameDir);
  return { length: gameDir.length, nonAscii, specials };
}

/** MAX_PATH verdict by gameDir length and the system long-paths setting. */
export function pathLengthVerdict(
  length: number,
  longPaths: boolean | null,
): { status: HealthStatus; detail: string; fixSummary: string | null; fixSteps: string[] } {
  if (length < 120) {
    return { status: "ok", detail: `路径长度 ${length} 字符，安全范围内。`, fixSummary: null, fixSteps: [] };
  }
  if (length < 200) {
    return {
      status: "info",
      detail: `路径长度 ${length} 字符，偏长但一般不影响使用。`,
      fixSummary: null,
      fixSteps: [],
    };
  }
  const fixSteps = [
    "最简单的办法：把游戏目录移到更短的位置，例如 D:\\Games\\D2R（移动后需在「设置」里重新选择目录）",
    `或者开启系统长路径支持：${REG_OPEN_LONG_PATHS}`,
  ];
  if (longPaths === true) {
    return {
      status: "info",
      detail: `路径长度 ${length} 字符，较长；系统已开启长路径支持，一般无碍。`,
      fixSummary: null,
      fixSteps: [],
    };
  }
  return {
    status: "warn",
    detail: `路径长度 ${length} 字符，接近 Windows 260 字符限制，往 mods 里装 mod 后子路径很容易超限导致报错。`,
    fixSummary: "游戏目录过长，装 mod 后容易触发系统路径长度限制。",
    fixSteps,
  };
}

/** Game Pass / Microsoft Store installs: TrustedInstaller-protected dirs. */
export function isProtectedInstallPath(gameDir: string): boolean {
  return /\\windowsapps(\\|$)/i.test(gameDir) || /\\xboxgames(\\|$)/i.test(gameDir);
}

export function missingCoreFiles(
  present: Record<string, boolean>,
  required: readonly string[],
): string[] {
  return required.filter((f) => present[f] !== true);
}

/**
 * Defender exclusion list from Get-MpPreference. Without admin rights PS
 * answers with the literal "N/A: Must be an administrator to view
 * exclusions" — treat that (and emptiness) as "unknown", the caller hides
 * the item rather than guessing a reason.
 */
export function normalizeDefenderEx(raw: string | null | undefined): string | null {
  const v = raw?.trim() ?? "";
  if (v.length === 0 || v.toUpperCase().startsWith("N/A")) return null;
  return v;
}

// ---------------------------------------------------------------------------
// Consolidated Windows probe
// ---------------------------------------------------------------------------

export async function probeSystemWindows(
  exePath: string | null,
): Promise<{ ok: boolean; values: Record<string, string> }> {
  try {
    const r = await runPowerShell({
      command: buildSystemProbeCommand(),
      env: exePath ? { D2R_EXE: exePath } : {},
      timeoutMs: 10_000,
    });
    const values = parseOkMap(r.stdout);
    // done=1 sentinel: without it the script died halfway — degrade wholesale.
    if (values["done"] !== "1") return { ok: false, values };
    return { ok: true, values };
  } catch (err) {
    console.warn("[d2rbox] health system probe failed:", err);
    return { ok: false, values: {} };
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function item(
  id: string,
  group: HealthGroup,
  title: string,
  status: HealthStatus,
  detail: string,
  fixSummary: string | null = null,
  fixSteps: string[] = [],
): HealthCheckItem {
  return { id, group, title, status, detail, fixSummary, fixSteps };
}

/** A group-level catch-all when an unexpected error escapes one group. */
function degradedItem(group: HealthGroup): HealthCheckItem {
  return item(
    `${group}-group`,
    group,
    "该组检测失败",
    "info",
    "检测过程中出现问题（可重新检测）；不影响其他组的结果。",
  );
}

async function checkPathGroup(
  gameDir: string,
  knownModNames: string[],
  longPaths: boolean | null,
): Promise<HealthCheckItem[]> {
  const items: HealthCheckItem[] = [];

  // 目录完整性（≥260 时 stat 自身会失败，特判防"目录不存在"误导）
  if (gameDir.length >= 260 && !(await pathExists(gameDir))) {
    items.push(
      item(
        "game-dir-valid",
        "path",
        "目录完整性",
        "fail",
        `目录路径过长（${gameDir.length} 字符），系统无法访问。`,
        "路径超过 Windows 260 字符限制。",
        [
          "把游戏目录移到更短的位置，例如 D:\\Games\\D2R（移动后需在「设置」里重新选择目录）",
          `或开启系统长路径支持：${REG_OPEN_LONG_PATHS}`,
        ],
      ),
    );
  } else {
    const v = await validateGameDir(gameDir);
    if (!v.exists) {
      items.push(
        item(
          "game-dir-valid",
          "path",
          "目录完整性",
          "fail",
          "游戏目录不存在或无法访问。",
          "设置的目录可能已被移动、重命名或删除。",
          ["确认游戏目录位置后，到「设置」页重新选择"],
        ),
      );
    } else if (!v.hasD2R) {
      items.push(
        item(
          "game-dir-valid",
          "path",
          "目录完整性",
          "fail",
          "目录下找不到 D2R.exe。",
          "选择的可能不是游戏根目录。",
          ["到「设置」页重新选择游戏根目录（D2R.exe 所在的那一层）"],
        ),
      );
    } else if (!v.hasModsDir) {
      items.push(
        item(
          "game-dir-valid",
          "path",
          "目录完整性",
          "info",
          "游戏目录有效；mods 目录暂不存在（安装 mod 时会自动创建）。",
        ),
      );
    } else {
      items.push(item("game-dir-valid", "path", "目录完整性", "ok", "游戏目录有效（D2R.exe 与 mods 目录齐全）。"));
    }
  }

  // 路径字符（D2R 与本工具均兼容；点名第三方工具风险，info 而非 warn）
  const shape = analyzePathShape(gameDir);
  if (shape.nonAscii) {
    const named = shape.specials.length > 0 ? shape.specials.join("、") : "非 ASCII 字符";
    items.push(
      item(
        "path-shape",
        "path",
        "路径字符",
        "info",
        `路径含${named}。D2R 与本工具均兼容；个别第三方工具（如老版本地化/合并工具）可能不支持这类路径。`,
      ),
    );
  } else {
    items.push(item("path-shape", "path", "路径字符", "ok", "纯 ASCII 路径，兼容性最佳。"));
  }

  // 路径长度
  const len = pathLengthVerdict(gameDir.length, longPaths);
  items.push(item("path-length", "path", "路径长度", len.status, len.detail, len.fixSummary, len.fixSteps));

  // 受保护目录（Game Pass / 商店版）
  const protectedDir =
    isProtectedInstallPath(gameDir) || (await pathExists(joinPath(gameDir, "appxmanifest.xml")));
  items.push(
    protectedDir
      ? item(
          "protected-path",
          "path",
          "受保护目录",
          "warn",
          "这是微软商店 / Game Pass 版安装位置，目录受系统 TrustedInstaller 保护。",
          "商店版游戏目录受系统保护，无法正常安装 Mod。",
          [
            "改用独立安装版整合包（免安装硬盘版 / 官方离线安装版）",
            "把整合包整体解压到一个普通目录（如 D:\\Games\\D2R），再到「设置」里选择它",
          ],
        )
      : item("protected-path", "path", "受保护目录", "ok", "常规安装位置，可正常安装 Mod。"),
  );

  // mods 目录下未纳管的孤儿 mod
  if (await pathExists(modsDir(gameDir))) {
    const known = new Set(knownModNames);
    const orphans: string[] = [];
    const d = await tjs.readDir(modsDir(gameDir));
    for await (const e of d) {
      if (!e.isDirectory || !isValidModName(e.name) || known.has(e.name)) continue;
      orphans.push(e.name);
    }
    items.push(
      orphans.length > 0
        ? item(
            "mods-orphans",
            "path",
            "Mod 纳管",
            "info",
            `发现 ${orphans.length} 个未纳入管理的 mod 目录：${orphans.join("、")}。不影响使用；可在「Mod 管理」扫描整合包来源后统一管理。`,
          )
        : item("mods-orphans", "path", "Mod 纳管", "ok", "mods 目录下的 mod 均已纳管。"),
    );
  }

  return items;
}

async function checkLangGroup(gameDir: string): Promise<HealthCheckItem[]> {
  const iniPath = joinPath(gameDir, "BNet_Emu.ini");
  if (!(await pathExists(iniPath))) {
    return [
      item(
        "game-locale",
        "lang",
        "游戏语言",
        "info",
        "未检测到整合包语言配置（BNet_Emu.ini），可能为正版环境，跳过语言检查。",
      ),
    ];
  }
  const bytes = await tjs.readFile(iniPath);
  const { locale, localeAudio } = parseBNetEmuIni(decodeIniText(bytes));
  const norm = locale?.toLowerCase() ?? null;
  if (norm === null) {
    return [
      item(
        "game-locale",
        "lang",
        "游戏语言",
        "warn",
        "BNet_Emu.ini 存在但解析不到语言键（可能编码异常）。",
        "读不出语言设置，无法确认游戏界面语言。",
        [
          "用记事本打开游戏目录下的 BNet_Emu.ini",
          "确认里面有 Locale=schinese 这一行",
          "若内容乱码，另存为 UTF-8 编码后重新检测",
        ],
      ),
    ];
  }
  const audioSuffix = localeAudio ? `，语音 LocaleAudio=${localeAudio}` : "";
  if (norm === "schinese" || norm === "zhcn") {
    return [item("game-locale", "lang", "游戏语言", "ok", `游戏语言：简体中文（Locale=${locale}${audioSuffix}）。`)];
  }
  return [
    item(
      "game-locale",
      "lang",
      "游戏语言",
      "warn",
      `游戏语言当前为 ${locale}${audioSuffix}，不是简体中文。「装了 mod 游戏变英文」通常就是这个文件被改动。`,
      "语言设置不是简体中文。",
      [
        "用记事本打开游戏目录下的 BNet_Emu.ini",
        "把 Locale= 和 LocaleAudio= 两行都改为 schinese",
        "保存后重新启动游戏",
      ],
    ),
  ];
}

function checkVersionGroup(
  gameDir: string | null,
  version: string | null,
  running: boolean | null,
): HealthCheckItem[] {
  const items: HealthCheckItem[] = [];
  if (gameDir) {
    items.push(
      version
        ? item(
            "game-version",
            "version",
            "游戏版本",
            "info",
            `当前游戏版本：${version}。向群友求助或反馈问题时，请附上此版本号。`,
          )
        : item("game-version", "version", "游戏版本", "info", "未能读取版本号（可重新检测）。"),
    );
  }
  if (running !== null) {
    items.push(
      running
        ? item(
            "game-running",
            "version",
            "游戏状态",
            "info",
            "游戏正在运行，检测结果基于磁盘当前文件。",
          )
        : item("game-running", "version", "游戏状态", "ok", "当前未检测到游戏进程。"),
    );
  }
  return items;
}

async function checkAvGroup(
  gameDir: string,
  defenderEx: string | null,
): Promise<HealthCheckItem[]> {
  // 整合包（emu 补丁）特征为门；正版环境整组跳过，不产噪音。
  if (!(await pathExists(joinPath(gameDir, "BNet_Emu.ini")))) {
    return [
      item(
        "av-core-files",
        "av",
        "核心文件",
        "info",
        "未检测到整合包特征文件（BNet_Emu.ini），跳过杀毒误报检查。",
      ),
    ];
  }
  const items: HealthCheckItem[] = [];
  const present: Record<string, boolean> = {};
  for (const f of CORE_EMU_FILES) {
    present[f] = await pathExists(joinPath(gameDir, f));
  }
  const missing = missingCoreFiles(present, CORE_EMU_FILES);
  if (missing.length === 0) {
    items.push(
      item(
        "av-core-files",
        "av",
        "核心文件",
        "ok",
        `核心运行库文件齐全（${CORE_EMU_FILES.join(" / ")}），未被杀毒软件误删。`,
      ),
    );
  } else {
    items.push(
      item(
        "av-core-files",
        "av",
        "核心文件",
        "fail",
        `缺少核心文件：${missing.join("、")} —— 很可能被杀毒软件误删，会导致游戏无法启动或直接闪退。`,
        "杀毒软件常把整合包的单机补丁文件当成病毒删除。",
        [
          "打开 Windows 安全中心 → 病毒和威胁防护 → 保护历史记录，还原被隔离的文件（其他杀毒软件类似）",
          "把游戏目录加入杀毒白名单：Windows 安全中心 → 病毒和威胁防护 → 管理设置 → 排除项 → 添加文件夹，选择游戏目录",
          "从整合包原始压缩包把缺失的文件重新解压回游戏目录",
          "完成后回到本页重新检测",
        ],
      ),
    );
  }
  // Defender 排除项：空值 = 查询失败/未知，该项直接不出现。
  if (defenderEx) {
    const entries = defenderEx
      .split("|")
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0);
    const whitelisted = entries.some((e) => gameDir.toLowerCase().startsWith(e));
    items.push(
      whitelisted
        ? item("av-defender-exclusion", "av", "Defender 白名单", "info", "游戏目录已在 Defender 排除项中。")
        : item(
            "av-defender-exclusion",
            "av",
            "Defender 白名单",
            "info",
            "游戏目录暂不在 Defender 排除项中。当前文件齐全可不管；若以后再出现文件被误删，按上面「核心文件」的步骤加白。",
          ),
    );
  }
  return items;
}

async function checkSaveGroup(): Promise<HealthCheckItem[]> {
  const dir = await saveRoot();
  if (!(await pathExists(dir))) {
    return [
      item("saves-dir", "saves", "存档目录", "info", `未找到存档目录（首次启动游戏后会自动生成）：${dir}`),
    ];
  }
  const oneDrive = /onedrive/i.test(dir);
  return [
    item(
      "saves-dir",
      "saves",
      "存档目录",
      "ok",
      oneDrive
        ? `存档目录正常：${dir}。注意：该目录位于 OneDrive 同步范围内，网盘同步偶发会造成存档冲突，建议关闭对该目录的同步。`
        : `存档目录正常：${dir}`,
    ),
  ];
}

function checkSystemGroup(
  longPaths: boolean | null,
  osVersion: string | null,
): HealthCheckItem[] {
  const items: HealthCheckItem[] = [];
  if (longPaths !== null) {
    items.push(
      longPaths
        ? item("long-paths", "system", "长路径支持", "ok", "系统已开启长路径支持。")
        : item(
            "long-paths",
            "system",
            "长路径支持",
            "info",
            "系统未开启长路径支持（Windows 默认 260 字符限制）。当前没遇到问题可不管；游戏目录较深时建议开启。",
            null,
            [`开启方法：${REG_OPEN_LONG_PATHS}`],
          ),
    );
  }
  if (osVersion) {
    items.push(item("os-version", "system", "操作系统", "info", `操作系统：${osVersion}`));
  }
  return items;
}

/**
 * Full read-only check. gameDir/knownModNames come from config (commands
 * layer); every group degrades independently, this never throws.
 */
export async function runHealthCheck(opts: {
  gameDir: string | null;
  knownModNames: string[];
}): Promise<HealthCheckResult> {
  const started = Date.now();
  const gameDir = opts.gameDir;
  const items: HealthCheckItem[] = [];

  const probe = await probeSystemWindows(gameDir ? joinPath(gameDir, "D2R.exe") : null);
  const v = probe.values;
  const longPaths = probe.ok && v["longPaths"] ? v["longPaths"] === "1" : null;
  const running = probe.ok && v["running"] ? v["running"] === "1" : null;
  const version = probe.ok ? v["version"] || null : null;
  const osVersion = probe.ok ? v["osVersion"] || null : null;
  const defenderEx = probe.ok ? normalizeDefenderEx(v["defenderEx"]) : null;

  // —— 游戏目录 ——（gameDir 未设置时目录依赖组全部跳过）
  try {
    if (!gameDir) {
      items.push(
        item(
          "game-dir-set",
          "path",
          "游戏目录",
          "fail",
          "尚未设置游戏目录，无法进行体检。",
          "先到「设置」页选择游戏根目录。",
          ["打开左侧「设置」页", "在「游戏目录」一栏选择游戏根目录（里面有 D2R.exe）", "回到本页重新检测"],
        ),
      );
    } else {
      items.push(item("game-dir-set", "path", "游戏目录", "ok", gameDir));
      items.push(...(await checkPathGroup(gameDir, opts.knownModNames, longPaths)));
      items.push(...(await checkLangGroup(gameDir)));
    }
  } catch (err) {
    console.warn("[d2rbox] health path/lang group failed:", err);
    items.push(degradedItem("path"), degradedItem("lang"));
  }

  // —— 版本信息 ——
  try {
    items.push(...checkVersionGroup(gameDir, version, running));
  } catch (err) {
    console.warn("[d2rbox] health version group failed:", err);
    items.push(degradedItem("version"));
  }

  // —— 杀毒误报 ——
  try {
    if (gameDir) items.push(...(await checkAvGroup(gameDir, defenderEx)));
  } catch (err) {
    console.warn("[d2rbox] health av group failed:", err);
    items.push(degradedItem("av"));
  }

  // —— 存档 / 系统 ——
  try {
    items.push(...(await checkSaveGroup()));
  } catch (err) {
    console.warn("[d2rbox] health saves group failed:", err);
    items.push(degradedItem("saves"));
  }
  try {
    items.push(...checkSystemGroup(longPaths, osVersion));
  } catch (err) {
    console.warn("[d2rbox] health system group failed:", err);
    items.push(degradedItem("system"));
  }

  return { gameDir, durationMs: Date.now() - started, items };
}
