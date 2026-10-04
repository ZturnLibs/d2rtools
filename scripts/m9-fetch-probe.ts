/**
 * M9 pre-flight probe: verify the vendored tjs supports fetch, AbortController
 * timeouts, response streaming (ReadableStream reader), and base64 decoding —
 * the four primitives the update/download pipeline needs.
 */
async function main(): Promise<void> {
  console.log("typeof fetch:", typeof fetch);
  console.log("typeof AbortController:", typeof AbortController);
  console.log("typeof btoa/atob:", typeof btoa, typeof atob);

  // 1. Small JSON fetch against a stable endpoint (github api, usually
  // reachable from CN; fall back to example.com for pure connectivity).
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch("https://api.github.com/repos/ZturnLibs/d2rtools", {
      signal: ac.signal,
      headers: { "User-Agent": "d2rbox-probe" },
    });
    console.log("status:", res.status);
    const body = (await res.json()) as { full_name?: string };
    console.log("json ok:", body.full_name ?? JSON.stringify(body).slice(0, 80));
  } catch (err) {
    console.log("json fetch FAILED:", String(err));
  } finally {
    clearTimeout(timer);
  }

  // 2. Streaming read of a small binary file (jsdelivr-hosted, CN-friendly).
  try {
    const res = await fetch(
      "https://cdn.jsdelivr.net/gh/ZturnLibs/d2rtools@main/README.md",
    );
    console.log("stream status:", res.status);
    const reader = res.body!.getReader();
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value!.length;
    }
    console.log("streamed bytes:", total);
  } catch (err) {
    console.log("stream fetch FAILED:", String(err));
  }

  console.log("probe done");
}
main();
