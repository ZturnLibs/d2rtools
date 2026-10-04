/**
 * Zip install dialog (M9): stage a zip (作者直链下载 or 本地导入), let the
 * user pick a variant when the pack contains several, then install through
 * the regular pipeline. Two channel streams run sequentially:
 *   zipStageUrl/zipStagePick (download+extract; "staged" message carries the
 *   stage result) → zipStageInstall (copy/hardlink into mods\).
 */
import { useMemo, useState } from "react";
import { invoke, errMsg } from "../../lib/ipc";
import { useChannelStream } from "@zturnlibs/ztron-react";
import { Modal } from "../../components/Modal";
import { ProgressBar } from "../../components/ProgressBar";
import { formatBytes } from "../../lib/decode";

type StageCandidateView = {
  name: string;
  displayName: string | null;
  savepath: string;
  variant: string;
  sourcePath: string;
};

type StageView = { stageId: string; candidates: StageCandidateView[]; files: number; bytes: number };

type StageProgress =
  | { type: "download"; done: number; total: number | null }
  | { type: "staged"; stage: StageView };

type InstallProgress =
  | { type: "start"; files: number; bytes: number }
  | { type: "file"; path: string; index: number; files: number }
  | { type: "bytes"; file: string; done: number; total: number }
  | { type: "done"; ok: boolean; files: number; bytes: number; mode: string; errors: string[] };

const radioCls =
  "flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 transition-colors has-checked:border-violet-500/60 has-checked:bg-violet-500/10";

