---
name: session-start
description: "Start a Portfolio Desk work session: check repo and worktree state, Claude/Codex handoffs, GitHub issues and PRs, shared memory, and the TODO backlog; recommend the next work or resume the user's chosen task. Use for session-start, a new work session, or asking what to work on. Do not invoke when merely creating or editing this skill."
---

# Portfolio Desk — Session Start for Codex

Read the repository's [shared session-start checklist](../../../.claude/session-start.md) completely and follow it. Resolve the path from the repository root as `.claude/session-start.md`, including in worktrees. That file owns the checklist; do not duplicate it here.

Apply these Codex adaptations:

- Read `CLAUDE.md` and show existing uncommitted changes before new work. Check both the active worktree and main checkout when they differ; preserve another agent's edits and staged files.
- Alongside `docs/HANDOFF.md`, read `docs/CODEX-CLAUDE-COORDINATION.md` if present and the latest relevant `docs/HANDOFF-CODEX-*.md` (including any handoff named in the coordination note). Confirm claims about pending fixes, deployment, or ownership against current git state. Distinguish implemented, committed, merged, pushed, and deployed.
- Read the shared memory index at `/Users/Yitzi/.claude/projects/-Users-Yitzi-code-vanguard-skin/memory/MEMORY.md`, especially Active Issues and Recent Work. Follow linked topic files only when relevant to the chosen work.
- Include pending Codex worktrees and recovery patches in the do-first candidates. Check open QA PRs and `qa/findings/DECISIONS-PENDING.md` before proposing duplicate fixes. The startup sweep reports branches; it does not merge, delete, switch branches in the shared checkout, deploy, or mutate production data.
- Use `rg` for the checklist's text searches. Batch independent read-only checks. If GitHub or memory access fails, identify which information is unavailable and continue the local checks; do not report an inaccessible inbox as empty.
- Reconcile new actionable issues into `docs/plans/TODO.md` as the shared checklist specifies, preserving concurrent edits. Leave issue closures for explicit approval. Do not mark an item done merely because an unmerged worktree contains its implementation.
- When the user has not selected a task, present the checklist's quick follow-ups, ranked candidates, and recommendation, then ask for a focus using an available input tool or a concise question. Do not assume Claude's `AskUserQuestion` tool exists in Codex.
- When the user already selected a task or explicitly delegated prioritization, their instruction takes precedence over the checklist's pick-a-task pause. Complete the relevant preflight, state the focus and ownership boundaries, then proceed within existing authorization. Do not ask them to choose the same task again.

Creating or updating this skill does not start a work session or authorize application changes, commits, pushes, or deployment.
