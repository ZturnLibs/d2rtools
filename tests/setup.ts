/**
 * Test-side shim of the TxikiJS `tjs` global (see src/tjs-extra.d.ts),
 * backed by node:fs/promises. Installed on globalThis before any service
 * module is imported, so src/services code runs unmodified under Node.
 *
 * Safety: homeDir / tmpDir / env.APPDATA are redirected into mkdtemp dirs
 * under os.tmpdir(). A beforeEach guard fails any test that somehow ends up
 * pointing back at the real %APPDATA% / Saved Games.
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach } from "vitest";

interface ShimState {
  homeDir: string;
  tmpDir: string;
  env: Record<string, string | undefined>;
}

function freshDefaultRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "d2rbox-tjs-default-"));
  fs.mkdirSync(path.join(root, "home"), { recursive: true });
  fs.mkdirSync(path.join(root, "AppData", "Roaming"), { recursive: true });
  return root;
}

const defaultRoot = freshDefaultRoot();

const state: ShimState = {
  homeDir: path.join(defaultRoot, "home"),
  tmpDir: defaultRoot,
  env: { APPDATA: path.join(defaultRoot, "AppData", "Roaming") },
};

function toTjsStat(st: fs.Stats): TjsStat {
  return {
    size: st.size,
    mode: st.mode,
    mtim: st.mtime,
    birthtim: st.birthtime,
    isFile: st.isFile(),
    isDirectory: st.isDirectory(),
    isSymlink: st.isSymbolicLink(),
  };
}

const tjsShim: typeof tjs = {
  get env() {
    return state.env;
  },
  get homeDir() {
    return state.homeDir;
  },
  get tmpDir() {
    return state.tmpDir;
  },
  args: [],
  cwd: process.cwd(),
  exit(code = 0): void {
    throw new Error(`tjs.exit(${code}) called in tests`);
  },

  async stat(p: string): Promise<TjsStat> {
    return toTjsStat(await fsp.stat(p));
  },

  async readDir(p: string): Promise<TjsDir> {
    const entries = await fsp.readdir(p, { withFileTypes: true });
    return {
      path: p,
      async *[Symbol.asyncIterator](): AsyncIterableIterator<TjsDirEnt> {
        for (const e of entries) {
          yield {
            name: e.name,
            isFile: e.isFile(),
            isDirectory: e.isDirectory(),
            isSymlink: e.isSymbolicLink(),
          };
        }
      },
      close(): Promise<void> {
        return Promise.resolve();
      },
    };
  },

  async readFile(p: string): Promise<Uint8Array> {
    return new Uint8Array(await fsp.readFile(p));
  },

  async writeFile(p: string, data: Uint8Array | string): Promise<void> {
    const buf =
      typeof data === "string"
        ? Buffer.from(data, "utf8")
        : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    await fsp.writeFile(p, buf);
  },

  async makeDir(p: string, options?: { recursive?: boolean }): Promise<void> {
    await fsp.mkdir(p, { recursive: options?.recursive === true });
  },

  async remove(
    p: string,
    options?: { recursive?: boolean; maxRetries?: number; retryDelay?: number },
  ): Promise<void> {
    await fsp.rm(p, {
      recursive: options?.recursive === true,
      force: true,
      maxRetries: options?.maxRetries ?? 0,
      retryDelay: options?.retryDelay ?? 100,
    });
  },

  async copyFile(src: string, dest: string): Promise<void> {
    await fsp.copyFile(src, dest);
  },

  async rename(src: string, dest: string): Promise<void> {
    await fsp.rename(src, dest);
  },

  async link(src: string, dst: string): Promise<void> {
    await fsp.link(src, dst);
  },

  async open(p: string, flags = "r"): Promise<TjsFile> {
    const handle = await fsp.open(p, flags.includes("w") ? "w" : "r");
    let pos = 0;
    return {
      async read(length: number): Promise<Uint8Array> {
        const buf = Buffer.alloc(Math.max(0, length));
        const { bytesRead } = await handle.read(buf, 0, buf.length, pos);
        pos += bytesRead;
        return new Uint8Array(buf.buffer, 0, bytesRead);
      },
      async write(data: Uint8Array | string): Promise<number> {
        const buf =
          typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        const { bytesWritten } = await handle.write(buf, 0, buf.length, pos);
        pos += bytesWritten;
        return bytesWritten;
      },
      async seek(offset: number, whence = "set"): Promise<number> {
        if (whence.includes("cur")) pos += offset;
        else if (whence.includes("end")) pos = (await handle.stat()).size + offset;
        else pos = offset;
        return pos;
      },
      async flush(): Promise<void> {
        await handle.sync();
      },
      async close(): Promise<void> {
        await handle.close();
      },
    };
  },

  spawn(): TjsSubprocess {
    throw new Error("tjs.spawn is not available in tests (process spawning is stubbed)");
  },
};

(globalThis as Record<string, unknown>).tjs = tjsShim;

// ---------------------------------------------------------------------------
// Helpers for tests
// ---------------------------------------------------------------------------

export interface TestSandbox {
  root: string;
  /** redirected tjs.homeDir — stand-in for %UserProfile% */
  home: string;
  /** redirected tjs.env.APPDATA */
  appdata: string;
  cleanup(): Promise<void>;
}

/**
 * Point homeDir / tmpDir / APPDATA at a fresh temp dir and hand it to the
 * test. Call in beforeEach; cleanup() removes the whole tree.
 */
export async function makeSandbox(): Promise<TestSandbox> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "d2rbox-test-"));
  const home = path.join(root, "home");
  const appdata = path.join(root, "AppData", "Roaming");
  await fsp.mkdir(home, { recursive: true });
  await fsp.mkdir(appdata, { recursive: true });
  state.homeDir = home;
  state.tmpDir = root;
  state.env = { ...state.env, APPDATA: appdata };
  return {
    root,
    home,
    appdata,
    cleanup: () => fsp.rm(root, { recursive: true, force: true }),
  };
}

export function setTestEnv(key: string, value: string | undefined): void {
  state.env[key] = value;
}

function underTmp(p: string): boolean {
  const tmp = path.normalize(os.tmpdir()).toLowerCase();
  const norm = path.normalize(p).toLowerCase();
  return norm === tmp || norm.startsWith(tmp + path.sep) || norm.startsWith(tmp + "\\");
}

/** Hard guard: never let a test touch the real profile / %APPDATA%. */
beforeEach(() => {
  if (!underTmp(tjsShim.homeDir)) {
    throw new Error(`test safety: tjs.homeDir escaped tmp: ${tjsShim.homeDir}`);
  }
  const appdata = tjsShim.env.APPDATA;
  if (appdata === undefined || !underTmp(appdata)) {
    throw new Error(`test safety: tjs.env.APPDATA escaped tmp: ${String(appdata)}`);
  }
});
