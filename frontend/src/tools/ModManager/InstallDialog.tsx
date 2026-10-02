/**
 * Install flow modal: mode + overwrite options, then channel-driven
 * progress (start → per-file/bytes → done) straight from the backend.
 */
import { useMemo, useState } from "react";
import { useChannelStream } from "@zturnlibs/ztron-react";
import { Modal } from "../../components/Modal";
import { ProgressBar } from "../../components/ProgressBar";
import { formatBytes } from "../../lib/decode";
import type { ModInfo } from "../../lib/types";

type Progress =
  | { type: "start"; files: number; bytes: number }
  | { type: "mode"; mode: string }
  | { type: "file"; path: string; index: number; files: number }
  | { type: "bytes"; file: string; done: number; total: number }
  | { type: "done"; ok: boolean; files: number; bytes: number; mode: string; errors: string[] };

const radioCls =
  "flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 transition-colors has-checked:border-violet-500/60 has-checked:bg-violet-500/10";

export function InstallDialog(props: {
  mod: ModInfo;
  installed: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [mode, setMode] = useState<"copy" | "hardlink">("copy");
  const [overwrite, setOverwrite] = useState(false);
  const args = useMemo(
    () => ({ key: props.mod.key, mode, overwrite }),
    [props.mod.key, mode, overwrite],
  );
  const { messages, status, error, start } = useChannelStream<Progress>("d2r:installMod", args);

  const started = status !== "idle";
  const startMsg = messages.findLast((m) => m.type === "start");
  const filesDone = messages.filter((m) => m.type === "file").length;
  const lastBytes = messages.findLast((m) => m.type === "bytes");
  const doneMsg = messages.findLast((m) => m.type === "done");
  const currentFile = lastBytes?.file;

  const fraction =
    startMsg && startMsg.files > 0
      ? Math.min(1, (filesDone + (lastBytes ? lastBytes.done / lastBytes.total : 0)) / startMsg.files)
      : 0;

  return (
    <Modal
      title={`安装 ${props.mod.displayName ?? props.mod.name}`}
      onClose={() => {
        props.onDone(); // refresh parent state even when closing midway
        props.onClose();
      }}
      footer={
        !started ? (
          <>
            <button className="rounded-lg border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800/60" onClick={props.onClose}>
              取消
            </button>
            <button
              className="rounded-lg bg-neutral-100 px-4 py-1.5 text-sm font-semibold text-neutral-950 disabled:opacity-50"
              onClick={() => start()}
            >
              开始安装
            </button>
          </>
        ) : doneMsg || status === "error" ? (
          <button
            className="rounded-lg bg-neutral-100 px-4 py-1.5 text-sm font-semibold text-neutral-950"
            onClick={() => {
              props.onDone();
              props.onClose();
            }}
          >
            关闭
          </button>
        ) : undefined
      }
    >
      {!started && (
        <div className="space-y-3">
          <div className="space-y-2">
            <div className={radioCls + (mode === "copy" ? " border-violet-500/60 bg-violet-500/10" : " border-neutral-800")} onClick={() => setMode("copy")}>
              <input type="radio" checked={mode === "copy"} readOnly className="mt-0.5" />
              <div>
                <div className="text-sm font-medium">复制 <span className="text-neutral-500">（默认，最稳妥）</span></div>
                <div className="text-xs text-neutral-500">完整拷贝到游戏 mods\ 目录，与来源彻底独立。</div>
              </div>
            </div>
            <div className={radioCls + (mode === "hardlink" ? " border-violet-500/60 bg-violet-500/10" : " border-neutral-800")} onClick={() => setMode("hardlink")}>
              <input type="radio" checked={mode === "hardlink"} readOnly className="mt-0.5" />
              <div>
                <div className="text-sm font-medium">硬链接 <span className="text-neutral-500">（同盘秒装，零额外空间）</span></div>
                <div className="text-xs text-neutral-500">要求来源与游戏在同一块盘；不支持时自动回退为复制。</div>
              </div>
            </div>
          </div>
          {props.installed && (
            <label className="flex items-center gap-2 text-sm text-amber-300">
              <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
              该 MOD 已安装——勾选以覆盖重装（先删后装）
            </label>
          )}
        </div>
      )}

      {started && !doneMsg && status !== "error" && (
        <div className="space-y-3 py-2">
          <ProgressBar value={fraction} />
          <div className="text-xs text-neutral-400">
            {startMsg && (
              <span>
                {filesDone}/{startMsg.files} 个文件
                {currentFile && ` · ${currentFile}`}
                {lastBytes && ` · ${formatBytes(lastBytes.done)}/${formatBytes(lastBytes.total)}`}
              </span>
            )}
          </div>
          <p className="text-xs text-neutral-600">大文件（数百 MB 的 .mpq）复制可能需要十几秒，请勿关闭窗口。</p>
        </div>
      )}

      {status === "error" && !doneMsg && <p className="text-sm text-red-400">安装失败：{error}</p>}

      {doneMsg && (
        <div className="space-y-2">
          {doneMsg.ok ? (
            <p className="text-sm text-emerald-400">
              安装完成：{doneMsg.files} 个文件（{doneMsg.mode === "hardlink" ? "硬链接" : "复制"}）
            </p>
          ) : (
            <p className="text-sm text-amber-400">
              部分文件失败（{doneMsg.errors.length} 个），其余已安装：
              <ul className="mt-1 list-inside list-disc text-xs text-neutral-400">
                {doneMsg.errors.slice(0, 8).map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
