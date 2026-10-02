/** M2 placeholder — 存档备份/还原 lands with milestone 2. */
export function SavesPage() {
  return (
    <Placeholder
      title="存档管家"
      lines={[
        "快照备份 / 一键还原 / 启动前自动备份",
        "按 savepath 分组列出角色与仓库文件",
        "计划随 M2 里程碑交付",
      ]}
    />
  );
}

export function Placeholder(props: { title: string; lines: string[] }) {
  return (
    <div className="mx-auto mt-16 max-w-md rounded-2xl border border-dashed border-neutral-800 bg-[#0d1017] p-8 text-center">
      <h2 className="text-lg font-semibold text-neutral-200">{props.title}</h2>
      <ul className="mt-4 space-y-2 text-sm text-neutral-500">
        {props.lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </div>
  );
}
