# Codex CLI Migration — 2026-04-26

This document captures what changed when we ported the Claude Code workflow to OpenAI Codex CLI (v0.125.0). Codex now runs side-by-side with Claude Code on the same project — pick whichever you feel like for any session.

## Why both

| You want… | Reach for |
|---|---|
| Auto-memory continuity (47-file `~/.claude/projects/.../memory/` corpus) | Claude Code |
| Sonnet/Opus + the `superpowers` plugin ecosystem | Claude Code |
| GPT-5.5 + 5-hour rolling rate limit | Codex |
| Faster shell tool / sandbox approval flow | Codex |
| Either tool, with the same project context | Either — both read CLAUDE.md |

## Equivalences (what maps to what)

| Claude Code | Codex |
|---|---|
| `~/.claude/CLAUDE.md` | `~/.codex/AGENTS.md` |
| Project `CLAUDE.md` | `AGENTS.md` (or `project_doc_fallback_filenames = ["CLAUDE.md"]` — what we use) |
| `.claude/skills/<name>/SKILL.md` | `.agents/skills/<name>/SKILL.md` (same frontmatter format) |
| `~/.claude/agents/*.md` | `~/.agents/skills/<name>/SKILL.md` (Codex has no separate "agent" concept — both are skills) |
| `~/.claude/commands/*.md` | Skills with explicit `$<name>` invocation in TUI |
| `.claude/settings.json` hooks | `[hooks]` in `~/.codex/config.toml` (same event names, **stdin JSON not env vars**) |
| `~/.claude/.mcp.json` | `[mcp_servers.<name>]` in `~/.codex/config.toml` |
| Auto-memory `memory/*.md` | **No native equivalent.** Encode as AGENTS.md sections + skill files |
| `EnterPlanMode` | `/plan` slash command + `plan_mode_reasoning_effort` |
| `effortLevel: xhigh` | `model_reasoning_effort = "xhigh"` |

## Files added by the migration

```
~/.codex/AGENTS.md                                       global rules
~/.agents/skills/session-end/SKILL.md                    global dispatcher
~/.agents/skills/agent-browser/SKILL.md                  global UI verifier
~/code/vanguard-skin/.agents/skills/data-auditor/        DB integrity sweep
~/code/vanguard-skin/.agents/skills/test-writer/         Vitest conventions
~/code/vanguard-skin/.agents/skills/session-end/         project 8-step closeout
~/code/vanguard-skin/.codex/hooks/block-db-edits.sh      PreToolUse Edit|Write
~/code/vanguard-skin/.codex/hooks/check-todo-reconciled.sh PreToolUse Bash
~/code/vanguard-skin/.codex/hooks/post-edit-lint.sh      PostToolUse Edit|Write
~/code/vanguard-skin/.codex/hooks/stop-vitest.sh         Stop
~/code/vanguard-skin/.codex/hooks/block-sqlite3-writes.sh PreToolUse Bash (closes the .db loophole)
```

The pre-existing `.agents/skills/{db-query,run-tests,ship}/SKILL.md` were left alone, except `ship/SKILL.md` got proper YAML frontmatter (Codex requires it; Claude Code didn't).

## Files edited

- `~/.codex/config.toml` — appended `project_doc_fallback_filenames`, project trust for the other two projects, profiles (`audit` / `ship` / `dangerzone`), `[mcp_servers.context7]`, and the four `[hooks]` blocks. Backup at `~/.codex/config.toml.before-migration-2026-04-26`.
- `AGENTS.md` (this repo) — added a one-line pointer at the top: *"Read `CLAUDE.md` in this directory before any task."* Codex auto-loads CLAUDE.md via `project_doc_fallback_filenames`, so this is belt-and-suspenders.

## Hook contract differences (gotcha when porting)

**Codex hooks ≠ Claude Code hooks** in two important ways:

1. **Input is stdin JSON, not env vars.** Claude Code hooks read `$CLAUDE_FILE_PATHS`, `$CLAUDE_TOOL_INPUT`, etc. Codex hooks receive a single JSON object on stdin. Use `jq -r '.tool_input.file_path'` instead of `$CLAUDE_FILE_PATHS`.

2. **Stdout MUST be valid JSON (or empty).** Claude Code happily prints raw text from a hook. Codex parses stdout as a JSON output object — any non-JSON text triggers `error: hook returned invalid <event> hook JSON output`. Route diagnostics to stderr instead:
   ```bash
   { eslint --fix "$file"; tsc --noEmit | head -20; } >&2
   ```

The deny-action JSON shape is the same as Claude Code:
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "..."
  }
}
```

## Scope discipline (hooks are global, projects aren't)

`~/.codex/config.toml` is global, so every hook fires for every project. To keep vanguard-skin-specific hooks from firing in stock-contest or shabbos-monitor, every script self-gates near the top:

```bash
repo_root=$(git rev-parse --show-toplevel 2>/dev/null)
case "$repo_root" in
  */vanguard-skin) ;;
  *) exit 0 ;;
