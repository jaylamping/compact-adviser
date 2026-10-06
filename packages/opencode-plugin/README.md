# compact-adviser for OpenCode

The same adviser as the other hosts, for [OpenCode](https://opencode.ai) and front ends over its
server such as OpenChamber. When a turn settles (`session.idle`), it runs the shared local gates
and the TypeSafe Jev judgment. Then it either shows a hint or, if you opt in, runs OpenCode's own
compaction (`session.summarize`, the same thing `/compact` does).

## Install

Build the single-file plugin and drop it into a plugin folder:

```sh
npm ci && npm run build          # writes dist/compact-adviser.js (needs bun)
cp dist/compact-adviser.js <project>/.opencode/plugin/   # one project
cp dist/compact-adviser.js ~/.config/opencode/plugin/    # every project
```

Use one of the two folders, not both: OpenCode loads every copy it finds, so two copies would
judge every turn twice.

## Settings

All settings live in `~/.config/opencode/compact-adviser.json` (or `$XDG_CONFIG_HOME/opencode/`);
there is no settings menu.

```json
{ "mode": "hint", "minContextTokens": 40000, "contextBudgetTokens": 0, "profile": "" }
```

- **Mode:**
  - `hint` (default) shows a toast.
  - `auto` compacts at a qualifying checkpoint. Writing `auto` is your explicit opt-in; there is
    no confirmation dialog.
  - `off` disables the adviser.
- **Key:** the first one found is used:
  1. `TYPESAFE_API_KEY` in the launch environment
  2. `"typesafeApiKey"` in the settings file
  3. `TYPESAFE_API_KEY` in the project's `.env`

  Every key found is scrubbed from what TypeSafe is sent.
- **Kill switch:** setting `COMPACT_ADVISER_DISABLE=1` turns the plugin off entirely.

## Behavior

- **Hints are TUI toasts.** OpenCode's terminal UI shows them. A web front end such as
  OpenChamber may not, so `auto` is the dependable mode there.
- **Automatic compaction:**
  - adds "keep the current work, pending tasks, referenced files, and the next step exact" to
    OpenCode's compaction prompt
  - stops OpenCode from adding its synthetic "continue" turn afterwards, since the adviser only
    compacts once the work is done
- **Subagent sessions are skipped.** A session with a parent session is never judged or compacted.
- **The compaction point** is the model's stated input limit, or else the context window less
  its output reserve. This is where OpenCode compacts by itself, and the hint floor relaxes toward
  it the way it does toward Claude Code's auto-compact point.
- **Cooldowns are kept in memory**, so they reset when OpenCode restarts.

`lib/` is a byte-for-byte copy of `packages/claude-mod/lib`. `test/lockstep.test.ts` fails if the
two drift apart.
