// OpenCode's `session.messages` answer as the shared snapshot's transcript: text-only
// messages with the tools each assistant turn used. Tool names are mapped onto the ones
// the shared snapshot knows (`Write`, `Edit`, `Bash`), and OpenCode's camel-case
// `filePath` input onto `file_path`, so saved artifacts and sensitive files are found.

import { type MessageLike, SUMMARY_PREFIX, type ToolUseLike } from "../lib/snapshot.ts";

/** The parts of OpenCode's message shape this package reads. */
export interface OcPart {
  type: string;
  text?: string;
  synthetic?: boolean;
  ignored?: boolean;
  tool?: string;
  callID?: string;
  state?: {
    status: string;
    input?: Record<string, unknown>;
    output?: string;
    error?: string;
  };
}

export interface OcTokens {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

export interface OcInfo {
  id: string;
  role: "user" | "assistant";
  summary?: boolean;
  error?: unknown;
  finish?: string;
  time?: { created: number; completed?: number };
  providerID?: string;
  modelID?: string;
  tokens?: OcTokens;
}

export interface OcMessage {
  info: OcInfo;
  parts: readonly OcPart[];
}

const TOOL_NAMES: Record<string, string> = {
  write: "Write",
  edit: "Edit",
  multiedit: "MultiEdit",
  patch: "Edit",
  bash: "Bash",
  read: "Read",
};

function visibleText(parts: readonly OcPart[]): string {
  return parts
    .filter((part) => part.type === "text" && !part.synthetic && !part.ignored)
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
}

function toolInput(input: Record<string, unknown> | undefined): Record<string, unknown> {
  const out = { ...(input ?? {}) };
  if (typeof out.filePath === "string" && out.file_path === undefined) out.file_path = out.filePath;
  return out;
}

function toolUses(parts: readonly OcPart[]): ToolUseLike[] {
  const uses: ToolUseLike[] = [];
  for (const part of parts) {
    if (part.type !== "tool" || !part.tool || !part.state) continue;
    const { status } = part.state;
    if (status !== "completed" && status !== "error") continue;
    uses.push({
      ...(part.callID ? { tool_use_id: part.callID } : {}),
      tool: TOOL_NAMES[part.tool] ?? part.tool,
      input: toolInput(part.state.input),
      text: status === "completed" ? (part.state.output ?? "") : (part.state.error ?? ""),
      ...(status === "error" ? { isError: true as const } : {}),
    });
  }
  return uses;
}

/** OpenCode's messages, oldest first, as the shared snapshot reads a transcript. */
export function toMessageLike(messages: readonly OcMessage[]): MessageLike[] {
  return messages.map(({ info, parts }) => {
    const text = visibleText(parts);
    // OpenCode stores its compaction summary as an assistant message flagged `summary`.
    if (info.role === "assistant" && info.summary) {
      return { role: "user", text: `${SUMMARY_PREFIX}.\n${text}`, toolUses: [] };
    }
    return {
      role: info.role,
      text,
      toolUses: info.role === "assistant" ? toolUses(parts) : [],
    };
  });
}

/** The context the latest model call used: everything it read plus what it wrote. */
export function contextTokens(tokens: OcTokens | undefined): number | undefined {
  if (!tokens) return undefined;
  const total =
    tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write;
  return Number.isFinite(total) && total > 0 ? total : undefined;
}

/**
 * The latest message when it is a settled final answer: an assistant reply that finished
 * without error, did not stop to call tools, and said something.
 */
export function settledAnswer(messages: readonly OcMessage[]): OcMessage | undefined {
  const last = messages.at(-1);
  if (last?.info.role !== "assistant" || last.info.summary) return undefined;
  if (last.info.error || last.info.time?.completed === undefined) return undefined;
  if (last.info.finish === "tool-calls") return undefined;
  return visibleText(last.parts) ? last : undefined;
}
