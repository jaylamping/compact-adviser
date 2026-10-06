// lib/ is a verbatim copy of the Claude Code package's shared files, which
// packages/pi-extension/test/lockstep.test.ts holds in step with every other host.
// Keeping these byte-identical keeps OpenCode in that lockstep too.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const SHARED = ["judge.ts", "snapshot.ts", "state.ts", "env.ts", "profile.ts", "disable.ts"];

test("lib/ matches the Claude Code package's shared files byte for byte", () => {
  for (const file of SHARED) {
    const ours = readFileSync(new URL(`../lib/${file}`, import.meta.url), "utf8");
    const theirs = readFileSync(new URL(`../../claude-mod/lib/${file}`, import.meta.url), "utf8");
    assert.equal(ours, theirs, `lib/${file} drifted from packages/claude-mod/lib/${file}`);
  }
});
