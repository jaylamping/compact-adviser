// `claude plugin validate --strict` on this package: the engine's own reading of the hooks
// module must name exactly the events it hooks, the environment it reads, and no
// capability the mod must not use.
import { claudeVersion, PACKAGE, run } from "./common.mjs";

const version = claudeVersion();
const { status, output: raw } = run(["plugin", "validate", "--strict", PACKAGE]);
// Newer Claude Code quotes matcher values (`key="..."`); compare without the quotes.
const output = raw.replace(/="([^"]*)"/g, "=$1");
const expected = [
  "hooks: session.start, turn.start, turn.complete, session.compact, command.run{command=compact-adviser}, config.describe{key=compact-adviser.typesafeApiKey}, ui.close{id=compact-adviser}, ui.render{component=Pane}",
  "env reads: CLAUDE_CODE_ENABLE_FUNCTION_HOOKS, CLAUDE_CODE_SESSION_ATTENDED, COMPACT_ADVISER_DISABLE, COMPACT_ADVISER_TEST_ENDPOINT, HOME, TYPESAFE_API_KEY, TYPESAFE_BASE, USERPROFILE",
  "env writes: nothing",
  "$.fs.read (via appendTypeSafeLog, dotenvKey)",
  "$.fs.write (via appendTypeSafeLog)",
  "Validation passed",
];
const forbidden = ["process.run", "env.set", "prompt.submit", "prompt.fill", "tool.call", "model."];
const problems = [
  ...(status === 0 ? [] : [`exit status ${status}`]),
  ...expected.filter((line) => !output.includes(line)).map((line) => `missing: ${line}`),
  ...forbidden
    .filter((call) => output.includes(`$.${call}`))
    .map((call) => `forbidden call: $.${call}`),
];
if (problems.length > 0) {
  process.stderr.write(`${output}\n`);
  console.error(`Claude Code ${version}: strict validation drifted:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(
  `Claude Code ${version}: strict validation passed with the expected hooks and environment reads.`,
);
