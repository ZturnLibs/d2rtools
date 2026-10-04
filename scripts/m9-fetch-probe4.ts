/** Probe 4: 302 redirect following (github archive → codeload) + retry help. */
async function tryOnce(url: string, timeoutMs: number): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const reader = res.body!.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value!.length;
  }
  return `status=${res.status} bytes=${total} finalUrl=${res.url.slice(0, 90)}`;
}

async function main(): Promise<void> {
  const url = "https://github.com/ZturnLibs/d2rtools/archive/refs/heads/master.zip";
  for (let i = 1; i <= 2; i++) {
    try {
      console.log(`attempt ${i}:`, await tryOnce(url, 25000));
      break;
    } catch (err) {
      console.log(`attempt ${i} FAILED:`, String(err).slice(0, 120));
    }
  }
  console.log("probe4 done");
}
main();