export function ZipInstallDialog(props: {
  source: { kind: "url"; url: string; label: string } | { kind: "pick" };
  onClose: () => void;
  onDone: () => void;
}) {
  const [stage, setStage] = useState<StageView | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [mode, setMode] = useState<"copy" | "hardlink">("copy");
  const [overwrite, setOverwrite] = useState(false);
  const [stageError, setStageError] = useState<string | null>(null);

  const stageCmd = props.source.kind === "url" ? "d2r:zipStageUrl" : "d2r:zipStagePick";
  const stageArgs = useMemo(() => (props.source.kind === "url" ? { url: props.source.url } : {}), [props.source]);
  const stageStream = useChannelStream<StageProgress>(stageCmd, stageArgs);
  const installArgs = useMemo(
    () => ({ stageId: stage?.stageId ?? "", modName: picked ?? "", mode, overwrite }),
    [stage?.stageId, picked, mode, overwrite],
  );
  const installStream = useChannelStream<InstallProgress>("d2r:zipStageInstall", installArgs);

  const stagedMsg = stageStream.messages.findLast((m) => m.type === "staged");
  const stageDone = stageStream.status === "done" || stagedMsg;

  const phase: "confirm" | "staging" | "ready" | "install" | "finished" | "error" =
    installStream.status === "running"
      ? "install"
      : installStream.messages.findLast((m) => m.type === "done")
        ? "finished"
        : installStream.status === "error"
          ? "error"
          : stage
            ? "ready"
            : stageStream.status === "running"
              ? "staging"
              : stageError
                ? "error"
                : stageDone && stagedMsg
                  ? "ready"
                  : stageStream.status === "error"
                    ? "error"
                    : "confirm";

  const doneMsg = installStream.messages.findLast((m) => m.type === "done");
  const startMsg = installStream.messages.findLast((m) => m.type === "start");
  const filesDone = installStream.messages.filter((m) => m.type === "file").length;
  const lastBytes = installStream.messages.findLast((m) => m.type === "bytes");
  const download = stageStream.messages.findLast((m) => m.type === "download");

  function beginStage() {
    setStageError(null);
    if (props.source.kind === "url") {
      stageStream.start();
    } else {
      // 本地导入走非通道命令（无进度条），大包导入需数秒。
      void invoke("d2r:zipStagePick", {}).then(
        (res) => {
          if (res.stage) setStage(res.stage);
          else setStageError("已取消");
        },
        (err: unknown) => setStageError(errMsg(err)),
      );
    }
  }

  // url 模式：useChannelStream 丢弃 resolve 值，stage 结果从 "staged" 通道
  // 消息取；本地导入直接 setState。两路最终都汇到 stage state。
  const effectiveStage: StageView | null = stage ?? stagedMsg?.stage ?? null;
  const candidates = effectiveStage?.candidates ?? [];
  const selected = picked ?? (candidates.length === 1 ? candidates[0]!.name : null);

  function beginInstall() {
    if (!effectiveStage || !selected) return;
    setPicked(selected);
    installStream.start();
  }

  const stageFraction =
    download && download.total ? Math.min(1, download.done / download.total) : download ? 0.05 : 0;
  const installFraction =
    startMsg && startMsg.files > 0
      ? Math.min(1, (filesDone + (lastBytes ? lastBytes.done / lastBytes.total : 0)) / startMsg.files)
      : 0;

  return (
    <Modal
      title={props.source.kind === "url" ? `安装 · ${props.source.label}` : "导入本地 zip 安装"}
      onClose={() => {
        props.onDone();
        props.onClose();
      }}
      footer={
        phase === "confirm" ? (
          <>
            <button className="rounded-lg border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800/60" onClick={props.onClose}>
              取消
            </button>
            <button
              className="rounded-lg bg-neutral-100 px-4 py-1.5 text-sm font-semibold text-neutral-950"
              onClick={beginStage}
            >
              {props.source.kind === "url" ? "下载并检查" : "选择压缩包"}
            </button>
          </>
        ) : phase === "ready" ? (
          <>
            <button className="rounded-lg border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800/60" onClick={props.onClose}>
              取消
            </button>
            <button
              className="rounded-lg bg-neutral-100 px-4 py-1.5 text-sm font-semibold text-neutral-950 disabled:opacity-50"
              disabled={!selected}
              onClick={beginInstall}
            >
              开始安装
            </button>
          </>
        ) : phase === "finished" || phase === "error" ? (
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
        <div className="space-y-2 text-sm text-neutral-300">
          {props.source.kind === "url" ? (
            <p>
              将从作者直链下载并解压检查（安全扫描会拒绝可执行文件），确认后再写入游戏目录。
            </p>
          ) : (
            <p>选择本地 zip 压缩包——解压检查后会让你确认安装方式。支持多变体整合包。</p>
          )}
          {props.source.kind === "url" && (
            <p className="break-all font-mono text-[11px] text-neutral-500">{props.source.url}</p>
          )}
        </div>
      )}

      {phase === "staging" && (
        <div className="space-y-3 py-2">
          {props.source.kind === "url" ? (
            <>
              <ProgressBar value={stageFraction} />
              <div className="text-xs text-neutral-400">
                下载并解压中…
                {download && ` ${formatBytes(download.done)}${download.total ? ` / ${formatBytes(download.total)}` : ""}`}
              </div>
            </>
          ) : (
            <p className="animate-pulse text-xs text-neutral-400">解压检查中…</p>
          )}
        </div>
      )}

      {phase === "ready" && effectiveStage && (
        <div className="space-y-3">
          <p className="text-xs text-neutral-400">
            解压检查通过：{effectiveStage.files} 个文件，共 {formatBytes(effectiveStage.bytes)}。
            {candidates.length > 1 ? "该压缩包含多个变体，请选择要安装的：" : "确认安装方式："}
          </p>
          <div className="max-h-48 space-y-2 overflow-y-auto pr-1">
            {candidates.map((c) => {
              const active = selected === c.name;
              return (
                <div
                  key={c.name}
                  className={
                    radioCls + (active ? " border-violet-500/60 bg-violet-500/10" : " border-neutral-800")
                  }
                  onClick={() => setPicked(c.name)}
                >
                  <input type="radio" checked={active} readOnly className="mt-0.5" />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{c.displayName ?? c.name}</div>
                    <div className="text-xs text-neutral-500">
                      {c.name}
                      {c.variant ? ` · ${c.variant}` : ""} · {c.savepath === "../" ? "共用主存档" : `独立存档 ${c.savepath}`}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="space-y-2">
            <div
              className={radioCls + (mode === "copy" ? " border-violet-500/60 bg-violet-500/10" : " border-neutral-800")}
              onClick={() => setMode("copy")}
            >
              <input type="radio" checked={mode === "copy"} readOnly className="mt-0.5" />
              <div>
                <div className="text-sm font-medium">复制 <span className="text-neutral-500">（默认，最稳妥）</span></div>
              </div>
            </div>
            <div
              className={radioCls + (mode === "hardlink" ? " border-violet-500/60 bg-violet-500/10" : " border-neutral-800")}
              onClick={() => setMode("hardlink")}
            >
              <input type="radio" checked={mode === "hardlink"} readOnly className="mt-0.5" />
              <div>
                <div className="text-sm font-medium">硬链接 <span className="text-neutral-500">（暂存区与游戏同盘时零拷贝）</span></div>
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-amber-300">
              <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
              目标 mod 已安装时覆盖重装（先删后装）
            </label>
          </div>
        </div>
      )}

      {phase === "install" && (
        <div className="space-y-3 py-2">
          <ProgressBar value={installFraction} />
          <div className="text-xs text-neutral-400">
            安装中… {filesDone}/{startMsg?.files ?? "?"} 个文件{lastBytes && ` · ${lastBytes.file}`}
          </div>
        </div>
      )}

      {phase === "finished" && doneMsg && (
        <div className="space-y-2">
          {doneMsg.ok ? (
            <p className="text-sm text-emerald-400">
              安装完成：{doneMsg.files} 个文件（{doneMsg.mode === "hardlink" ? "硬链接" : "复制"}）。
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

      {phase === "error" && (
        <div className="space-y-2">
          <p className="text-sm text-red-400">{stageError ?? stageStream.error ?? installStream.error}</p>
          {props.source.kind === "url" && (
            <p className="text-xs text-neutral-500">
              下载源可能暂时不可达。可用浏览器打开该 mod 的发布页手动下载，再「导入本地 zip」。
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
