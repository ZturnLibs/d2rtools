/**
 * d2s 库探针：验证 stash write→read 回环 + item 产出字段形态。
 * 跑法：node scripts/probe-d2s.mjs
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const pkg = require("@dschu012/d2s");
const d2s = pkg.default ?? pkg;
const stash = require("@dschu012/d2s/lib/d2/stash.js");
const { constants: constants99 } = require("@dschu012/d2s/lib/data/versions/99_constant_data.js");

d2s.setConstantData(99, constants99);
d2s.setConstantData(105, constants99);

console.log("rune r01 =", JSON.stringify(constants99.other_items["r01"]));
console.log("gem gcv  =", JSON.stringify(constants99.other_items["gcv"]));

// --- 构造最小 item ---
function runeItem(page) {
  return {
    identified: true,
    simple_item: true,
    location_id: 0,
    equipped_id: 0,
    position_x: 0,
    position_y: 1,
    alt_position_id: 2,
    type: "r01",
    quality: 2,
    quantity: 3,
    socketed: false,
    _ioff: page,
  };
}

const stashData = {
  hardcore: false,
  sharedGold: 12345,
  version: "99",
  type: 0,
  pages: [
    { name: "Page1", type: 0, items: [runeItem(0), { ...runeItem(0), type: "gcv", position_x: 2 }] },
    { name: "Page2", type: 0, items: [{ ...runeItem(0), type: "r02", position_y: 3 }] },
  ],
};

const bytes = await stash.write(stashData, constants99, 105, {});
console.log("stash.write bytes =", bytes.length, "magic =", Array.from(bytes.slice(0, 4)).map((b) => b.toString(16)).join(" "));

const parsed = await stash.read(bytes, constants99, 99, {});
console.log("stash.version =", parsed.version, "pageCount =", parsed.pageCount, "hardcore =", parsed.hardcore, "gold =", parsed.sharedGold);
for (const [pi, p] of parsed.pages.entries()) {
  console.log(`page ${pi} name=${p.name} items=${p.items.length}`);
  for (const it of p.items) {
    console.log("  item:", JSON.stringify(
      {
        type: it.type,
        name: it.name,
        quality: it.quality,
        categories: it.categories,
        location_id: it.location_id,
        x: it.position_x,
        y: it.position_y,
        alt: it.alt_position_id,
        quantity: it.quantity,
        level: it.level,
        simple: it.simple_item,
      },
    ));
  }
}

// --- 字符 d2s 也要看看 write 是否可用 ---
console.log("\nd2s exports:", Object.keys(d2s).join(", "));
