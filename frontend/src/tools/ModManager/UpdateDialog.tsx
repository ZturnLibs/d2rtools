/**
 * Update-apply modal (M9): confirm → download+extract (作者直链) → install
 * from the staged copy → done. Progress comes over the channel as two
 * phases: {type:"download"} from the zip stage, then the familiar
 * start/file/bytes install messages. Overwrite is implied (an upgrade
 * replaces the installed copy; the pre-install snapshot guards saves).
 */
import { useMemo, useState } from "react";
import { useChannelStream } from "@zturnlibs/ztron-react";
import { Modal } from "../../components/Modal";
import { ProgressBar } from "../../components/ProgressBar";
import { formatBytes } from "../../lib/decode";

type Progress =
  | { type: "download"; done: number; total: number | null }
  | { type: "start"; files: number; bytes: number }
  | { type: "file"; path: string; index: number; files: number }
  | { type: "bytes"; file: string; done: number; total: number }
  | { type: "done"; ok: boolean; files: number; bytes: number; mode: string; errors: string[] };

const radioCls =
  "flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 transition-colors has-checked:border-violet-500/60 has-checked:bg-violet-500/10";

export function UpdateDialog(props: {
  modName: string;
  displayName: string;
  localVersion: string | null;
  remoteVersion: string | null;
  changelog: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [mode, setMode] = useState<"copy" | "hardlink">("copy");
  const args = useMemo(
    () => ({ name: props.modName, mode, overwrite: true }),
    [props.modName, mode],
  );
  const { messages, status, error, start } = useChannelStream<Progress>("d2r:updateApply", args);

  const started = status !== "idle";
  const download = messages.findLast((m) => m.type === "download");
  const startMsg = messages.findLast((m) => m.type === "start");
  const filesDone = messages.filter((m) => m.type === "file").length;
  const lastBytes = messages.findLast((m) => m.type === "bytes");
  const doneMsg = messages.findLast((m) => m.type === "done");

  const phase: "confirm" | "download" | "install" | "done" = doneMsg
    ? "done"
    : startMsg
      ? "install"
      : started
        ? "download"
        : "confirm";

  const downloadFraction =
    download && download.total ? Math.min(1, download.done / download.total) : download ? 0.05 : 0;
  const installFraction =
    startMsg && startMsg.files > 0
      ? Math.min(1, (filesDone + (lastBytes ? lastBytes.done / lastBytes.total : 0)) / startMsg.files)
      : 0;

  return (
    <Modal
      title={`升级 ${props.displayName}`}
      onClose={() => {
        props.onDone(); // refresh even when closing midway
        props.onClose();
      }}
      footer={
        phase === "confirm" ? (
          <>
            <button
              className="rounded-lg border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800/60"
              onClick={props.onClose}
            >
              取消
            </button>
            <button
              className="rounded-lg bg-neutral-100 px-4 py-1.5 text-sm font-semibold text-neutral-950"
              onClick={() => start()}
            >
              下载并升级
            </button>
          </>
        ) : phase === "done" || status === "error" ? (
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
      {phase === "confirm" && (
        <div className="space-y-3">
          <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 text-sm">
            <span className="text-cyan-300">
              {props.localVersion ? `当前 ${props.localVersion}` : "当前版本未知"} → 远端{" "}
              {props.remoteVersion ?? "未知"}
            </span>
          </div>
          {props.changelog && (
            <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded-lg bg-neutral-900/70 px-3 py-2 font-mono text-[11px] text-neutral-400">
              {props.changelog}
            </pre>
          )}
          <p className="text-xs text-neutral-400">
            开始前会自动快照存档（与安装/启动同护栏）；游戏目录下的 mod 文件将被下载的新版覆盖。
          </p>
          <div className="space-y-2">
            <div
              className={
                radioCls + (mode === "copy" ? " border-violet-500/60 bg-violet-500/10" : " border-neutral-800")
              }
              onClick={() => setMode("copy")}
            >
              <input type="radio" checked={mode === "copy"} readOnly className="mt-0.5" />
              <div>
                <div className="text-sm font-medium">复制 <span className="text-neutral-500">（默认，最稳妥）</span></div>
              </div>
            </div>
            <div
              className={
                radioCls +
                (mode === "hardlink" ? " border-violet-500/60 bg-violet-500/10" : " border-neutral-800")
              }
              onClick={() => setMode("hardlink")}
            >
              <input type="radio" checked={mode === "hardlink"} readOnly className="mt-0.5" />
              <div>
                <div className="text-sm font-medium">硬链接 <span className="text-neutral-500">（下载的暂存目录与游戏同盘时可用）</span></div>
              </div>
            </div>
          </div>
        </div>
      )}

      {(phase === "download" || phase === "install") && status !== "error" && (
        <div className="space-y-3 py-2">
          <ProgressBar value={phase === "download" ? downloadFraction : installFraction} />
          <div className="text-xs text-neutral-400">
            {phase === "download" ? (
              <span>
                下载并解压中…
                {download && ` ${formatBytes(download.done)}${download.total ? ` / ${formatBytes(download.total)}` : ""}`}
              </span>
            ) : (
              <span>
                安装中… {filesDone}/{startMsg?.files ?? "?"} 个文件
                {lastBytes && ` · ${lastBytes.file}`}
              </span>
            )}
          </div>
          <p className="text-xs text-neutral-600">整合包体积可达数百 MB，请勿关闭窗口。</p>
        </div>
      )}

      {status === "error" && phase !== "done" && (
        <div className="space-y-2">
          <p className="text-sm text-red-400">升级失败：{error}</p>
          <p className="text-xs text-neutral-500">
            下载源可能暂时不可达（配额超限/网络问题）。可用浏览器打开该 mod 的发布页手动下载，再用「Mod 库 → 导入本地 zip」安装。
          </p>
        </div>
      )}

      {phase === "done" && doneMsg && (
        <div className="space-y-2">
          {doneMsg.ok ? (
            <p className="text-sm text-emerald-400">
              升级完成：{doneMsg.files} 个文件（{doneMsg.mode === "hardlink" ? "硬链接" : "复制"}）。
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
