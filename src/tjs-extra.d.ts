/**
 * Corrected ambient surface for the txiki.js `tjs` global as vendored in
 * ztron (native/txiki.js). The stock tjs-global.d.ts in ztron core drifts
 * from the runtime in three places that matter to this app:
 *   - readDir resolves to an async-iterable Dir (NOT an array); entries
 *     carry `name` plus isFile/isDirectory getters (src/js/core/fs.js).
 *   - remove() accepts { recursive, maxRetries, retryDelay } (rimraf port).
 *   - link(src, dst) exists (uv_fs_link -> CreateHardLinkW, NTFS same-volume,
 *     no elevation needed) — the backbone of our hardlink install mode.
 * Also declares the encoding/b64 globals the backend relies on.
 */

interface TjsDirEnt {
  readonly name: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymlink: boolean;
}

interface TjsDir {
  readonly path: string;
  [Symbol.asyncIterator](): AsyncIterableIterator<TjsDirEnt>;
  close(): Promise<void>;
}

interface TjsFile {
  read(length: number): Promise<Uint8Array>;
  write(data: Uint8Array | string): Promise<number>;
  seek(offset: number, whence?: string): Promise<number>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

interface TjsStat {
  size: number;
  mode: number;
  mtim: Date;
  birthtim: Date;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymlink: boolean;
}

/** Child-process pipe: a real ReadableStream (getReader works) plus
 *  convenience text()/bytes() drains (txiki core/process.js). */
interface TjsProcessReadableStream extends ReadableStream<Uint8Array> {
  text(): Promise<string>;
  bytes(): Promise<Uint8Array>;
}

interface TjsSubprocess {
  pid: number;
  stdin: { write(data: Uint8Array | string): Promise<void>; close(): void } | null;
  stdout: TjsProcessReadableStream | null;
  stderr: TjsProcessReadableStream | null;
  wait(): Promise<{ exited: boolean; exit_status: number; term_signal: number | null }>;
  kill(sig?: string | number): void;
}

declare const tjs: {
  readonly env: Record<string, string | undefined>;
  readonly args: string[];
  /** String properties, not methods (per tjs-types/txikijs.d.ts). */
  readonly homeDir: string;
  readonly tmpDir: string;
  readonly cwd: string;
  exit(code?: number): void;

  stat(path: string): Promise<TjsStat>;
  readDir(path: string): Promise<TjsDir>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  makeDir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
  remove(
    path: string,
    options?: { recursive?: boolean; maxRetries?: number; retryDelay?: number },
  ): Promise<void>;
  copyFile(src: string, dest: string): Promise<void>;
  rename(src: string, dest: string): Promise<void>;
  link(src: string, dst: string): Promise<void>;
  open(path: string, flags?: string, mode?: number): Promise<TjsFile>;

  spawn(
    cmd: string[],
    options?: {
      stdin?: "pipe" | "inherit" | "ignore";
      stdout?: "pipe" | "inherit" | "ignore";
      stderr?: "pipe" | "inherit" | "ignore";
      cwd?: string;
      env?: Record<string, string>;
    },
  ): TjsSubprocess;
};

declare const atob: (data: string) => string;
declare const btoa: (data: string) => string;
declare const TextEncoder: {
  new (): { encode(input?: string): Uint8Array };
};
declare const TextDecoder: {
  new (label?: string): { decode(input?: Uint8Array): string };
};
