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
