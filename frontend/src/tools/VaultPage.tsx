/** M2 placeholder — 大仓库（SharedStash）替换向导 lands with milestone 2. */
import { Placeholder } from "./SavesPage.js";

export function VaultPage() {
  return (
    <Placeholder
      title="仓库向导"
      lines={[
        "替换共享仓库（.d2i）前的三步保护：警告 → 自动备份 → 可回滚",
        "纳入管理手工备份目录（如 SharedStashSoftCoreV2备份）",
        "计划随 M2 里程碑交付",
      ]}
    />
  );
}
