// TYPESAFE_API_KEY from the host environment, else a menu-saved key, else a cwd .env file.
// KEY=VALUE lines: last assignment wins; comments and blanks are ignored.
// Optional `export` / `declare -x` prefixes and one matching quote layer.

const PREFIX = /^(?:export|declare\s+-x)\s+/;

export type TypesafeKeySource = "env" | "saved" | ".env" | "missing";
export interface ResolvedTypesafeApiKey {
  value: string | undefined;
  source: TypesafeKeySource;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) return value.slice(1, -1);
  }
  return value;
}

/**
 * Drops an inline comment as dotenv tools do: a quoted value ends at its closing quote, an
 * unquoted one at ` #`.
 */
function stripInlineComment(value: string): string {
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const close = value.indexOf(quote, 1);
    return close > 0 ? value.slice(0, close + 1) : value;
  }
  return value.replace(/\s+#.*$/, "");
}

/**
 * Last `KEY=VALUE` assignment wins. Comments and blank lines are ignored. A file saved as
 * UTF-16 (Windows PowerShell 5.1 `>` / `Out-File`) and read as UTF-8 carries a NUL after
 * every ASCII character and its byte-order mark as replacement characters; both are dropped.
 */
export function parseDotenvKey(text: string, name: string): string | undefined {
  let found: string | undefined;
  const decoded = text.includes("\u0000")
    ? text
        .split("\u0000")
        .join("")
        .replace(/^(?:\uFFFD{1,2}|\uFEFF)/, "")
    : text;
  for (const raw of decoded.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    line = line.replace(PREFIX, "");
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    if (line.slice(0, eq).trim() !== name) continue;
    found = unquote(stripInlineComment(line.slice(eq + 1).trim()));
  }
  return found;
}

function nonempty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== "" ? value : undefined;
}

/**
 * A non-empty host env value wins, then a menu-saved key, then a parsed .env
 * assignment. Missing pieces are skipped; the value is never logged.
 */
export function resolveTypesafeApiKey(
  envValue: string | undefined,
  saved?: string,
  dotenvValue?: string,
): ResolvedTypesafeApiKey {
  const fromEnv = nonempty(envValue);
  if (fromEnv !== undefined) return { value: fromEnv, source: "env" };
  const fromSaved = nonempty(saved);
  if (fromSaved !== undefined) return { value: fromSaved, source: "saved" };
  const fromFile = nonempty(dotenvValue);
  if (fromFile !== undefined) return { value: fromFile, source: ".env" };
  return { value: undefined, source: "missing" };
}

export function formatKeyStatus(source: TypesafeKeySource): string {
  return `Key: ${source}`;
}
