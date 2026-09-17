# Takeaway-first digest — 2026-09-17

**State:** Implemented and committed as `dc465f8a`, based on `0cf3afde425f847917edc2d3be2a734c20de4317`. Ready for authorized integration and deployment.
**Waiting on:** CODEX: ship and verify both Mac and Worker.
**Next action:** integrate, push, deploy both builds, and preserve final verification evidence.

## User decision

The digest should summarize the substance of research, not narrate which newsletters mentioned each ticker. Lead with news/arguments, cite at paragraph ends, group shared sector stories, and give individual companies space for meaningful commentary. Omit empty ticker mentions. This supersedes the earlier mandatory section per held ticker and generic excerpt backstop. The user also prefers documents to be opened automatically when asked to review them.

## Changes

- Mirrored editorial rules preserve substantive catalysts, source disagreements and named originators while allowing grouping and omission. Holdings still prioritize input selection; they do not force output sections.
- Removed forced held-name excerpts, the appended publication inventory, and automatic ticker roster from synthesis delivery. Broad multi-symbol commentary stays available for sector synthesis. Deep-dive/Research Desk handling and per-source fallback on AI failure remain.
- Coverage disclosure states limits concisely, without a long overflow ticker list.
- Supplied inline citation links are retained exactly; altered/invented Markdown links become plain text labeled source link unavailable. Tests cover adjacent links and parentheses in URLs. This guards link fidelity, not factual accuracy of model prose.

## Verification

- Final worktree full suite: 838 files, 10,003 passed, 3 skipped, 9 TODO.
- Root and Worker typechecks passed; 442 focused tests plus final 10 citation/integration regressions passed.
- Synthetic-only live model call: normal stop, shared sector grouping, company catalyst and named dissent retained, empty ticker section omitted. No email sent.
- Isolated Research/Feeds preview modal rendered saved synthetic output with sector heading, catalyst and intact source links. Browser screenshots inspected. Final smoke 4/4.
- Real-day editorial example rewritten locally from the previously saved summaries, clearly labeled as an editorial preview, rendered and opened for the user. No additional real-data provider request: the one-call authorization was consumed by the prior test.
- Private examples, screenshots and logs: ignored `docs/private/digest-editorial-2026-09-17/`.

## Retrospective

Goal: replace newsletter inventory prose with useful synthesis. Main implementation passed focused behavior tests; old prompt/source-tail expectations needed updating. A citation edge case found during review was corrected once and passed its new regression. The first full run overlapped that refinement, so it was stale; final full run was clean. Initial smoke missed the login heading while compilation was busy; retry after compilation passed. Next time, finish source refinements before full verification and avoid overlapping browser compilation with the suite. AI wording remains probabilistic; the live synthetic output was structurally correct but repeated some sector context between the lead and sector paragraph. Future real-data model tests require their own authorization.
