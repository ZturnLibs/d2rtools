/** Child-process env: always spread the parent env first (PATH etc.), then
 *  overlay per-call values. tjs.spawn's env REPLACES the environment. */
export function tjsEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tjs.env)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}
