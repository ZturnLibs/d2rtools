/**
 * M11 probe: prove the patched write path round-trips REAL stash files.
 * For every parseable d2i with items: read → write (same version/hardcore/
 * gold) → re-read → compare page count + every item's identifying fields.
 */
import { setConstantData } from "@dschu012/d2s/lib/d2/constants.js";
import { constants as constants96 } from "@dschu012/d2s/lib/data/versions/96_constant_data.js";
import { constants as constants99 } from "@dschu012/d2s/lib/data/versions/99_constant_data.js";
import * as stashLib from "@dschu012/d2s/lib/d2/stash.js";
import { listItemSources, parseItemFile } from "../src/services/itemview.js";
import { readStashHeader } from "../src/services/stash.js";

setConstantData(96, constants96);
setConstantData(99, constants99);
setConstantData(105, constants99);

const SAVE = "C:/Users/ZYJ/Saved Games/Diablo II Resurrected";

type AnyItem = Record<string, unknown>;

function itemKey(it: AnyItem): string {
  return [
    it.type,
    it.quality,
    `p${it.position_x},${it.position_y}`,
    it.ethereal ? "e" : "",
    it.socketed ? `s${it.nr_of_items_in_sockets ?? 0}` : "",
    typeof it.quantity === "number" ? `q${it.quantity}` : "",
  ].join("|");
}

interface Page {
  name?: string;
  type?: number;
  items: AnyItem[];
}

function toStash(pages: Page[], hardcore: boolean, gold: number) {
  return {
    hardcore,
    sharedGold: gold,
    pages: pages.map((p) => ({ name: "", type: 0, items: p.items ?? [] })),
  };
}

const groups = await listItemSources(SAVE);
let tried = 0;
for (const g of groups.groups) {
  for (const st of g.stashes) {
    const head = await readStashHeader(st.path);
    const parsed = await parseItemFile(st.path);
    if (parsed.kind !== "stash" || parsed.pages.every((p) => p.items.length === 0)) continue;
    tried++;
    const ver = head?.version ?? 99;
    const label = `${g.name}/${st.name} (v${ver} ${parsed.pageCount}p ${parsed.pages.reduce((n, p) => n + p.items.length, 0)} items)`;
    try {
      // raw items straight from the lib read (not DTOs) for byte-faithful write
      const bytes = await tjs.readFile(st.path);
      const raw = (await stashLib.read(bytes, constants99, 99, {})) as {
        hardcore: boolean;
        sharedGold: number;
        pages: Page[];
      };
      const out = await stashLib.write(toStash(raw.pages, raw.hardcore, raw.sharedGold), constants99, ver, {});
      const re = (await stashLib.read(out, constants99, 99, {})) as { pages: Page[] };
      const a = raw.pages.flatMap((p) => (p.items ?? []).map(itemKey)).sort();
      const b = re.pages.flatMap((p) => (p.items ?? []).map(itemKey)).sort();
      if (a.length !== b.length) throw new Error(`count ${a.length} → ${b.length}`);
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) throw new Error(`item diff: ${a[i]} vs ${b[i]}`);
      }
      console.log(`✓ ${label}: roundtrip exact (${out.length}B, was ${bytes.length}B)`);
    } catch (err) {
      console.log(`✗ ${label}: ${String(err).slice(0, 140)}`);
    }
  }
}
console.log(tried === 0 ? "no parseable stashes with items found" : `probe done (${tried} files)`);
