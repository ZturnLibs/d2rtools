/**
 * M9 probe: exercise the new services against the live network + disk on the
 * vendored tjs. Expected outcomes are annotated per step; failures that are
 * EXPECTED on the reference network are marked [degraded-ok].
 */
import { fetchModIndex, parseModIndex } from "../src/services/modindex.js";
import { checkModUpdate, parseUpdateMeta, compareVersions } from "../src/services/modupdate.js";
import { stageFromUrl } from "../src/services/zipinstall.js";
import { stageRoot } from "../src/services/zipinstall.js";
import { joinPath } from "../src/services/paths.js";

async function step(label: string, fn: () => Promise<string>): Promise<void> {
  const t0 = Date.now();
  try {
    const msg = await fn();
    console.log(`✓ ${label} (${Date.now() - t0}ms): ${msg}`);
  } catch (err) {
    console.log(`✗ ${label} (${Date.now() - t0}ms): ${String(err).slice(0, 200)}`);
  }
}

async function main(): Promise<void> {
  console.log("== unit-level sanity ==");
  console.log(
    "parseUpdateMeta spaced keys:",
    JSON.stringify(
      parseUpdateMeta({ "Mod Version": "0.1.2", "Mod Config Download": "https://a/c.json" }),
    ),
  );
  console.log("compareVersions 1.2.10 > 1.2.9:", compareVersions("1.2.10", "1.2.9") > 0);

  console.log("\n== live network ==");
  await step("fetchModIndex (mirrors → bundled)", async () => {
    const r = await fetchModIndex();
    return `via=${r.via} entries=${r.doc.entries.length} bundledFallback=${r.bundledFallback} errors=${(r.errorsText ?? "").slice(0, 120)}`;
  });

  await step("parseModIndex bundled copy shape", async () => {
    // parseModIndex already exercised inside fetchModIndex; assert entry shape here
    const r = await fetchModIndex();
    if (r.doc.entries.length === 0) throw new Error("bundled entries empty");
    const e = r.doc.entries[0]!;
    if (!e.id || !e.name) throw new Error("entry missing id/name");
    return `first=${e.id}(${e.name}) downloadUrl=${e.downloadUrl}`;
  });

  await step("checkModUpdate against a real reachable json (npmmirror)", async () => {
    // npmmirror serves real JSON over HTTPS — not our config schema, but the
    // lenient reader should surface a version if the doc happens to have one
    // (registry docs do: "version"). This proves network+parse; hasUpdate is
    // informational here.
    const dir = joinPath(tjs.tmpDir, "m9-probe-mod", "EJ");
    await tjs.makeDir(dir, { recursive: true });
    await tjs.writeFile(
      joinPath(dir, "modinfo.json"),
      new TextEncoder().encode(
        JSON.stringify({
          name: "EJ",
          savepath: "EJ",
          "Mod Version": "0.0.1",
          "Mod Config Download": "https://registry.npmmirror.com/@zturnlibs/ztron-core/latest",
        }),
      ),
    );
    const s = await checkModUpdate({ modDir: dir, dirName: "EJ" });
    return `supported=${s.supported} remote=${s.remoteVersion} hasUpdate=${s.hasUpdate} err=${s.error ?? "-"}`;
  });

  await step("stageFromUrl rejects non-zip payload [degraded-ok expected]", async () => {
    try {
      await stageFromUrl("https://registry.npmmirror.com/fflate/-/fflate-0.8.2.tgz");
      return "UNEXPECTED: tgz passed as zip";
    } catch (err) {
      const msg = String(err);
      if (msg.includes("文件头校验失败") || msg.includes("未找到可识别")) {
        return `correctly rejected: ${msg.slice(0, 80)}`;
      }
      throw err;
    }
  });

  await step("stageFromUrl rejects a dead host with a readable error", async () => {
    try {
      await stageFromUrl("https://no-such-host-9f2d.invalid/x.zip", { timeoutMs: 5000 });
      return "UNEXPECTED: dead host passed";
    } catch (err) {
      return `correctly rejected: ${String(err).slice(0, 100)}`;
    }
  });

  console.log("\n== stage root ==");
  console.log("stageRoot:", stageRoot());

  // parseModIndex export check (mirrors the command-layer parse)
  parseModIndex(JSON.stringify({ v: 1, updatedAt: "x", entries: [{ id: "a", name: "b" }] }));
  console.log("parseModIndex minimal doc: ok");
  console.log("probe done");
}
main();
