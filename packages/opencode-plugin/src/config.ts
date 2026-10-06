// Settings for OpenCode, which has no settings menu for plugins: a JSON file in the
// OpenCode config directory, the launch environment for the key and kill switch, and the
// project's `.env` for the key as on the other hosts.
//
//   ~/.config/opencode/compact-adviser.json (or $XDG_CONFIG_HOME/opencode/...)
//   { "mode": "hint" | "auto" | "off", "minContextTokens": 40000,
//     "contextBudgetTokens": 0, "profile": "", "typesafeApiKey": "" }
//
// Writing "auto" there is the explicit opt-in to automatic compaction; there is no dialog
// to ask through.

import { disabledByEnv } from "../lib/disable.ts";
import { parseDotenvKey, resolveTypesafeApiKey, type TypesafeKeySource } from "../lib/env.ts";

export type Mode = "hint" | "auto" | "off";
export const DEFAULT_MINIMUM = 40000;
export const SETTINGS_FILE = "compact-adviser.json";

export interface Settings {
  mode: Mode;
  minContextTokens: number;
  contextBudgetTokens: number;
  profile: string;
  /** The key in effect, or empty. */
  apiKey: string;
  keySource: TypesafeKeySource;
  /** Every key the session could see, scrubbed from what TypeSafe is sent. */
  knownKeys: string[];
  /** A problem with the settings file, shown once; the defaults apply meanwhile. */
  problem?: string;
}

export interface SettingsSources {
  env: Readonly<Record<string, string | undefined>>;
  /** Reads a file as text; rejects or resolves undefined when it is missing. */
  readFile: (path: string) => Promise<string | undefined>;
  /** The session's project directory, where `.env` is read. */
  directory: string;
}

export function isDisabled(env: SettingsSources["env"]): boolean {
  return disabledByEnv(env.COMPACT_ADVISER_DISABLE);
}

/** The OpenCode config directory, the way OpenCode itself finds it. */
export function configDir(env: SettingsSources["env"]): string | undefined {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg) return `${xdg.replace(/[\\/]+$/, "")}/opencode`;
  const home = (env.HOME ?? env.USERPROFILE)?.trim();
  return home ? `${home.replace(/[\\/]+$/, "")}/.config/opencode` : undefined;
}

function wholeTokens(value: unknown, min: number): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= min ? (value as number) : undefined;
}

async function read(sources: SettingsSources, path: string): Promise<string | undefined> {
  try {
    return await sources.readFile(path);
  } catch {
    return undefined;
  }
}

export async function loadSettings(sources: SettingsSources): Promise<Settings> {
  let file: Record<string, unknown> = {};
  let problem: string | undefined;
  const dir = configDir(sources.env);
  const text = dir === undefined ? undefined : await read(sources, `${dir}/${SETTINGS_FILE}`);
  if (text !== undefined && text.trim() !== "") {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        file = parsed as Record<string, unknown>;
      } else problem = `${SETTINGS_FILE} is not a JSON object; using defaults.`;
    } catch {
      problem = `${SETTINGS_FILE} is not valid JSON; using defaults.`;
    }
  }
  const mode: Mode =
    file.mode === "auto" || file.mode === "off" || file.mode === "hint" ? file.mode : "hint";
  if (file.mode !== undefined && file.mode !== mode) {
    problem ??= `${SETTINGS_FILE}: mode must be "hint", "auto" or "off"; using "hint".`;
  }
  const savedKey = typeof file.typesafeApiKey === "string" ? file.typesafeApiKey.trim() : "";
  const envText = await read(sources, `${sources.directory.replace(/[\\/]+$/, "")}/.env`);
  const dotenvKey = envText === undefined ? undefined : parseDotenvKey(envText, "TYPESAFE_API_KEY");
  const resolved = resolveTypesafeApiKey(sources.env.TYPESAFE_API_KEY, savedKey, dotenvKey);
  return {
    mode,
    minContextTokens: wholeTokens(file.minContextTokens, 1) ?? DEFAULT_MINIMUM,
    contextBudgetTokens: wholeTokens(file.contextBudgetTokens, 0) ?? 0,
    profile: typeof file.profile === "string" ? file.profile : "",
    apiKey: resolved.value?.trim() ?? "",
    keySource: resolved.source,
    knownKeys: [sources.env.TYPESAFE_API_KEY, savedKey, dotenvKey].filter(
      (key): key is string => typeof key === "string" && key.trim() !== "",
    ),
    ...(problem ? { problem } : {}),
  };
}
