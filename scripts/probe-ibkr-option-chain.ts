/**
 * scripts/probe-ibkr-option-chain.ts
 *
 * Live probe for the earnings-intelligence straddle road (Task 1 of the
 * earnings-intelligence plan). Run with TWS off or on — the Web API OAuth
 * path is independent of TWS. Requires the IBKR OAuth config dir (see
 * IBKR_OAUTH_DIR below).
 *
 *   IBKR_OAUTH_DIR=/path/to/data/ibkr-oauth npx tsx scripts/probe-ibkr-option-chain.ts [SYMBOL]
 *
 * (loadIbkrConfig() reads IBKR_OAUTH_DIR itself via ibkrOAuthDir(); defaults
 * to ./data/ibkr-oauth relative to cwd when unset.)
 *
 * DB path: reads process.env.PROBE_DB_PATH if set, else ./data/vanguard.db
 * relative to cwd. This repo's OAuth credentials + live DB both live in the
 * main checkout, not necessarily the cwd this script runs from (e.g. when run
 * from a worktree that has no data/ dir) — point PROBE_DB_PATH there:
 *
 *   PROBE_DB_PATH=/Users/Yitzi/code/vanguard-skin/data/vanguard.db \
 *   IBKR_OAUTH_DIR=/Users/Yitzi/code/vanguard-skin/data/ibkr-oauth \
 *   npx tsx scripts/probe-ibkr-option-chain.ts AAPL
 *
 * Opens the DB read-only — this is a read-only probe, never writes anything,
 * and only calls GET endpoints on IBKR (never order/trade endpoints).
 *
 * Probes, in order, printing RAW JSON for each:
 *   1. /iserver/secdef/strikes  — strikes for the front option month
 *   2. /iserver/secdef/info     — option conids + maturityDates for the ATM strike
 *   3. /iserver/marketdata/snapshot on the resolved call+put conids with
 *      candidate fields 31,84,85,86,88 — to pin which codes are bid/ask and
 *      whether values carry prefix markers like field 31's C/H.
 *
 * PROBE RESULTS (2026-07-08, live against AAPL conid 265598 + IBKR OAuth
 * headless session — Task 5's constants come from here):
 *
 *   - strikes params: GET /iserver/secdef/strikes?conid=<underlyingConid>&sectype=OPT&month=<MMMYY>&exchange=SMART
 *     Key is lowercase "sectype" (matches /secdef/info and /secdef/search —
 *     never "secType"; both casings return HTTP 200 in this probe so casing
 *     itself isn't validated by the server, but "sectype" is the form used
 *     everywhere else in this codebase's IBKR clients). month = 3-letter
 *     month + 2-digit year, e.g. "JUL26" — verified against the exact string
 *     format /iserver/secdef/search returns in `sections[].months`.
 *     Response shape: `{ call: number[], put: number[] }` — two flat arrays
 *     of strike prices (floats), not paired/keyed objects.
 *     **WARM-UP QUIRK — REVISED 2026-07-20 (live probe, RTH)**: polling alone
 *     is NOT a reliable warmer. On 2026-07-20 a fresh session returned the
 *     empty shape for 9+ polls across BOTH JUL26 and AUG26; a single
 *     /iserver/secdef/search?symbol=<SYM>&secType=STK call then made both
 *     months populate on the FIRST poll. The 7/8 observation below ("retry
 *     loop reliably got a populated response within 1-2 polls") held only
 *     because that session's own /secdef/search verification calls had
 *     already primed the server-side cache. This script and production
 *     (lib/ibkr/option-chain.ts::resolveAtmContracts) now both issue the
 *     search warm-up before the strikes loop; the retry loop stays as
 *     defense. Original 7/8 finding for context:
 *     the very first call for a given
 *     (conid, month) combination reliably returns `{"call":[],"put":[]}`
 *     with HTTP 200 (no error) even though /secdef/search confirms the
 *     month is valid and has strikes. This is NOT a session-freshness
 *     issue — a brand-new LST + immediate first call sometimes returned
 *     empty, sometimes returned the full populated list, depending on
 *     whether some other recent call (in this process or, seemingly,
 *     server-side across time) had already warmed that (conid, month)
 *     cache. Six back-to-back param-shape variants (different sectype
 *     casing, with/without exchange, alternate month formats) all returned
 *     empty within the same ~2.5s window — ruling out a param-shape bug —
 *     while a retry loop with ~1.5s delays reliably got a populated
 *     response within 1-2 polls. **Task 5 must poll this endpoint the same
 *     way `getMarketDataSnapshot` already polls `/iserver/marketdata/snapshot`**
 *     (this script does exactly that — see the `maxStrikesPolls` loop).
 *
 *   - info params: GET /iserver/secdef/info?conid=<underlyingConid>&sectype=OPT&month=<MMMYY>&strike=<strike>&right=C|P&exchange=SMART
 *     `strike` is REQUIRED — omitting it 400s with
 *     `{"error":"Bad Request: strike is required for warrant and option"}`.
 *     `right` is a single letter, "C" or "P".
 *     **Response shape is an ARRAY, and it is NOT one contract per
 *     (month,strike,right) — it is every expiry (including weeklies) that
 *     falls within the named month for that strike+right.** Live example:
 *     querying month="JUL26", strike="292.5", right="C" on 2026-07-08
 *     returned 8 rows spanning maturityDate 20260708 (TODAY, 0DTE) through
 *     20260724 (weeklies every 2-3 days), with the *standard* monthly
 *     (3rd-Friday, 20260717) as the 5th element, not the 1st.
 *     **`info[0]` — exactly what the starter code speculated — silently
 *     grabs the same-day 0DTE contract whenever one exists, NOT a sensible
 *     "front month" contract.** Task 5 MUST filter the returned array by
 *     `maturityDate` (format "YYYYMMDD") for the specific expiry it wants
 *     (e.g. the earnings-adjacent expiry, or explicitly the nearest
 *     standard monthly) rather than indexing [0]. This script now
 *     demonstrates the fix: it logs every maturityDate found and selects
 *     the nearest one that is NOT today (falls back to the first entry only
 *     if every expiry in the month is today, which shouldn't happen for a
 *     liquid underlying). conid lives at `info[N].conid` (number — already
 *     the OPTION contract's own conid); multiplier at `info[N].multiplier`
 *     (string "100"); human description at `info[N].desc2` (e.g.
 *     "JUL 17 '26 292.5 Call").
 *
 *   - bid field: 84   ask field: 86
 *     Verified via same-row ordering across 4 distinct live contracts (never
 *     assumed from the a-priori guess): e.g. 0DTE 292.5 call read
 *     `{"84":"20.25","31":"21.27","86":"22.10"}` (bid < last < ask) and the
 *     20260717 292.5 put read `{"84":"0.42","31":"0.47","86":"0.49"}` (same
 *     ordering). Field 85 is NOT a price — it showed integer/size-like
 *     values ("63", "117", "1,500" — note the thousands-comma on larger
 *     values, e.g. size fields) with no relation to the bid/ask spread.
 *     Field 88 is likewise not a price (small integers like "36", "16",
 *     "156") and its meaning was not identified — not needed for the
 *     straddle read (only last/bid/ask matter), so left unresolved.
 *     **Missing quote = the field key is OMITTED from the row entirely**,
 *     not a sentinel like "0" or "-1" or an empty string — observed
 *     repeatedly for field 84 (bid) on deep-OTM/no-resting-bid contracts.
 *     Any parser must do an `in`/`undefined` check per field, exactly like
 *     the existing `parseSnapshotRow` pattern (`row[FIELD]` → undefined).
 *
 *   - prefix markers on option bid/ask/last: field 31 (last) CAN carry the
 *     "C" prior-close prefix (documented for options generally by the
 *     sibling probe `scripts/probe-ibkr-optbond-snapshot.ts`; reconfirmed
 *     here with a fresh live example: a deep-OTM Jul-17 110-strike put read
 *     `"31":"C0.00"` — the contract has never traded, so 31 carries the
 *     prior/settlement close of 0.00 prefixed with "C"). **Fields 84 (bid)
 *     and 86 (ask) never carried a C/H prefix in ANY row observed across 6
 *     distinct contracts, including the SAME ROW where 31 was prefixed**
 *     (`{"85":"1,000","31":"C0.00","86":"0.01"}` — 86 is a bare "0.01" on
 *     the identical instant/row that 31 read "C0.00"). This is the
 *     strongest possible evidence: prefix stripping (`parseLastPrice`'s
 *     `.replace(/^[CH]/, "")` pattern in `lib/ibkr/market-data.ts`) is only
 *     needed on field 31 for options; 84/86 can be parsed as plain numeric
 *     strings with no prefix-stripping step required. (Not tested: whether
 *     84/86 ever carry an "H"-halted prefix — no halted contract was
 *     observed in this session; if Task 5 wants defense-in-depth it can
 *     reuse the same `[CH]` strip on 84/86 harmlessly since it's a no-op on
 *     unprefixed values, but it was not required to explain any observed
 *     row here.)
 *
 * Negative results (shapes that did NOT work, so Task 5 doesn't re-try them):
 *   - `/iserver/secdef/strikes` with `secType` (capital T) instead of
 *     `sectype`: still HTTP 200, same body as `sectype` — casing is not
 *     server-validated either way, but this codebase's convention is
 *     lowercase `sectype` (matches `market-data.ts` field-code style).
 *   - `/iserver/secdef/strikes` with `month` as "2026-07" or "JUL2026":
 *     both returned HTTP 503 `{"error":"Service Unavailable"}` — the
 *     3-letter+2-digit "JUL26" form is required, not ISO or 4-digit year.
 *   - `/iserver/secdef/info` with no `strike` param (to try to enumerate an
 *     entire month's chain at once): HTTP 400
 *     `"strike is required for warrant and option"` — there is no
 *     no-strike enumeration mode; strikes must be fetched from
 *     `/secdef/strikes` first, then `/secdef/info` called per-strike.
 */
