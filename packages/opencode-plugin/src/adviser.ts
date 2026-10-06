// The adviser for OpenCode: at a settled turn (`session.idle`), the cheap local gates,
// then the shared TypeSafe Jev judgment, then a hint or, opted in, OpenCode's own
// compaction (`session.summarize`, what /compact runs). Everything OpenCode-specific is
// behind `Host`, so the decisions are tested without a running OpenCode.

import {
  contextPressure,
  fitState,
  JudgeError,
  judge,
  judgeErrorMessage,
  qualifies,
  type Transport,
  typesafeEndpoint,
} from "../lib/judge.ts";
import { parseProfile } from "../lib/profile.ts";
import { snapshot } from "../lib/snapshot.ts";
import {
  backoff,
  completeExchange,
  cooldownReason,
  initialState,
  type SessionState,
} from "../lib/state.ts";
import type { Settings } from "./config.ts";
import { contextTokens, type OcMessage, settledAnswer, toMessageLike } from "./convert.ts";
import { type ContextPressureLimit, contextLimitFor } from "./limits.ts";

export const HINT =
  "Compact adviser: work appears completed or recorded. Run /compact to save tokens.";
/** How long the adviser's own compaction keeps OpenCode from adding a "continue" turn. */
export const SUPPRESS_CONTINUE_MS = 300000;
export const COMPACT_INSTRUCTIONS =
  "The session reached a natural boundary; keep the current work, pending tasks, referenced files, and the next step exact.";

export interface Host {
  settings(): Promise<Settings>;
  /** The session's messages, oldest first. */
  messages(sessionID: string): Promise<readonly OcMessage[]>;
  /** Whether the session is a subagent's (it has a parent). */
  isChild(sessionID: string): Promise<boolean>;
  /** The model's context window and output reserve, when OpenCode knows the model. */
  modelLimits(providerID: string, modelID: string): Promise<ContextPressureLimit | undefined>;
  summarize(sessionID: string, providerID: string, modelID: string): Promise<void>;
  toast(message: string, variant: "info" | "success" | "warning" | "error"): Promise<void>;
  log(level: "debug" | "info" | "warn" | "error", message: string): Promise<void>;
  fetch: Transport["fetch"];
  sleep(ms: number): Promise<void>;
  now(): number;
  /** The `TYPESAFE_BASE` override from the launch environment. */
  typesafeBase: string | undefined;
}

