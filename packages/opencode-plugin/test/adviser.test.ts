// The OpenCode adviser against a fake host: the turn-end gates, hint and automatic
// outcomes, the compaction hooks, and the message conversion and settings beneath them.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Adviser, COMPACT_INSTRUCTIONS, HINT, type Host } from "../src/adviser.ts";
import { configDir, loadSettings, type Settings } from "../src/config.ts";
import { contextTokens, type OcMessage, settledAnswer, toMessageLike } from "../src/convert.ts";
import { contextLimitFor } from "../src/limits.ts";

const KEY = "tsk-test-key";
const tokens = (total: number) => ({
  input: total - 1000,
  output: 1000,
  reasoning: 0,
  cache: { read: 0, write: 0 },
});

function user(id: string, text: string): OcMessage {
  return { info: { id, role: "user" }, parts: [{ type: "text", text }] };
}

function assistant(id: string, text: string, extra: Partial<OcMessage["info"]> = {}): OcMessage {
  return {
    info: {
      id,
      role: "assistant",
      time: { created: 1, completed: 2 },
      finish: "stop",
      providerID: "anthropic",
      modelID: "claude-test",
      tokens: tokens(100000),
      ...extra,
    },
    parts: [{ type: "text", text }],
  };
}

/** A transcript well over the 20k-token useful-history floor, ending in a settled answer. */
function conversation(last = "a1"): OcMessage[] {
  return [
    user("u0", "Build a parser for the config format."),
    {
      ...assistant("a0", "Implementation notes for the parser module. ".repeat(2200)),
      parts: [
        { type: "text", text: "Implementation notes for the parser module. ".repeat(2200) },
        {
          type: "tool",
          tool: "write",
          callID: "c1",
          state: { status: "completed", input: { filePath: "src/parser.ts" }, output: "ok" },
        },
      ],
    },
    user("u1", "Please finish the parser and commit it."),
    assistant(last, "Done: the parser is implemented, 12 of 12 tests pass, and it is committed."),
  ];
}

