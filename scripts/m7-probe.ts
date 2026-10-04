/**
 * M7 实机探针：在真实 tjs 下跑 itemview 服务（与打包同款 esbuild 参数），
 * 对真实存档目录做来源扫描 + 解析，定位 物品清单 页报错。
 * --commands 模式走 d2r:itemSources / d2r:itemView 命令处理器全链路
 * （含 saveRoot 路径校验），与前端 invoke 完全一致。
 */
import { listItemSources, parseItemFile } from "../src/services/itemview.js";
import { commandDefs } from "../src/commands.js";

const saveDir = "C:/Users/ZYJ/Saved Games/Diablo II Resurrected";
const t0 = Date.now();
const COMMANDS = false; // 改 true 走命令处理器全链路（tjs 无 process 全局）

if (COMMANDS) {
  const src = await commandDefs.itemSources.handler({} as never, undefined as never);
  console.log("[probe] itemSources groups:", src.groups.length);
  const root = src.groups.find((g) => g.slot === "root");
  if (root?.stashes[0]) {
    const r = await commandDefs.itemView.handler({ path: root.stashes[0]!.path } as never, undefined as never);
    console.log("[probe] itemView stash kind:", r.kind);
  }
  if (root?.characters[0]) {
    const r = await commandDefs.itemView.handler({ path: root.characters[0]!.path } as never, undefined as never);
    console.log(
      "[probe] itemView char:",
      JSON.stringify(
        r.kind === "character"
          ? { kind: r.kind, name: r.name, groups: r.groups.length }
          : r.kind === "character-partial"
            ? { kind: r.kind, name: r.name }
            : r,
      ),
    );
  }
  console.log("[probe] commands done in", Date.now() - t0, "ms");
}

try {
  const { groups } = await listItemSources(saveDir);
  for (const g of groups) {
    console.log(
      `[probe] group=${g.name} exists=${g.exists} stashes=${g.stashes.length} chars=${g.characters.length}`,
    );
  }
  const root = groups[0];
  if (root?.stashes[0]) {
    const r = await parseItemFile(root.stashes[0]!.path);
    const brief =
      r.kind === "stash"
        ? { kind: r.kind, version: r.version, pages: r.pageCount, gold: r.sharedGold }
        : r;
    console.log("[probe] stash:", JSON.stringify(brief).slice(0, 500));
  } else {
    console.log("[probe] no root stash");
  }
  if (root?.characters[0]) {
    const r = await parseItemFile(root.characters[0]!.path);
    const brief =
      r.kind === "character"
        ? { kind: r.kind, name: r.name, class: r.className, level: r.level, groups: r.groups.map((g) => `${g.where}:${g.items.length}`) }
        : r.kind === "character-partial"
          ? { kind: r.kind, name: r.name, class: r.className, level: r.level }
          : r;
    console.log("[probe] char:", JSON.stringify(brief).slice(0, 500));
  } else {
    console.log("[probe] no root char");
  }
  console.log("[probe] done in", Date.now() - t0, "ms");
} catch (err) {
  console.error("[probe] FATAL:", err);
}
