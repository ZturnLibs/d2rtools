/** Probe 3: redirects, streaming reader, binary body, headers — for the zip
 * download pipeline. npmmirror tgz follows a 302 to the CDN; fflate is ~70KB. */
async function main(): Promise<void> {
  const t0 = Date.now();
  const res = await fetch("https://registry.npmmirror.com/fflate/-/fflate-0.8.2.tgz", {
    signal: AbortSignal.timeout(20000),
  });
  console.log("status:", res.status, "redirected:", res.url.slice(0, 80));
  console.log("content-type:", res.headers.get("content-type"));
  console.log("content-length:", res.headers.get("content-length"));

  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value!);
    total += value!.length;
  }
  console.log("streamed bytes:", total, `(${Date.now() - t0}ms)`);

  // gzip magic check on first two bytes (tgz starts 1f 8b)
  const first = chunks[0]!;
  console.log("gzip magic:", first[0] === 0x1f && first[1] === 0x8b);

  // zip magic check via unzipSync? no — just verify atob/btoa round trip small
  console.log("probe3 done");
}
main().catch((e) => {
  console.log("probe3 FAILED:", String(e).slice(0, 200));
  tjs.exit(1);
});
