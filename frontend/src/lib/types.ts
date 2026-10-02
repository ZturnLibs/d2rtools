/** Shared view types derived from the codegen'd command table. */
import type { KnownCommands } from "../../../src/ztron-commands.js";

export type GetConfigResult = NonNullable<KnownCommands["d2r:getConfig"]["result"]>;
export type AppConfigView = GetConfigResult["config"];
export type ValidationView = NonNullable<GetConfigResult["validation"]>;
export type ModInfo = AppConfigView["knownMods"][number];
export type SourceView = AppConfigView["sources"][number];
export type ProfileView = AppConfigView["profiles"][number];
export type InstallRecordView = NonNullable<AppConfigView["installed"][string]>;
export type ListModsResult = KnownCommands["d2r:listMods"]["result"];

// — M2 存档管家 / 仓库向导 —
export type SaveOverviewResult = KnownCommands["d2r:saveOverview"]["result"];
export type SaveGroupView = SaveOverviewResult["root"];
export type SaveFileEntryView = SaveGroupView["files"][number];
export type ListBackupsResult = KnownCommands["d2r:listBackups"]["result"];
export type BackupMetaView = ListBackupsResult["backups"][number];
export type StashPreflightView = KnownCommands["d2r:stashPreflight"]["result"];
export type StashSlot = "soft" | "hard";
