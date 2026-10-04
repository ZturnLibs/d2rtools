/**
 * Online mod index (M9): a small self-maintained JSON listing vetted mod
 * sources — pure metadata (name/author/version/homepage/download URL), no
 * rehosted files (红线). Canonical copy lives in this repo at
 * docs/mod-index.json; the backend tries CN-reachable mirrors in order and
 * finally falls back to the copy bundled at build time, so the page renders
 * even with every mirror down.
 *
 * Mirror reality on the reference machine (2026-10, tjs curl):
 *   jsdelivr GH CDN  ✅ (flaky — keep timeout short, next candidate cheap)
 *   api.github.com   ⚠ often times out; contents API returns base64
 *   raw.githubusercontent ❌ walled — never a candidate
 */
import { fetchWithTimeout } from "./net.js";
import { BUNDLED_MOD_INDEX, BUNDLED_INDEX_FETCHED_AT } from "../bundled-mod-index.js";

export interface ModIndexEntry {
  id: string;
  name: string;
  author: string;
  /** "chinese-pack" | "foreign" — display-only today, filterable later. */
  category: string;
  version: string;
  language?: string;
  homepage: string | null;
  /** Author direct link (红线: never our own mirror). Null = manual import. */
  downloadUrl: string | null;
  /** Optional per-entry remote config json (D2RLaunch convention). */
  configUrl: string | null;
  description: string;
  notes?: string;
}

export interface ModIndexDoc {
  v: number;
  updatedAt: string;
  entries: ModIndexEntry[];
}

const REPO = "ZturnLibs/d2rtools";
const BRANCH = "main";
const INDEX_PATH = "docs/mod-index.json";

interface MirrorCandidate {
  url: string;
  /** Post-process a successful body into the raw index json text. */
  transform?: (body: string) => string;
}

export function indexMirrors(): MirrorCandidate[] {
  return [
    {
      url: `https://cdn.jsdelivr.net/gh/${REPO}@${BRANCH}/${INDEX_PATH}`,
    },
    {
      url: `https://api.github.com/repos/${REPO}/contents/${INDEX_PATH}`,
      transform: (body) => {
        const parsed = JSON.parse(body) as { content?: string; encoding?: string };
        if (parsed.encoding !== "base64" || typeof parsed.content !== "string") {
          throw new Error("api.github.com 返回了意外的格式");
        }
        return atob(parsed.content.replace(/\s/g, ""));
      },
    },
  ];
}

/** Structural validation so a corrupted mirror can't poison the page. */
export function parseModIndex(text: string): ModIndexDoc {
  const doc = JSON.parse(text) as Partial<ModIndexDoc>;
  if (!doc || typeof doc !== "object" || doc.v !== 1 || !Array.isArray(doc.entries)) {
    throw new Error("清单格式不正确（需要 v:1 + entries 数组）");
  }
  const entries: ModIndexEntry[] = [];
  for (const raw of doc.entries) {
    if (!raw || typeof raw !== "object") continue;
    if (typeof raw.id !== "string" || typeof raw.name !== "string") continue;
    entries.push({
      id: raw.id,
      name: raw.name,
      author: typeof raw.author === "string" ? raw.author : "未知作者",
      category: typeof raw.category === "string" ? raw.category : "foreign",
      version: typeof raw.version === "string" ? raw.version : "-",
      language: typeof raw.language === "string" ? raw.language : undefined,
      homepage: typeof raw.homepage === "string" && raw.homepage ? raw.homepage : null,
      downloadUrl:
        typeof raw.downloadUrl === "string" && raw.downloadUrl ? raw.downloadUrl : null,
      configUrl: typeof raw.configUrl === "string" && raw.configUrl ? raw.configUrl : null,
      description: typeof raw.description === "string" ? raw.description : "",
      notes: typeof raw.notes === "string" ? raw.notes : undefined,
    });
  }
  return { v: 1, updatedAt: String(doc.updatedAt ?? ""), entries };
}

export interface IndexFetchResult {
  doc: ModIndexDoc;
  via: string;
  /** True when only the bundled copy could be reached. */
  bundledFallback: boolean;
  /** Mirror failure detail — surfaced when bundledFallback is true. */
  errorsText: string | null;
}

/**
 * Try each mirror, then the bundled copy. Total failure is impossible here —
 * the bundled fallback always answers — but `bundledFallback` + `errorsText`
 * let the UI say "在线清单暂不可达" honestly.
 */
export async function fetchModIndex(timeoutMs = 10_000): Promise<IndexFetchResult> {
  const errors: string[] = [];
  for (const candidate of indexMirrors()) {
    try {
      const res = await fetchWithTimeout(candidate.url, { timeoutMs });
      if (!res.ok) {
        errors.push(`${new URL(candidate.url).host} → HTTP ${res.status}`);
        continue;
      }
      const body = await res.text();
      const text = candidate.transform ? candidate.transform(body) : body;
      return {
        doc: parseModIndex(text),
        via: new URL(candidate.url).host,
        bundledFallback: false,
        errorsText: null,
      };
    } catch (err) {
      errors.push(`${new URL(candidate.url).host} → ${String(err).slice(0, 100)}`);
    }
  }
  return {
    doc: {
      v: 1,
      updatedAt: BUNDLED_INDEX_FETCHED_AT,
      entries: BUNDLED_MOD_INDEX.entries.map((e) => ({ ...e })) as ModIndexEntry[],
    },
    via: "bundled",
    bundledFallback: true,
    errorsText: errors.length > 0 ? errors.join("；") : null,
  };
}
