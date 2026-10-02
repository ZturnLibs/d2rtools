/**
 * Bundle scripts/phase3-probe.ts exactly like the ztron CLI bundles the
 * backend (platform=neutral, tjs:* external), then run it with the vendored
 * tjs from the project root.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

// esbuild ships with the ztron CLI's dependency tree (same one the dev
// pipeline uses); pnpm keeps it under .pnpm, so resolve from there.
const cliRequire = createRequire(
  path.join(root, "node_modules", "@zturnlibs", "ztron-cli", "package.json"),
);
let build;
try {
  ({ build } = cliRequire("esbuild"));
} catch {
  const esbuildPkg = path.join(
    root, "node_modules", ".pnpm", "esbuild@0.25.12", "node_modules", "esbuild", "package.json",
  );
  ({ build } = createRequire(esbuildPkg)("esbuild"));
}

const outDir = path.join(root, "src", ".ztron");
mkdirSync(outDir, { recursive: true });
const entry = process.argv[2] ?? "phase3-probe.ts";
const outfile = path.join(outDir, entry.replace(/\.ts$/, ".mjs"));

await build({
  entryPoints: [path.join(root, "scripts", entry)],
  bundle: true,
  platform: "neutral",
  format: "esm",
  external: ["tjs:*"],
  outfile,
  logLevel: "warning",
});

const tjs = process.env.ZTRON_TJS ?? path.join(root, "native", "libs", "tjs.exe");
const r = spawnSync(tjs, ["run", outfile], { cwd: root, stdio: "inherit" });
process.exit(r.status ?? 1);
