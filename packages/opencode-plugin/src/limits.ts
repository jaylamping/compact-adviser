// Where OpenCode compacts on its own: when a turn's context passes the model's usable
// input, which is its `input` limit when the provider states one, otherwise the window
// less the room kept for output (the output limit, at most 32,000 tokens). The hint floor
// relaxes toward that point, as on Claude Code it relaxes toward the auto-compact threshold.

/** OpenCode's own cap on the output reserve. */
export const OUTPUT_RESERVE_MAX = 32000;

export interface ContextPressureLimit {
  /** The model's context window in tokens. */
  context: number;
  /** The model's input limit in tokens, when the provider states one. */
  input?: number;
  /** The model's output limit in tokens; 0 or missing when unknown. */
  output?: number;
}

function positive(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** The token count OpenCode compacts at, or NaN when the model is unknown. */
export function contextLimitFor(limits: ContextPressureLimit | undefined): number {
  const context = limits?.context;
  if (!positive(context)) return Number.NaN;
  if (positive(limits?.input)) return Math.min(limits.input, context);
  const reserve = positive(limits?.output)
    ? Math.min(limits.output, OUTPUT_RESERVE_MAX)
    : OUTPUT_RESERVE_MAX;
  return context > reserve ? context - reserve : context;
}