function jevAnswer(finished: number, handsOn = 1) {
  return {
    model: "jev-test",
    answers: {
      done: {
        type: "choice",
        choice: finished >= 0.5 ? "finished" : "not_finished",
        probabilities: { finished, not_finished: 1 - finished, unclear: 0 },
        confidence: 1,
      },
      shape: {
        type: "choice",
        choice: handsOn >= 0.5 ? "hands_on" : "coordinating",
        probabilities: { hands_on: handsOn, coordinating: 1 - handsOn, unclear: 0 },
        confidence: 1,
      },
    },
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

interface Fake {
  host: Host;
  settings: Settings;
  messages: OcMessage[];
  child: boolean;
  answer: () => Promise<{ status: number; ok: boolean; text: string }>;
  /** Runs while TypeSafe is answering. */
  during?: () => void;
  requests: { url: string; headers: Record<string, string>; body: string }[];
  toasts: { message: string; variant: string }[];
  logs: string[];
  summarized: string[];
  clock: number;
}

function fake(overrides: Partial<Settings> = {}): Fake {
  const f: Fake = {
    settings: {
      mode: "hint",
      minContextTokens: 40000,
      contextBudgetTokens: 0,
      profile: "",
      apiKey: KEY,
      keySource: "env",
      knownKeys: [KEY],
      ...overrides,
    },
    messages: conversation(),
    child: false,
    answer: async () => ({ status: 200, ok: true, text: JSON.stringify(jevAnswer(0.99)) }),
    requests: [],
    toasts: [],
    logs: [],
    summarized: [],
    clock: 1_000_000,
    host: undefined as unknown as Host,
  };
  f.host = {
    settings: async () => f.settings,
    messages: async () => f.messages,
    isChild: async () => f.child,
    modelLimits: async () => ({ context: 200000, output: 32000 }),
    summarize: async (sessionID) => {
      f.summarized.push(sessionID);
    },
    toast: async (message, variant) => {
      f.toasts.push({ message, variant });
    },
    log: async (_level, message) => {
      f.logs.push(message);
    },
    fetch: async (url, init) => {
      f.requests.push({ url, headers: init.headers, body: init.body });
      f.during?.();
      return f.answer();
    },
    sleep: () => new Promise(() => undefined),
    now: () => f.clock,
    typesafeBase: undefined,
  };
  return f;
}

describe("turn-end gates", () => {
  test("a qualifying settled answer shows the hint once", async () => {
    const f = fake();
    const adviser = new Adviser(f.host);
    await adviser.idle("s1");
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0]?.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(f.requests[0]?.body.includes(KEY), false);
    assert.deepEqual(f.toasts, [{ message: HINT, variant: "info" }]);
    // The same answer idling again is not a new exchange.
    await adviser.idle("s1");
    assert.equal(f.requests.length, 1);
  });

  test("below the minimum, without a key, in off mode, or in a subagent nothing is sent", async () => {
    for (const [overrides, child] of [
      [{ minContextTokens: 150000 }, false],
      [{ apiKey: "" }, false],
      [{ mode: "off" as const }, false],
      [{}, true],
    ] as const) {
      const f = fake(overrides);
      f.child = child;
      await new Adviser(f.host).idle("s1");
      assert.equal(f.requests.length, 0, JSON.stringify({ overrides, child }));
    }
  });

  test("an unsettled turn is not a checkpoint", async () => {
    for (const last of [
      assistant("a1", "Working…", { time: { created: 1 } }),
      assistant("a1", "Calling tools", { finish: "tool-calls" }),
      assistant("a1", "Failed", { error: { name: "ApiError" } }),
      assistant("a1", ""),
      user("u2", "one more thing"),
    ]) {
      const f = fake();
      f.messages = [...conversation().slice(0, -1), last];
      await new Adviser(f.host).idle("s1");
      assert.equal(f.requests.length, 0);
    }
  });

  test("a new turn while TypeSafe answers drops the judgment", async () => {
    const f = fake();
    f.during = () => {
      f.messages = [...f.messages, user("u2", "next"), assistant("a2", "Next answer.")];
    };
    await new Adviser(f.host).idle("s1");
    assert.equal(f.requests.length, 1);
    assert.equal(f.toasts.length, 0);
  });

  test("an unfinished verdict leaves context alone", async () => {
    const f = fake();
    f.answer = async () => ({ status: 200, ok: true, text: JSON.stringify(jevAnswer(0.2)) });
    await new Adviser(f.host).idle("s1");
    assert.equal(f.toasts.length, 0);
    assert.equal(f.summarized.length, 0);
  });

  test("a TypeSafe failure backs off and is reported once", async () => {
    const f = fake();
    f.answer = async () => ({ status: 500, ok: false, text: "" });
    const adviser = new Adviser(f.host);
    await adviser.idle("s1");
    assert.equal(f.toasts.length, 1);
    assert.equal(f.toasts[0]?.variant, "warning");
    f.messages = conversation("a2");
    await adviser.idle("s1");
    // Still inside the backoff: no second request, no second toast.
    assert.equal(f.requests.length, 1);
    assert.equal(f.toasts.length, 1);
  });

  test("a compaction starts the post-compaction cooldown", async () => {
    const f = fake();
    const adviser = new Adviser(f.host);
    adviser.compacted("s1");
    await adviser.idle("s1");
    assert.equal(f.requests.length, 0);
  });

  test("other credentials the session can see are scrubbed from the request", async () => {
    const f = fake({ knownKeys: [KEY, "tsk-old-dotenv-key"] });
    f.messages = conversation();
    f.messages.splice(2, 1, user("u1", "My old key tsk-old-dotenv-key and password=hunter2."));
    await new Adviser(f.host).idle("s1");
    assert.equal(f.requests[0]?.body.includes("tsk-old-dotenv-key"), false);
    assert.equal(f.requests[0]?.body.includes("hunter2"), false);
  });
});

describe("automatic mode", () => {
  test("compacts with OpenCode's summarize, adds the instructions, and suppresses auto-continue", async () => {
    const f = fake({ mode: "auto" });
    const adviser = new Adviser(f.host);
    let contextDuring: string[] = [];
    f.host.summarize = async (sessionID) => {
      f.summarized.push(sessionID);
      contextDuring = adviser.compactionContext(sessionID);
    };
    await adviser.idle("s1");
    assert.deepEqual(f.summarized, ["s1"]);
    assert.deepEqual(contextDuring, [COMPACT_INSTRUCTIONS]);
    assert.equal(adviser.allowAutoContinue("s1"), false);
    // Only once, and not for another session or a later compaction.
    assert.equal(adviser.allowAutoContinue("s1"), true);
    assert.equal(adviser.allowAutoContinue("s2"), true);
    assert.deepEqual(adviser.compactionContext("s1"), []);
  });

  test("a stale suppression expires", async () => {
    const f = fake({ mode: "auto" });
    const adviser = new Adviser(f.host);
    await adviser.idle("s1");
    f.clock += 10 * 60 * 1000;
    assert.equal(adviser.allowAutoContinue("s1"), true);
  });

  test("a failed compaction is reported and not retried at once", async () => {
    const f = fake({ mode: "auto" });
    f.host.summarize = async () => {
      throw new Error("busy");
    };
    const adviser = new Adviser(f.host);
    await adviser.idle("s1");
    assert.equal(f.toasts.at(-1)?.variant, "error");
    assert.equal(adviser.allowAutoContinue("s1"), true);
    f.messages = conversation("a2");
    await adviser.idle("s1");
    assert.equal(f.requests.length, 1);
  });
});

describe("conversion", () => {
  test("tools, file paths, and the compaction summary map onto the shared snapshot", () => {
    const converted = toMessageLike([
      {
        info: { id: "s", role: "assistant", summary: true },
        parts: [{ type: "text", text: "Earlier work" }],
      },
      {
        info: { id: "a", role: "assistant" },
        parts: [
          { type: "text", text: "hi" },
          { type: "text", text: "hidden", synthetic: true },
          {
            type: "tool",
            tool: "bash",
            state: { status: "error", input: { command: "make" }, error: "boom" },
          },
          { type: "tool", tool: "edit", state: { status: "running", input: {} } },
        ],
      },
    ]);
    assert.equal(converted[0]?.role, "user");
    assert.ok(converted[0]?.text.startsWith("This session is being continued"));
    assert.equal(converted[1]?.text, "hi");
    assert.deepEqual(converted[1]?.toolUses, [
      { tool: "Bash", input: { command: "make" }, text: "boom", isError: true },
    ]);
    const write = toMessageLike(conversation())[1]?.toolUses[0];
    assert.equal(write?.tool, "Write");
    assert.equal(write?.input.file_path, "src/parser.ts");
  });

  test("context tokens and the settled answer", () => {
    assert.equal(contextTokens(tokens(50000)), 50000);
    assert.equal(contextTokens(undefined), undefined);
    assert.equal(settledAnswer(conversation())?.info.id, "a1");
  });

  test("OpenCode compacts at the window less its output reserve", () => {
    assert.equal(contextLimitFor({ context: 200000, output: 32000 }), 168000);
    assert.equal(contextLimitFor({ context: 200000, output: 8000 }), 192000);
    assert.equal(contextLimitFor({ context: 1000000, output: 128000 }), 968000);
    // A stated input limit is the usable context.
    assert.equal(contextLimitFor({ context: 262144, input: 192000, output: 128000 }), 192000);
    assert.ok(Number.isNaN(contextLimitFor(undefined)));
  });
});

describe("settings", () => {
  const files = (map: Record<string, string>) => async (path: string) => map[path];

  test("the settings file, then the environment key, then .env", async () => {
    const settings = await loadSettings({
      env: { HOME: "/home/dev", TYPESAFE_API_KEY: "tsk-env" },
      directory: "/repo",
      readFile: files({
        "/home/dev/.config/opencode/compact-adviser.json": JSON.stringify({
          mode: "auto",
          minContextTokens: 60000,
          typesafeApiKey: "tsk-saved",
        }),
        "/repo/.env": "TYPESAFE_API_KEY=tsk-dotenv # comment\n",
      }),
    });
    assert.equal(settings.mode, "auto");
    assert.equal(settings.minContextTokens, 60000);
    assert.equal(settings.apiKey, "tsk-env");
    assert.equal(settings.keySource, "env");
    assert.deepEqual(settings.knownKeys, ["tsk-env", "tsk-saved", "tsk-dotenv"]);
    assert.equal(settings.problem, undefined);
  });

  test("a missing file is the defaults; a broken one is reported", async () => {
    const empty = await loadSettings({ env: {}, directory: "/repo", readFile: files({}) });
    assert.equal(empty.mode, "hint");
    assert.equal(empty.minContextTokens, 40000);
    assert.equal(empty.keySource, "missing");
    const broken = await loadSettings({
      env: { USERPROFILE: "C:\\Users\\dev" },
      directory: "/repo",
      readFile: files({ "C:\\Users\\dev/.config/opencode/compact-adviser.json": "{nope" }),
    });
    assert.ok(broken.problem?.includes("not valid JSON"));
  });

  test("the config directory follows XDG_CONFIG_HOME, HOME, then USERPROFILE", () => {
    assert.equal(configDir({ XDG_CONFIG_HOME: "/x/" }), "/x/opencode");
    assert.equal(configDir({ HOME: "/h" }), "/h/.config/opencode");
    assert.equal(configDir({ USERPROFILE: "C:\\U" }), "C:\\U/.config/opencode");
    assert.equal(configDir({}), undefined);
  });
});
