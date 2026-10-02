/** 参数知识库 modal content — seed set; extend as packs demand. */
const PARAMS: { arg: string; desc: string; warn?: string }[] = [
  {
    arg: "-mod <名称>",
    desc: "加载游戏 mods\\<名称> 目录（或同名 .mpq）下的 MOD。一次只能加载一个，名称必须与 mods\\ 下的文件夹名一致。",
  },
  {
    arg: "-txt",
    desc: "让游戏读取 MOD 里解包的 txt 数据文件（开荒类整合包需要）。EJ 必须带。",
    warn: "VIPer_cs 等成品整合绝对不能加，否则会崩溃或黑屏。",
  },
  {
    arg: "-w",
    desc: "窗口模式运行（默认全屏）。",
  },
  {
    arg: "-direct",
    desc: "旧式直读目录覆盖，个别老 MOD 需要它才能正确加载数据。",
  },
];

export function ParamHelp() {
  return (
    <div className="space-y-3">
      <p className="text-xs text-neutral-500">
        启动参数跟随 MOD 变体走错是整合包翻车第一名——这里列常见参数，卡片上的「建议参数」已按变体的存档方式推断。
      </p>
      {PARAMS.map((p) => (
        <div key={p.arg} className="rounded-lg border border-neutral-800 bg-neutral-900/60 px-3 py-2">
          <code className="text-sm font-semibold text-cyan-300">{p.arg}</code>
          <p className="mt-1 text-xs text-neutral-400">{p.desc}</p>
          {p.warn && <p className="mt-1 text-xs text-amber-400">⚠ {p.warn}</p>}
        </div>
      ))}
    </div>
  );
}
