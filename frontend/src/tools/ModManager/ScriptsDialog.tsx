/**
 * 作者脚本弹窗：mods\<mod>\ 顶层 bat 的列表、副作用/目标缺失徽章、GBK
 * 内容预览与受控运行。killsGame 的脚本必须勾选确认才能运行；运行输出经
 * channel 逐行回传（原始字节 b64，按 GBK/UTF-8 解码）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useChannelStream } from "@zturnlibs/ztron-react";
import { Modal } from "../../components/Modal";
import { b64ToBytes, decodeText, formatBytes, formatTime } from "../../lib/decode";
import type { ScriptInfoView } from "../../lib/types";

type ScriptLine = { stream: "out" | "err"; b64: string };

function Badge(props: { tone: "red" | "amber" | "gray"; children: React.ReactNode }) {
  const tones = {
    red: "border-red-500/40 bg-red-500/10 text-red-300",
    amber: "border-amber-500/40 bg-amber-500/10 text-amber-300",
    gray: "border-neutral-700 bg-neutral-800/60 text-neutral-400",
  } as const;
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[11px] ${tones[props.tone]}`}>
      {props.children}
    </span>
  );
}

function ScriptBadges(props: { s: ScriptInfoView }) {
  return (
    <span className="flex flex-wrap gap-1">
      {props.s.sideEffects.killsGame && <Badge tone="red">强制关闭游戏</Badge>}
      {props.s.sideEffects.launchesGame && <Badge tone="amber">会启动游戏</Badge>}
      {props.s.sideEffects.pauses && <Badge tone="gray">结束等待按键</Badge>}
      {props.s.missingTargets.map((t) => (
        <Badge key={t} tone="red">
          目标缺失：mods\{t}
        </Badge>
      ))}
      {props.s.truncated && <Badge tone="gray">内容过大，预览截断</Badge>}
    </span>
  );
}

export function ScriptsDialog(props: {
  modName: string;
  displayName: string;
  scripts: ScriptInfoView[];
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<ScriptInfoView | null>(
    props.scripts.length === 1 ? (props.scripts[0] ?? null) : null,
  );
  const [confirmKill, setConfirmKill] = useState(false);
  const [preview, setPreview] = useState(true);

  // one streaming run; args pinned to the selected script
  const [runTarget, setRunTarget] = useState<ScriptInfoView | null>(null);
  const args = useMemo(
    () => (runTarget ? { modName: props.modName, fileName: runTarget.name } : undefined),
    [props.modName, runTarget],
  );
  const { messages, status, error, start } = useChannelStream<ScriptLine>("d2r:runScript", args);
  const running = status === "running";
  const finished = status === "done" || status === "error";

  // start() 闭包绑定的是它创建时的 args——直接在 run() 里调用会拿到旧的
  // undefined args。改为：args 从 undefined 翻到具体目标后由 effect 触发，
  // 此时 effect 拿到的已是新 start。
  const armedRef = useRef(false);
  useEffect(() => {
    if (args && !armedRef.current) {
      armedRef.current = true;
      start();
    } else if (!args) {
      armedRef.current = false;
    }
  }, [args, start]);

  const lines = useMemo(
    () =>
      messages.map((m) => {
        const { text } = decodeText(b64ToBytes(m.b64));
        return { stream: m.stream, text };
      }),
    [messages],
  );

  function choose(s: ScriptInfoView) {
    if (running) return;
    setSelected(s);
    setConfirmKill(false);
  }

  function run() {
    if (!selected || running) return;
    setRunTarget(selected); // args 翻转 → effect 触发 start()
  }

  return (
    <Modal
      wide
      title={`作者脚本 · ${props.displayName}`}
      onClose={() => {
        if (running) return; // 运行中不允许顺手关——脚本可能还在杀游戏
        props.onClose();
      }}
      footer={
        running ? (
          <span className="text-xs text-neutral-500">脚本运行中…（输出见下方）</span>
        ) : finished && runTarget ? (
          <button
            className="rounded-lg bg-neutral-100 px-4 py-1.5 text-sm font-semibold text-neutral-950"
            onClick={() => {
              setRunTarget(null);
              setConfirmKill(false);
            }}
          >
            完成
          </button>
        ) : selected ? (
          <>
            <button className="rounded-lg border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800/60" onClick={props.onClose}>
              关闭
            </button>
            {selected.sideEffects.killsGame && !confirmKill && (
              <span className="text-xs text-red-400">勾选下方确认后再运行</span>
            )}
            <button
              className="rounded-lg bg-neutral-100 px-4 py-1.5 text-sm font-semibold text-neutral-950 disabled:opacity-40"
              disabled={selected.sideEffects.killsGame && !confirmKill}
              onClick={run}
            >
              运行 {selected.name}
            </button>
          </>
        ) : undefined
      }
    >
      <div className="space-y-3">
        {/* script list */}
        <div className="space-y-2">
          {props.scripts.map((s) => (
            <button
              key={s.name}
              className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
                selected?.name === s.name
                  ? "border-violet-500/60 bg-violet-500/10"
                  : "border-neutral-800 hover:border-neutral-700"
              } ${running ? "cursor-default opacity-70" : ""}`}
              onClick={() => choose(s)}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-neutral-100">{s.name}</span>
                <span className="shrink-0 text-[11px] text-neutral-500">
                  {formatBytes(s.size)} · {formatTime(s.mtime)}
                </span>
              </div>
              <div className="mt-1.5">
                <ScriptBadges s={s} />
              </div>
            </button>
          ))}
        </div>

        {/* pre-run warnings + preview */}
        {selected && !runTarget && (
          <div className="space-y-2">
            {selected.sideEffects.killsGame && (
              <label className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={confirmKill}
                  onChange={(e) => setConfirmKill(e.target.checked)}
                />
                <span>
                  该脚本会<b>强制关闭 D2R.exe（taskkill）</b>——未保存的存档进度会丢失。请先退出游戏，或确认接受强制关闭。
                </span>
              </label>
            )}
            {selected.missingTargets.length > 0 && (
              <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                脚本引用的目标在本整合包中不存在：{selected.missingTargets.map((t) => `mods\\${t}`).join("、")}
                。运行多半会报错或无效，仅建议明确知道自己在做什么时使用。
              </p>
            )}
            <label className="flex items-center gap-2 text-xs text-neutral-500">
              <input type="checkbox" checked={preview} onChange={(e) => setPreview(e.target.checked)} />
              显示脚本内容预览
            </label>
            {preview && (
              <pre className="max-h-64 overflow-auto rounded-lg border border-neutral-800 bg-[#0b0e13] px-3 py-2 font-mono text-[11px] leading-5 text-neutral-300">
                {decodeText(b64ToBytes(selected.b64)).text}
              </pre>
            )}
          </div>
        )}

        {/* run output */}
        {runTarget && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-neutral-300">
                运行输出 · {runTarget.name}
              </span>
              {finished && (
                <span className={`text-xs ${status === "error" ? "text-red-400" : "text-neutral-500"}`}>
                  {status === "error" ? `失败：${error}` : "已结束"}
                </span>
              )}
            </div>
            <pre className="max-h-72 overflow-auto rounded-lg border border-neutral-800 bg-[#0b0e13] px-3 py-2 font-mono text-[11px] leading-5 text-neutral-300">
              {lines.length === 0 && !running ? "（无输出）" : lines.map((l, i) => (
                <div key={i} className={l.stream === "err" ? "text-red-400/90" : undefined}>
                  {l.text}
                </div>
              ))}
              {running && <div className="animate-pulse text-neutral-600">▌</div>}
            </pre>
            <p className="text-[11px] text-neutral-600">
              脚本以游戏目录为工作目录运行；若 60 秒未结束会被强制终止。
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
}
