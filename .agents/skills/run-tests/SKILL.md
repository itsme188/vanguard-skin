---
name: run-tests
description: "Run Vitest tests for the Vanguard Skin project — pass a path filter (e.g., 'compute', 'import', 'queries') or run all tests."
---

# Run Tests

Run the Vitest test suite for Vanguard Skin.

## Usage

- `/run-tests` — Run all tests
- `/run-tests compute` — Run tests in `tests/compute/`
- `/run-tests import` — Run tests in `tests/import/`
- `/run-tests queries` — Run tests in `tests/queries/`
- `/run-tests db` — Run tests in `tests/db/`
- `/run-tests tws` — Run tests in `tests/tws/`
- `/run-tests chat` — Run tests in `tests/chat/`
- `/run-tests integration` — Run tests in `tests/integration/`

## Steps

1. If the user provided a filter argument, run: `npx vitest run tests/{argument}/ --exclude '.Codex/**'`
2. If no argument, run all tests: `npx vitest run --exclude '.Codex/**'`
3. After tests complete, summarize:
   - Total pass/fail counts
   - Duration
   - Any failures with file name and test name
4. If failures exist, read the failing test file and the source file it tests to diagnose the issue.

## Notes

- Always use `--exclude '.Codex/**'` to avoid picking up worktree duplicates.
- Tests use in-memory SQLite (`new Database(":memory:")`) — no real DB needed.
- All DB functions take a `db` parameter for dependency injection.
