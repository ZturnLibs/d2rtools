/** Thin determinate bar; value in [0,1], indeterminate when value < 0. */
export function ProgressBar(props: { value: number }) {
  const pct = Math.max(0, Math.min(1, props.value));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-800">
      <div
        className="h-full rounded-full bg-gradient-to-r from-violet-500 to-cyan-400 transition-[width] duration-150"
        style={{ width: `${pct * 100}%` }}
      />
    </div>
  );
}
