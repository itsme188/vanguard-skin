# Market-first digest opening — 2026-09-17

**State:** Implemented and committed as `3c6fe57e`; base `e359dd6602c80f714418b4ebce66b034c3f5cb24`.
**Waiting on:** CODEX: integrate and deploy the verified correction.
**Next action:** ship both builds and record final main verification.

User approved the digest body but rejected the generic title and process explanation above it. The opening must tell the reader what happened in the market: a substantive headline and short subhead. The local real-day preview now opens with “Fed relief fades; AI hardware holds its ground” and a market summary; body unchanged, rendered, inspected and reopened for the user.

Mac and Worker now request a market-specific headline/subhead and prohibit generic digest titles or production commentary. A shared, parity-pinned parser promotes that opening ahead of delivery metadata and ancillary blocks. Mac source counts move below the body. Incomplete model openings retain the existing fallback layout. No further real-data AI request or email was sent.

Verification: 449 focused tests; root and Worker typechecks; full worktree suite 838 files, 10,009 passed, 3 skipped, 9 TODO. Synthetic live-model generation completed normally with a market headline/subhead. Browser screenshots confirm both the actual synthetic output and updated real-day example render as intended. Evidence is local-only in `docs/private/digest-headline-2026-09-17/`.

Retrospective: one implementation attempt, all checks passed first time. The earlier editorial preview's process note belonged in the handoff, not the reader-facing artifact. Preserve that separation in future previews. No changes to the approved body or new dependencies.