import Database from "better-sqlite3";
import path from "path";
import { loadIbkrConfig } from "../lib/ibkr/config";
import { openSession } from "../lib/ibkr/web-api";
import { signedRequest } from "../lib/ibkr/oauth-client";

async function main() {
  const symbol = (process.argv[2] ?? "AAPL").toUpperCase();
  const cfg = loadIbkrConfig();
  if (!cfg) throw new Error("IBKR OAuth config not found (check IBKR_OAUTH_DIR)");

  const dbPath = process.env.PROBE_DB_PATH ?? path.join(process.cwd(), "data", "vanguard.db");
  const db = new Database(dbPath, { readonly: true });
  const row = db
    .prepare("SELECT ib_con_id AS conid FROM securities WHERE UPPER(symbol) = ? AND ib_con_id IS NOT NULL")
    .get(symbol) as { conid: number } | undefined;
  db.close();
  if (!row) throw new Error(`No ib_con_id for ${symbol} in ${dbPath}`);
  const conid = row.conid;

  console.log(`Opening IBKR session (symbol=${symbol}, conid=${conid})...`);
  const lst = await openSession(cfg); // { token, expirationMs }
  console.log(`Session open, LST expires ${new Date(lst.expirationMs).toISOString()}\n`);

  // Front month in IBKR MMMYY form, e.g. "JUL26".
  const now = new Date();
  const month = now
    .toLocaleDateString("en-US", { month: "short", timeZone: "America/New_York" })
    .toUpperCase() + String(now.getFullYear()).slice(2);

  // Cache warm-up (2026-07-20 finding): without this search call the strikes
  // endpoint can return the empty shape indefinitely regardless of polling.
  console.log(`── warm-up: /iserver/secdef/search symbol=${symbol} ──`);
  const searchResp = await signedRequest(cfg, lst.token, "GET", "/iserver/secdef/search", {
    symbol,
    secType: "STK",
  });
  console.log(`search: HTTP ${searchResp.status}`);
  await searchResp.text(); // drain

  console.log(`── strikes (conid=${conid}, month=${month}) ──`);
  // Live-probed 2026-07-08: /iserver/secdef/strikes can return {"call":[],"put":[]}
  // on a cold per-(conid,month) server-side cache, structurally identical to the
  // /iserver/marketdata/snapshot warm-up quirk already documented in
  // lib/ibkr/market-data.ts. It is NOT about session freshness (a fresh LST can
  // get either an empty or a populated response depending on whether some other
  // recent call already warmed that conid+month combo) — so poll with delay.
  let strikes: { call?: number[]; put?: number[] } = {};
  let callStrikes: number[] = [];
  const maxStrikesPolls = 5;
  for (let i = 0; i < maxStrikesPolls; i++) {
    const strikesResp = await signedRequest(cfg, lst.token, "GET", "/iserver/secdef/strikes", {
      conid: String(conid),
      sectype: "OPT",
      month,
      exchange: "SMART",
    });
    const strikesText = await strikesResp.text();
    console.log(`poll ${i + 1}: HTTP ${strikesResp.status} :: ${strikesText.slice(0, 500)}`);
    try {
      strikes = JSON.parse(strikesText);
    } catch {
      console.error("strikes response was not JSON — aborting");
      process.exit(1);
    }
    callStrikes = strikes?.call ?? [];
    if (callStrikes.length > 0) break;
    if (i < maxStrikesPolls - 1) await new Promise((r) => setTimeout(r, 1500));
  }
  if (callStrikes.length === 0) {
    console.error(`No call strikes returned after ${maxStrikesPolls} polls — aborting before /secdef/info`);
    process.exit(1);
  }
  const mid = callStrikes[Math.floor(callStrikes.length / 2)];

  console.log(`\n── info (strike=${mid}, right=C then P) ──`);
  // Today's date as YYYYMMDD (ET) — used to skip 0DTE rows when picking a
  // sensible expiry, since /secdef/info returns EVERY expiry in the month,
  // not one contract (see PROBE RESULTS above).
  const todayYmd = now
    .toLocaleDateString("en-CA", { timeZone: "America/New_York" })
    .replace(/-/g, "");
  const optionConids: number[] = [];
  for (const right of ["C", "P"]) {
    const infoResp = await signedRequest(cfg, lst.token, "GET", "/iserver/secdef/info", {
      conid: String(conid),
      sectype: "OPT",
      month,
      strike: String(mid),
      right,
      exchange: "SMART",
    });
    console.log(`${right}: HTTP ${infoResp.status}`);
    const infoText = await infoResp.text();
    let info: unknown;
    try {
      info = JSON.parse(infoText);
    } catch {
      console.error(`${right}: info response was not JSON — skipping`);
      console.log(infoText.slice(0, 500));
      continue;
    }
    if (!Array.isArray(info)) {
      console.error(`${right}: info response was not an array — skipping`);
      continue;
    }
    const rows = info as Array<{ conid?: number; maturityDate?: string; desc2?: string }>;
    console.log(`  ${rows.length} expiries returned: ${rows.map((r) => r.maturityDate).join(", ")}`);
    // Pick the nearest expiry that is NOT today (0DTE); fall back to the
    // first row only if every expiry in the month is today.
    const chosen =
      rows.find((r) => r.maturityDate && r.maturityDate !== todayYmd) ?? rows[0];
    console.log(`  chosen: conid=${chosen?.conid} maturityDate=${chosen?.maturityDate} desc=${chosen?.desc2}`);
    if (chosen?.conid) optionConids.push(Number(chosen.conid));
  }

  if (optionConids.length === 0) {
    console.error("\nNo option conids resolved from /secdef/info — cannot probe snapshot fields");
    process.exit(1);
  }

  console.log(`\n── snapshot on option conids ${optionConids.join(",")} ──`);
  const fields = "31,84,85,86,88";
  for (let i = 0; i < 3; i++) {
    const snapResp = await signedRequest(
      cfg,
      lst.token,
      "GET",
      `/iserver/marketdata/snapshot?conids=${optionConids.join(",")}&fields=${fields}`,
      {},
    );
    console.log(`poll ${i + 1} (HTTP ${snapResp.status}):`, await snapResp.text());
    await new Promise((r) => setTimeout(r, 1500));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
