---
description: Independent read-only Codex design review of a plan/spec file
argument-hint: <path-to-plan-or-spec.md>
allowed-tools: Bash(codex exec:*), Bash(ls:*), Read, Write
---

# Codex design review (read-only second opinion)

Run an independent Codex review of a feature plan or design spec. Codex runs in a
separate read-only session — it is a second opinion, not a collaborator, so do NOT
feed it this conversation's conclusions beyond what the prompt below contains.

## Steps

1. **Resolve the target file.** `$ARGUMENTS` is the plan/spec path. If empty, use the
   newest file in `docs/superpowers/specs/` or `docs/superpowers/plans/` (whichever the
   user was just working on). Verify it exists before proceeding.

2. **Write the review prompt to a scratchpad file** (avoids bash 3.2 quoting traps —
   never inline a prompt with apostrophes). Prompt template:

   > Act as an independent design reviewer for the Portfolio Desk repo (Next.js +
   > SQLite portfolio dashboard). Read the plan at `<TARGET>`, the repo `CLAUDE.md`,
   > and any `docs/reference/*.md` files the plan's area touches. Do not edit any
   > files — this is a read-only review.
   >
   > Identify, as separate numbered findings: missing requirements; data-integrity
   > risks (this repo treats statement data as authoritative and forbids guessed
   > financial values); privacy/security risks (portfolio specifics must stay out of
   > committed files); migration concerns; re-import/idempotence hazards;
   > test/E2E gaps; and unresolved design decisions.
   >
   > For each finding give severity (high/medium/low) and a one-line suggested
   > resolution. Finish with a single line: APPROVE or REVISE.

   Replace `<TARGET>` with the resolved path.

3. **Run Codex** (read-only sandbox, non-interactive `exec` mode, generous timeout —
   reviews can take several minutes):

   ```
   codex exec --sandbox read-only -C /Users/Yitzi/code/vanguard-skin "$(cat <prompt-file>)"
   ```

   Use a Bash timeout of 600000 ms. Do not retry a clean REVISE verdict — that is a
   result, not an error.

4. **Relay the review faithfully.** Show the user Codex's findings and verdict
   (condensed is fine, but never soften or omit findings). Then:
   - Findings you agree with → propose concrete spec/plan edits.
   - Findings you disagree with → say why and bring the disagreement to the user;
     do not silently drop them (receiving-code-review skill applies).
   - Never mark the plan approved on Codex's behalf — the user owns the final call.