esac
```

Cost outside vanguard-skin: ~5-10ms per invocation.

## What the .db loophole was

`block-db-edits.sh` (matcher `^(Edit|Write)$`) protects against the naive failure mode: agent text-edits a binary SQLite file. But a smart agent will route around that by using `sqlite3 ... INSERT INTO ...` via the Bash tool — which the Edit|Write matcher misses entirely.

`block-sqlite3-writes.sh` (matcher `^Bash$`) closes that gap. It allows reads (`SELECT`, `.schema`, `.dump`, `PRAGMA`) but blocks writes (`INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`, `REPLACE`, `TRUNCATE`, `VACUUM`, `.restore`, `.import`, `.read`, `< file.sql` redirection).

To run a legit migration via Codex, either:
- Use `npx tsx scripts/migrate.ts` or `npm run migrate` (uses the migration runner; not `sqlite3` directly)
- Or temporarily comment out the hook line in `~/.codex/config.toml`

## Verification at migration time

| Check | Result |
|---|---|
| Codex launches in vanguard-skin with all skills loaded | ✅ |
| Codex cites CLAUDE.md gotchas correctly (proves fallback works) | ✅ (cited `holdingDerivedPriceSource`, `RELEASE_TIMES_ET`, `datetime()` wrap unprompted) |
| `.db` Edit/Write block | ✅ wiring proven; live test showed Codex routes around to `sqlite3` (parity with Claude Code) |
| sqlite3 write block | ✅ all 6 unit tests pass |
| TODO-reconcile guard | ✅ silently allowed (`n=0`, TODO.md current) |
| Stop hook (vitest) | ✅ JSON contract corrected |
| Production deploy via `npm run electron:deploy` | ✅ ran end-to-end through Codex (Next build → tsc → sign → notarize → DMG → install → launch in 4m13s) |

## Day-1 cheat sheet

| Action | Command |
|---|---|
| Open Codex in current project | `codex` |
| Read-only audit profile | `codex --profile audit` |
| Daily-driver profile | `codex --profile ship` |
| One-shot non-interactive task | `codex exec "Audit recent changes for missing tests"` |
| Resume last session | `codex resume --last` |
| Apply Codex's last diff | `codex apply` |
| List skills (in TUI) | `$` |
| Invoke a skill explicitly | `$<name>` |
| Plan a non-trivial change | `/plan` |
| List MCP servers | `codex mcp list` |
| Inspect feature flags | `codex features list` |

## Rollback

```bash
# Restore the original config (15 seconds)
cp ~/.codex/config.toml.before-migration-2026-04-26 ~/.codex/config.toml

# Optional: remove Codex-only paths
rm -rf ~/.agents ~/.codex/AGENTS.md
rm -rf ~/code/vanguard-skin/.codex
# Leave .agents/skills/ alone — it doesn't break Claude Code
```

## What we deliberately did NOT migrate

- The auto-memory directory at `~/.claude/projects/-Users-Yitzi-code-vanguard-skin/memory/` (47 files) is still Claude-Code-managed. Codex updates it via the `session-end` skill but doesn't auto-load it — `memories` is `experimental: false` in Codex 0.125.
- Claude Code plugins (`superpowers`, `vercel`, `frontend-design`, etc.) aren't ported. Codex has its own marketplace via `codex plugin marketplace` with a different bundle.
- The `~/.claude/` config is fully intact — running `claude` from this directory works exactly as it did before the migration.
