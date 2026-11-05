/**
 * Tests never read the developer's .env.local (the sibling of db-guard.ts, which keeps
 * them off the live database).
 *
 * lib/env.ts falls back to .env.local when a variable is EMPTY in the process
 * environment, on purpose, because a shell profile can export ANTHROPIC_API_KEY="". A test
 * that stubs a provider key to "" to mean "this leg is not configured" therefore saw the
 * real key on any machine with a .env.local, and provider failover (default-on) tried live
 * legs: 33 failures in 8 files on a developer machine, green on a clean checkout
 * (2026-11-04). With this flag the fallback is off for the whole test run, so "" means
 * unconfigured everywhere and a test that wants a key stubs a non-empty one.
 */
process.env.VANGUARD_NO_ENV_LOCAL = "1";
