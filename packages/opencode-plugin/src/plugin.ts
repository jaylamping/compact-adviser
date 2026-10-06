// compact-adviser for OpenCode (and front ends over its server, such as OpenChamber).
// OpenCode loads every function this file exports as a plugin, so it exports one.

import { readFile } from "node:fs/promises";
import type { Plugin } from "@opencode-ai/plugin";
import { Adviser, type Host } from "./adviser.ts";
import { isDisabled, loadSettings } from "./config.ts";
import type { OcMessage } from "./convert.ts";
import type { ContextPressureLimit } from "./limits.ts";

const SERVICE = "compact-adviser";

export const CompactAdviser: Plugin = async ({ client, directory }) => {
  const env = process.env;
  if (isDisabled(env)) return {};

  let providers: Promise<Map<string, ContextPressureLimit>> | undefined;
  const loadProviders = async () => {
    const limits = new Map<string, ContextPressureLimit>();
    const { data } = await client.config.providers();
    for (const provider of data?.providers ?? []) {
      for (const [id, model] of Object.entries(provider.models ?? {})) {
        const limit = (model as { limit?: { context?: number; input?: number; output?: number } })
          .limit;
        if (typeof limit?.context === "number") {
          limits.set(`${provider.id}/${id}`, {
            context: limit.context,
            input: limit.input,
            output: limit.output,
          });
        }
      }
    }
    return limits;
  };

  const host: Host = {
    settings: () => loadSettings({ env, directory, readFile: (path) => readFile(path, "utf8") }),
    messages: async (sessionID) => {
      const { data } = await client.session.messages({ path: { id: sessionID } });
      return (data ?? []) as unknown as OcMessage[];
    },
    isChild: async (sessionID) => {
      const { data } = await client.session.get({ path: { id: sessionID } });
      return Boolean(data?.parentID);
    },
    modelLimits: async (providerID, modelID) => {
      providers ??= loadProviders().catch(() => new Map());
      return (await providers).get(`${providerID}/${modelID}`);
    },
    summarize: async (sessionID, providerID, modelID) => {
      const { error } = await client.session.summarize({
        path: { id: sessionID },
        body: { providerID, modelID },
      });
      if (error) throw new Error(typeof error === "string" ? error : JSON.stringify(error));
    },
    toast: async (message, variant) => {
      await client.tui.showToast({ body: { message, variant, duration: 10000 } });
    },
    log: async (level, message) => {
      await client.app.log({ body: { service: SERVICE, level, message } });
    },
    fetch: async (url, init) => {
      const response = await fetch(url, init);
      return { status: response.status, ok: response.ok, text: await response.text() };
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    typesafeBase: env.TYPESAFE_BASE,
  };
  const adviser = new Adviser(host);

  return {
    event: async ({ event }) => {
      switch (event.type) {
        case "session.idle":
          // Judged in the background: the event bus must not wait on TypeSafe.
          void adviser.idle(event.properties.sessionID);
          break;
        case "session.compacted":
          adviser.compacted(event.properties.sessionID);
          break;
        case "session.deleted":
          adviser.forget(event.properties.info.id);
          break;
      }
    },
    "experimental.session.compacting": async (input, output) => {
      output.context.push(...adviser.compactionContext(input.sessionID));
    },
    "experimental.compaction.autocontinue": async (input, output) => {
      if (!adviser.allowAutoContinue(input.sessionID)) output.enabled = false;
    },
  };
};
