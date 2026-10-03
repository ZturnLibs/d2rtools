/**
 * Ambient types for the @dschu012/d2s subpath modules the app imports.
 * The package only ships types for its main entry (lib/index.d.ts), which
 * does NOT re-export the stash reader — the D2R multi-sector .d2i path we
 * need lives in lib/d2/stash.js, reached via subpath import (no "exports"
 * field in its package.json, so subpaths resolve). Types mirror the parsed
 * shapes the library actually produces (lib/d2/types.d.ts + observed).
 *
 * The library is pure Uint8Array JS (no Buffer/node builtins), so it runs
 * unmodified under both tjs and the vitest node shim.
 */

declare module "@dschu012/d2s/lib/d2/stash.js" {
  export interface StashPage {
    name: string;
    type: number;
    items: unknown[];
  }
  export interface StashData {
    type?: number;
    hardcore?: boolean;
    version?: string;
    sharedGold?: number;
    pageCount?: number;
    pages: StashPage[];
  }
  export function read(
    buffer: Uint8Array,
    constants?: unknown,
    version?: number,
    userConfig?: Record<string, unknown>,
  ): Promise<StashData>;
  export function write(
    data: StashData,
    constants?: unknown,
    version?: number,
    userConfig?: Record<string, unknown>,
  ): Promise<Uint8Array>;
}

declare module "@dschu012/d2s/lib/d2/d2s.js" {
  export interface D2Char {
    header: {
      name?: string;
      class?: string;
      level?: number;
      title?: string;
      version?: number;
      status?: { expansion?: boolean; hardcore?: boolean; died?: boolean };
      [key: string]: unknown;
    };
    [key: string]: unknown;
  }
  export function read(
    buffer: Uint8Array,
    constants?: unknown,
    userConfig?: Record<string, unknown>,
  ): Promise<D2Char>;
}

declare module "@dschu012/d2s/lib/d2/constants.js" {
  export function getConstantData(version: number): unknown;
  export function setConstantData(version: number, data: unknown): void;
}

declare module "@dschu012/d2s/lib/data/versions/99_constant_data.js" {
  export const constants: Record<string, any>;
}
