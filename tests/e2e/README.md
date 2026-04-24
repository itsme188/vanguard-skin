# E2E tests — Vanguard Skin

This directory holds **agent-browser driven** golden-path tests. The project doesn't use Playwright or Cypress — the convention is to run each scenario through the `agent-browser` sub-agent (from the `vercel:agent-browser` skill) against a locally-running dev server.

## Why not Playwright?

- Adds ~300MB of native browser binaries to install on every clone.
- Requires a headless Chromium CI pipeline that this project doesn't run (local-first Electron app).
- The project's existing bug-catching velocity is high on the `vitest` side (1241 tests); the missing coverage is *integration across server-component / client-component / query-param / CSS-cascade boundaries*, which agent-browser reads directly from a real browser DOM.

## Running

1. Start the dev server: `npm run dev` (→ http://localhost:3000).
2. Pick a scenario from `SCENARIOS.md`.
3. Spawn an `agent-browser` sub-agent with the scenario's prompt verbatim.
4. Review the punch list the agent reports — every item should be ✅.

Parallel run: spawn 4 sub-agents in a single message for a full sweep (~2 min of real time).

## What counts as a pass

Every numbered checklist item ✅. Screenshots land in `/tmp/*.png` by default — copy the ones worth archiving to `tests/e2e/baselines/`.

## What counts as a regression

One or more ❌ on a previously-passing scenario. File an entry in `docs/plans/TODO.md` and include the scenario name + failing item number.

## Existing scenarios

See `SCENARIOS.md` — currently 8 golden paths: Today, Security Detail, Alerts, Holdings, Research Feeds, Research Documents, Calendar, Chat.

## Future expansion

Niche flows not yet covered (track in TODO.md):
- Settings modal (Electron-only)
- Accounts reconciliation submodal
- TWS sync-status indicator
- Import PDF drop flow
- Levels performance page
- Alerts bell hover preview
