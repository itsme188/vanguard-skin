# PR #6 Review Fixes: Source Key Idempotency

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the source_key idempotency bug found in PR #6 code review — changing `mapTransactionType` to return UPPERCASE breaks deduplication for previously imported Vanguard PDF transactions.

**Architecture:** The `sourceKey` field in transactions is used for `INSERT OR IGNORE` deduplication. The PR changed `mapTransactionType` to return UPPERCASE (`"BUY"` instead of `"buy"`), but the `txnType` value is embedded directly in the `sourceKey` template literal. This means re-importing a PDF after this PR creates new source_keys that don't match existing ones, causing duplicates. The fix: normalize to lowercase in the sourceKey only, keeping the stored `type` field uppercase.

**Tech Stack:** TypeScript, Vitest

**Branch:** `feat/options-data-foundation` (the PR branch)

---

### Task 1: Check out the PR branch

**Step 1: Switch to the PR branch in this worktree**

```bash
cd /Users/Yitzi/code/vanguard-skin/.claude/worktrees/angry-lichterman
git checkout feat/options-data-foundation
```

**Step 2: Verify tests pass on the branch as-is**

```bash
npx vitest run
```

Expected: All 160 tests pass.

---

### Task 2: Fix sourceKey to use lowercase txnType

**Files:**
- Modify: `lib/import/parsers/vanguard-pdf.ts:305`

**Step 1: Write a failing test that proves the bug**

In `tests/import/parsers/vanguard-pdf.test.ts`, the existing test "generates deterministic source keys for transactions" already asserts the source key format. On the PR branch, it expects uppercase (`BUY`). Change it to expect lowercase (`buy`) — this is the correct behavior per the CLAUDE.md contract ("re-import is a no-op"):

```typescript
    it("generates deterministic source keys for transactions", () => {
      const pltrBuy = result.transactions.find(
        (t) => t.symbol === "PLTR" && t.type === "BUY"
      );
      expect(pltrBuy!.sourceKey).toBe(
        "vanguard-pdf:txn:Vanguard Roth IRA:2025-01-14:PLTR:buy:-712.5"
      );
    });
```

Note: the filter uses `"BUY"` (uppercase, since the `type` field IS uppercase), but the expected sourceKey uses `"buy"` (lowercase, for backward compatibility).

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/import/parsers/vanguard-pdf.test.ts
```

Expected: FAIL — sourceKey contains `BUY` but test expects `buy`.

**Step 3: Fix the sourceKey in vanguard-pdf.ts**

In `lib/import/parsers/vanguard-pdf.ts`, line 305, change the sourceKey template to normalize txnType to lowercase:

Before:
```typescript
      sourceKey: `vanguard-pdf:txn:${accountName}:${tradeDate}:${t.symbol ?? "cash"}:${txnType}:${t.amount}`,
```

After:
```typescript
      sourceKey: `vanguard-pdf:txn:${accountName}:${tradeDate}:${t.symbol ?? "cash"}:${txnType.toLowerCase()}:${t.amount}`,
```

**Step 4: Run test to verify it passes**

```bash
npx vitest run tests/import/parsers/vanguard-pdf.test.ts
```

Expected: All vanguard-pdf tests PASS.

---

### Task 3: Run full test suite and build

**Step 1: Run all tests**

```bash
npx vitest run
```

Expected: All tests pass.

**Step 2: Verify build compiles**

```bash
npx next build
```

Expected: Build succeeds with no type errors.

---

### Task 4: Commit and push

**Step 1: Commit the fix**

```bash
git add lib/import/parsers/vanguard-pdf.ts tests/import/parsers/vanguard-pdf.test.ts
git commit -m "fix: normalize txnType to lowercase in sourceKey for backward-compatible deduplication"
```

**Step 2: Push to the PR branch**

```bash
git push origin feat/options-data-foundation
```
