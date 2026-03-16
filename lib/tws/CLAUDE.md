# TWS API — Domain Rules

Rules specific to the IBKR Trader Workstation integration. See root CLAUDE.md for project-wide conventions.

## Connection

- **Port 7496** (live trading), **clientId 1** (Stock Contest uses clientId 2)
- TWS must be running for any API connection to work
- Uses `@stoqey/ib` package's `IBApiNext` (promise-based wrapper)

## State Management

- **globalThis singleton** — `client.ts` stores all TWS state on `globalThis.__tws_*` properties. Module-level `let` variables RESET on Turbopack HMR reload, orphaning TCP sockets. Never use module-level state.
- `getCurrentTime()` timeout: 5s (connection health check)
- Socket cleanup: always disconnect stale instances before reconnecting

## Rate Limiting

- 55 requests per 10-minute window + 500ms pacing delay between requests
- 30-second timeout per security price fetch
- IB API requires `secType`, `exchange`, `currency` in all contracts — even when `conId` is provided

## Price Fetching

- Price fetch requires `ib_con_id IS NOT NULL` — run Enrich endpoint first
- TWS prices use `INSERT OR REPLACE` (authoritative over statement-sourced), source = `'tws'`
- Bonds fail with `TRADES` whatToShow — need `YIELD`/`BID_ASK` (not yet implemented)
- SSE streaming for progress UI (same pattern as `/api/chat`)
