---
name: session-end
description: "Close a Portfolio Desk work session using the shared Claude/Codex checklist: verify changes, reconcile GitHub and TODOs, update project memory and handoff, and complete authorized commits, pushes, and deployment. Use when the user explicitly invokes session-end or asks to run the session-end workflow; not for discussion, skill edits, summary requests, or editor closure."
---

# Portfolio Desk — Session End for Codex

Read the repository's [shared session-end checklist](../../../.claude/session-end.md) completely and carry it out. Resolve that path from the repository root as `.claude/session-end.md`, including when working in a worktree. That file owns the workflow; do not maintain a second copy here.

Apply these Codex adaptations while following the shared checklist:

## Scope and authorization

- An explicit session-end invocation is the user's standing authorization for this session's commit, push, normal integration, and reviewed deployment, as recorded in the global instructions and shared checklist. The receiving agent owns closeout; do not hand shipping to Claude by assumption or ask again for authorized actions. Honor explicit user limits. If safe integration is blocked, finish independent steps and report the concrete blocker.
- Discussing or editing this skill, requesting a summary, saying only "we're done", or closing the editor does not invoke it. An accompanying explicit request to run session-end does invoke it.
- Check status in the active worktree and main checkout, read `docs/CODEX-CLAUDE-COORDINATION.md` if present, and establish ownership before staging or updating shared docs. Commit only this session's changes by explicit paths; do not include another agent's edits or stage their changes to a shared file.
- Report other worktrees and PRs. Do not automatically delete worktrees, switch the shared checkout's branch, merge unrelated work, force-push, or repair production data.
- If a step is blocked, complete independent closeout work and record the blocker. Never label unmerged, untested, or undeployed work as shipped.

## Verification and deployment

- Before committing production changes, follow `docs/reference/verification-loop.md`: focused checks, applicable real-browser verification, and the full Vitest suite. Use the pinned Node 24 PATH from `CLAUDE.md`. Reuse completed checks for unchanged code; report exact test totals and known baseline failures.
- Keep tests and browser QA on isolated databases. Preserve `tests/setup/db-guard.ts`; use `npm run build` rather than bare `npx next build` so builds cannot migrate the live DB.
- Rebuild only from the reviewed integration state after coordinating with any active agent. Read `docs/reference/electron-build.md` before deployment. Skip rebuild for docs/skill-only changes. A migration still needs its required rehearsal and a Worker change still needs its separately authorized deployment.
- When a build/deploy is started asynchronously, capture its actual exit status and wait for completion before writing the final handoff. Do not let a successful pipe or process launch stand in for a successful build.

## Shared records and attribution

- Reconcile TODOs and GitHub issues against verified landed commits, including older fixes whose issues remain open, as the shared checklist describes. Perform issue closures/comments only when the user has authorized that external communication; otherwise include a concrete closure proposal in the handoff.
- Update the shared project memory identified by the checklist without replacing another agent's entries. If access is unavailable, save the proposed entry in `docs/private/` and report its path.
- Use Codex attribution, not Claude's name or a hardcoded model version. Omit the optional co-author trailer if the actual identity is unavailable. Use a final handoff commit such as `chore(codex): session handoff` when committing is authorized.
- The handoff covers the checklist's five fields: goal and exact files; verification and deploy results; decisions and remaining concerns; actual git/worktree/process state; Codex plus the session date (and a real session link only if available).
- Keep public docs direction-only; put real portfolio figures and private evidence in gitignored `docs/private/`. Preserve a concurrent agent's handoff; coordinate ownership or write a separately named handoff and link it from the coordination note.

End with the checklist's concise summary plus a brief retrospective: goal, accomplishments, fix attempts/iterations, what went wrong or took longer, and one useful improvement for next time. Distinguish implemented, committed, merged, pushed, and deployed.
