/**
 * 作者脚本（mods\<mod>\ 顶层的 .bat/.cmd）— 扫描 + 受控运行。整合包里的
 * bat 多是 MDK 整合包的外来脚本：引用可能不存在的目标（mods\MDK\...）、
 * 结尾强制 taskkill D2R.exe 或裸启 D2R.exe。所以扫描阶段就做副作用标注
 * （关游戏 / 启游戏 / 等按键）和引用目标存在性检测，把知情权放在执行前。
 *
 * 编码：bat 几乎都是 GBK + CRLF。副作用/目标分析只看 ASCII 结构（taskkill、
 * start、D2R.exe、pause、mods\ 路径），GBK 高位字节按 latin1 展开后不影响
 * ASCII 匹配；正文以 b64 原始字节给前端，由 decodeText（UTF-8 → GBK 兜底）
 * 解码。
 */
import { joinPath, modDir, pathExists, isValidModName } from "./paths.js";

const MAX_SCRIPT_BYTES = 256 * 1024;
const RUN_TIMEOUT_MS = 60_000; // 脚本要求按键而 stdin 已关时应立即过；这是兜底

export interface ScriptSideEffects {
  killsGame: boolean;
  launchesGame: boolean;
  pauses: boolean;
}

export interface ScriptInfo {
  name: string;
  path: string;
  size: number;
  mtime: number;
  sideEffects: ScriptSideEffects;
  /** 脚本引用的 mods\<name> 路径在游戏目录里不存在时的段名列表 */
  missingTargets: string[];
  /** true = 内容超过 256KB，b64 只含前缀 */
  truncated: boolean;
  b64: string;
}

export interface ModScripts {
  mod: string;
  scripts: ScriptInfo[];
}

function isScriptName(name: string): boolean {
  return /\.(bat|cmd)$/i.test(name);
}

/** bytes → latin1 安全串（仅用于 ASCII 结构分析，不用于展示） */
function bytesToAscii(bytes: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return s;
}