async function fingerprint(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class Adviser {
  private readonly states = new Map<string, SessionState>();
  /** The last settled answer each session counted, so a repeated idle counts once. */
  private readonly counted = new Map<string, string>();
  private readonly judging = new Set<string>();
  /** Sessions this adviser is compacting: their compaction gets our instructions. */
  private readonly compacting = new Set<string>();
  /**
   * Sessions whose next auto-continue turn is suppressed, until when: the work was already
   * done. It expires so a host that never asks cannot swallow a later continue.
   */
  private readonly suppressContinue = new Map<string, number>();
  private lastNotice = "";

  private readonly host: Host;

  constructor(host: Host) {
    this.host = host;
  }

  private state(sessionID: string): SessionState {
    return this.states.get(sessionID) ?? initialState(false, this.host.now());
  }

  private async notice(message: string, variant: "warning" | "error" = "warning") {
    if (message === this.lastNotice) return;
    this.lastNotice = message;
    await this.host.toast(message, variant).catch(() => undefined);
  }

  /** `experimental.session.compacting`: context for a compaction this adviser asked for. */
  compactionContext(sessionID: string): string[] {
    return this.compacting.has(sessionID) ? [COMPACT_INSTRUCTIONS] : [];
  }

  /** `experimental.compaction.autocontinue`: false after the adviser's own compaction. */
  allowAutoContinue(sessionID: string): boolean {
    const until = this.suppressContinue.get(sessionID);
    this.suppressContinue.delete(sessionID);
    return until === undefined || this.host.now() > until;
  }

  /** `session.compacted`: any compaction restarts the session's cooldown. */
  compacted(sessionID: string): void {
    this.states.set(sessionID, initialState(true, this.host.now()));
  }

  /** `session.deleted`: forget the session. */
  forget(sessionID: string): void {
    this.states.delete(sessionID);
    this.counted.delete(sessionID);
  }

  /** `session.idle`: a turn settled. Never throws. */
  async idle(sessionID: string): Promise<void> {
    if (this.judging.has(sessionID) || this.compacting.has(sessionID)) return;
    this.judging.add(sessionID);
    try {
      await this.checkpoint(sessionID);
    } catch (error) {
      await this.host
        .log("error", `checkpoint failed: ${error instanceof Error ? error.message : error}`)
        .catch(() => undefined);
    } finally {
      this.judging.delete(sessionID);
    }
  }

  private async checkpoint(sessionID: string): Promise<void> {
    const settings = await this.host.settings();
    if (settings.problem) await this.notice(settings.problem);
    if (settings.mode === "off" || (await this.host.isChild(sessionID))) return;
    const messages = await this.host.messages(sessionID);
    const answer = settledAnswer(messages);
    if (!answer || this.counted.get(sessionID) === answer.info.id) return;
    this.counted.set(sessionID, answer.info.id);

    const tokens = contextTokens(answer.info.tokens);
    let now = this.host.now();
    const state = completeExchange(this.state(sessionID), tokens, now);
    this.states.set(sessionID, state);
    if (
      settings.apiKey === "" ||
      tokens === undefined ||
      tokens < settings.minContextTokens ||
      cooldownReason(state, tokens, now) !== undefined
    )
      return;

    const profile = parseProfile(settings.profile);
    const view = snapshot(toMessageLike(messages), settings.knownKeys);
    if (view.conversationTokens <= 20000) return;
    const key = await fingerprint(view.checkpointText);
    if (state.lastHintKey === key) return;
    const endpoint = typesafeEndpoint(this.host.typesafeBase);
    if (endpoint === undefined) {
      await this.notice(judgeErrorMessage("configuration"), "error");
      return;
    }

    let result: Awaited<ReturnType<typeof judge>>;
    try {
      result = await judge(
        fitState(view.state, profile),
        settings.apiKey,
        { fetch: this.host.fetch, sleep: (ms) => this.host.sleep(ms), endpoint },
        profile,
      );
    } catch (error) {
      now = this.host.now();
      this.states.set(sessionID, backoff(this.state(sessionID), now));
      await this.notice(error instanceof JudgeError ? error.message : judgeErrorMessage("network"));
      return;
    }

    // A judgment came back, so the backoff ladder restarts whatever happens next.
    now = this.host.now();
    let current: SessionState = { ...this.state(sessionID), failures: 0, retryAfter: 0 };
    this.states.set(sessionID, current);
    // The person may have moved on while TypeSafe answered; judge only the turn it saw.
    const latest = settledAnswer(await this.host.messages(sessionID));
    if (latest?.info.id !== answer.info.id) return;

    const providerID = answer.info.providerID ?? "";
    const modelID = answer.info.modelID ?? "";
    const limits =
      providerID && modelID ? await this.host.modelLimits(providerID, modelID) : undefined;
    const usage = contextPressure(tokens, contextLimitFor(limits), settings.contextBudgetTokens);
    if (!qualifies(result, usage, profile)) return;
    this.lastNotice = "";

    if (settings.mode === "hint") {
      current = { ...current, lastHintAt: current.completed, lastHintKey: key, updatedAt: now };
      this.states.set(sessionID, current);
      await this.host.toast(HINT, "info");
      await this.host.log("info", HINT);
      return;
    }
    if (!providerID || !modelID) return;
    this.compacting.add(sessionID);
    this.suppressContinue.set(sessionID, this.host.now() + SUPPRESS_CONTINUE_MS);
    try {
      await this.host.summarize(sessionID, providerID, modelID);
      this.states.set(sessionID, initialState(true, this.host.now()));
      await this.host.toast("Compact adviser: compacted at a completed checkpoint.", "success");
    } catch (error) {
      this.suppressContinue.delete(sessionID);
      this.states.set(sessionID, { ...this.state(sessionID), retryAfter: this.host.now() + 60000 });
      await this.notice(
        `Compact adviser: compaction failed (${error instanceof Error ? error.message : error}); no immediate retry.`,
        "error",
      );
    } finally {
      this.compacting.delete(sessionID);
    }
  }
}
