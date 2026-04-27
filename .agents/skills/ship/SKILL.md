---
name: ship
description: Ship workflow for Vanguard Skin — run full test suite, type-check, conventional commit, reconcile TODO.md, push. Use when the user says "ship it", "let's commit and push", "wrap this up and ship", or after completing a feature/fix that's ready to land.
---

# Ship Workflow

1. Run full test suite, report count.
2. Run `npx tsc --noEmit` to verify types.
3. Stage changes and create a conventional commit.
4. **Reconcile TODO list.** Read `docs/plans/TODO.md`. For every item this commit closes (headline or sibling), move it from "Open items" to a "Closed this session" block with `✅`, today's date, and this commit's short hash. Verify via grep that the item actually shipped — do not tick on intent. If the commit introduces follow-up work, add it to "Open items" with enough context (files, ~time, why) for a cold pickup. Commit the TODO.md update as a separate docs-only commit with a message like `docs: TODO.md — mark <item> shipped`.
5. Push current branch (carries both the code commit and the TODO commit in one atomic push, so remote + CI see them together).
6. Report summary of what shipped (including TODO items closed).
