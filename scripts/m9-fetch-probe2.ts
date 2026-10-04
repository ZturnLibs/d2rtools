/** Probe 2: isolate which hosts / IP families tjs curl can reach. */
async function tryFetch(label: string, url: string, timeoutMs = 10000): Promise<void> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: ac.signal });
    const text = await res.text();
    console.log(`${label}: ${res.status} (${Date.now() - t0}ms, ${text.length} bytes)`);
  } catch (err) {
    console.log(`${label}: FAIL (${Date.now() - t0}ms) ${String(err).slice(0, 100)}`);
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  await tryFetch("npmmirror", "https://registry.npmmirror.com/@zturnlibs/ztron-core/latest");
  await tryFetch("baidu", "https://www.baidu.com");
  await tryFetch("github-api", "https://api.github.com/repos/ZturnLibs/d2rtools");
  await tryFetch("jsdelivr", "https://cdn.jsdelivr.net/gh/ZturnLibs/d2rtools@main/README.md");
  await tryFetch("gitee", "https://gitee.com/api/v5/repos/openharmony/docs", 10000);
  console.log("probe2 done");
}
main();
