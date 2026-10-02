/**
 * IPC layer: re-export the codegen'd typed invoke plus a useCommand hook —
 * like @zturnlibs/ztron-react's useInvoke but typed against KnownCommands
 * and with a manual refresh (backend state changes after mutations).
 */
import { useCallback, useEffect, useState } from "react";
import { invoke, type KnownCommands } from "../../../src/ztron-commands.js";

export { invoke };
export type { KnownCommands };

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface CommandState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** Re-run the command (e.g. after a mutation elsewhere). */
  refresh: () => void;
}

export function useCommand<C extends keyof KnownCommands>(
  cmd: C,
  args: KnownCommands[C]["args"],
): CommandState<KnownCommands[C]["result"]> {
  const [state, setState] = useState<CommandState<KnownCommands[C]["result"]>>({
    data: null,
    error: null,
    loading: true,
    refresh: () => {},
  });
  const [version, setVersion] = useState(0);
  const argsKey = JSON.stringify(args ?? {});

  useEffect(() => {
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    void invoke(cmd, JSON.parse(argsKey) as KnownCommands[C]["args"]).then(
      (data) => {
        if (!cancelled) setState((prev) => ({ ...prev, data, error: null, loading: false }));
      },
      (err: unknown) => {
        if (!cancelled) {
          setState((prev) => ({ ...prev, error: errMsg(err), loading: false }));
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [cmd, argsKey, version]);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  return { ...state, refresh };
}