function b64Of(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** 逐行扫描（跳过 rem/:: 注释行），返回副作用与引用的 mods\ 目标段 */
function analyzeScript(ascii: string): {
  sideEffects: ScriptSideEffects;
  refs: string[];
} {
  const sideEffects: ScriptSideEffects = {
    killsGame: false,
    launchesGame: false,
    pauses: false,
  };
  const refs = new Set<string>();
  for (const rawLine of ascii.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || /^rem\b/i.test(line) || line.startsWith("::")) continue;
    if (!sideEffects.killsGame && /\btaskkill\b/i.test(line)) sideEffects.killsGame = true;
    if (
      !sideEffects.launchesGame &&
      !/\btaskkill\b/i.test(line) &&
      /^\s*(start(\s+"[^"]*")?\s+)?["']?(\.\\|\.\/)?D2R\.exe\b/i.test(rawLine)
    ) {
      sideEffects.launchesGame = true;
    }
    if (!sideEffects.pauses && /\bpause\b/i.test(line)) sideEffects.pauses = true;
    // 引用目标：mods\MDK\... / mods/MDK/...（含 .\mods 前缀），取首段
    const m = /\bmods[\\/]+([^\s"'&|^<>]+?)[\\/]/i.exec(line);
    if (m?.[1]) refs.add(m[1]);
  }
  return { sideEffects, refs: [...refs] };
}

/**
 * 扫描各 mod 目录顶层的 .bat/.cmd。只看顶层——作者脚本约定放在 mod 根，
 * 深层的属于 mod 自带工具链，不对外暴露。
 */
export async function scanModScripts(
  gameDir: string,
  modNames: string[],
): Promise<{ mods: ModScripts[] }> {
  const out: ModScripts[] = [];
  for (const mod of modNames) {
    if (!isValidModName(mod)) continue;
    const dir = modDir(gameDir, mod);
    let entries: { name: string; isFile: boolean }[] = [];
    try {
      const d = await tjs.readDir(dir);
      for await (const e of d) {
        if (e.isFile) entries.push({ name: e.name, isFile: true });
      }
    } catch {
      continue; // mod 目录刚好消失 — 忽略
    }
    const files = entries
      .filter((e) => isScriptName(e.name))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));

    const scripts: ScriptInfo[] = [];
    for (const name of files) {
      const path = joinPath(dir, name);
      let bytes: Uint8Array<ArrayBufferLike> = new Uint8Array();
      let size = 0;
      let mtime = 0;
      let truncated = false;
      try {
        const st = await tjs.stat(path);
        size = st.size;
        mtime = st.mtim instanceof Date ? st.mtim.getTime() : 0;
        const all = await tjs.readFile(path);
        if (all.length > MAX_SCRIPT_BYTES) {
          truncated = true;
          bytes = all.subarray(0, MAX_SCRIPT_BYTES);
        } else {
          bytes = all;
        }
      } catch {
        continue;
      }
      const { sideEffects, refs } = analyzeScript(bytesToAscii(bytes));
      const missingTargets: string[] = [];
      for (const seg of refs) {
        if (!(await pathExists(joinPath(gameDir, "mods", seg)))) {
          missingTargets.push(seg);
        }
      }
      scripts.push({
        name,
        path,
        size,
        mtime,
        sideEffects,
        missingTargets,
        truncated,
        b64: b64Of(bytes),
      });
    }
    if (scripts.length > 0) out.push({ mod, scripts });
  }
  return { mods: out };
}

export interface ScriptRunLine {
  stream: "out" | "err";
  b64: string;
}

export interface ScriptRunResult {
  code: number | null;
  timedOut: boolean;
}

function b64Chunk(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/**
 * 以游戏根为 cwd 运行单个 bat（这些脚本按 `.\mods\...` 相对路径写死，
 * cwd 错了全盘失败）。stdout/stderr 逐行回调（原始字节 b64，编码由前端
 * 解）。stdin 关闭：pause 读到 EOF 直接过。60s 兜底 kill，防止极端脚本
 * 卡死通道。
 */
export async function runModScript(opts: {
  gameDir: string;
  modName: string;
  fileName: string;
  onLine: (l: ScriptRunLine) => void;
}): Promise<ScriptRunResult> {
  if (!isValidModName(opts.modName)) {
    throw new Error(`非法 mod 名：${JSON.stringify(opts.modName)}`);
  }
  if (!isScriptName(opts.fileName) || /[\\/]/.test(opts.fileName) || opts.fileName.includes("..")) {
    throw new Error(`非法脚本名：${JSON.stringify(opts.fileName)}`);
  }
  const base = modDir(opts.gameDir, opts.modName);
  const path = joinPath(base, opts.fileName);
  if (!(await pathExists(path))) {
    throw new Error(`脚本不存在：mods\\${opts.modName}\\${opts.fileName}`);
  }

  const proc = tjs.spawn(["cmd.exe", "/c", path], {
    cwd: opts.gameDir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
  }, RUN_TIMEOUT_MS);

  async function pump(
    stream: ReadableStream<Uint8Array> | null,
    which: "out" | "err",
  ): Promise<void> {
    if (!stream) return;
    const reader = stream.getReader();
    let carry: Uint8Array = new Uint8Array();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      // 按 \n 切行；行尾 \r 去掉——但保留原始字节给 b64（GBK 多字节不含
      // 0x0A/0x0D，按字节切行安全）
      const buf = new Uint8Array(carry.length + value.length);
      buf.set(carry, 0);
      buf.set(value, carry.length);
      let start = 0;
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] === 0x0a) {
          let end = i;
          if (end > start && buf[end - 1] === 0x0d) end--;
          opts.onLine({ stream: which, b64: b64Chunk(buf.subarray(start, end)) });
          start = i + 1;
        }
      }
      carry = buf.subarray(start);
    }
    if (carry.length > 0) {
      let end = carry.length;
      if (end > 0 && carry[end - 1] === 0x0d) end--;
      if (end > 0) opts.onLine({ stream: which, b64: b64Chunk(carry.subarray(0, end)) });
    }
  }

  try {
    const [, , status] = await Promise.all([
      pump(proc.stdout, "out"),
      pump(proc.stderr, "err"),
      proc.wait(),
    ]);
    return { code: status.exit_status ?? null, timedOut };
  } finally {
    clearTimeout(timer);
  }
}
