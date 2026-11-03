# Golden corpus: earningsBogeysExtraction

Design section 8 requires frozen real inputs per feature. This repo is PUBLIC, so
the committed corpus is SYNTHETIC only (invented tickers and figures, never a
real sheet). It drives the comparator tests.

Real sheets go in the gitignored `tests/fixtures/real/failover/earningsBogeysExtraction/`
as `<name>.pdf` plus `<name>.baseline.json` (the Anthropic extraction, recorded with
`npx tsx scripts/failover-pdf-parity.ts --record-baseline <dir>`), then
`npx tsx scripts/failover-pdf-parity.ts <dir>` runs the OpenAI leg and applies the
exact-figure gate. Both runs spend real API money; neither is part of the test suite.
