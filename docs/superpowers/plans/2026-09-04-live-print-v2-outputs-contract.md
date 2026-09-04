# Live print v2 — cross-slice contract for slices E and F (E produces, F consumes)

Both plans quote these shapes VERBATIM. E and F share NO file: E never edits
`app/dashboard/**` or `lib/print-watch/contracts.ts`; F never edits `lib/earnings/**`,
`lib/digest/**`, `lib/calendar/**`, `lib/email.ts`, `lib/queries/earnings-emails.ts`,
`lib/mutations/earnings-emails.ts`, any `app/api/print-watch/**` route, or the Worker.
Migration number: E = 092 (additive `.sql`). F = none.

Both slices branch from `main` at `31d0e84f` (B, C and D merged; DB at 091). Either may
merge first; the second rebases. The buttons F renders reach E's routes only after BOTH
merge — the merge session verifies that integration end to end on `main`.

## 1. `earnings_emails` send states (E extends the existing `error` sentinel set)

`error` stays the state column (the tri-state convention in
`docs/reference/earnings-pipeline.md` §7). Values after E:

| `error` value        | Meaning                                                                 | Live claim? | Delivered (blocks automatic resend)? |
|----------------------|-------------------------------------------------------------------------|-------------|--------------------------------------|
| `NULL`               | sent locally (row committed after the provider accepted)                | no          | yes                                  |
| `'in_progress'`      | claimed; composing (existing)                                           | yes         | no                                   |
| `'sending'`          | NEW — provider call in flight; prose + `provider_message_id` written     | yes         | no                                   |
| `'sent-by-cloud'`    | Worker fallback delivered (existing)                                    | no          | yes                                  |
| `'delivery_unknown'` | NEW — terminal; provider outcome unknown; manual reconciliation only    | no          | yes                                  |
| any other string     | legacy failure text (treated as delivered by `getEmailStatesForEvents`) | no          | yes                                  |

Single-sourced in `lib/earnings/email-states.ts` (E creates):

```ts
export const LIVE_CLAIM_STATES = ["in_progress", "sending"] as const;
export const DELIVERED_SENTINELS = ["sent-by-cloud", "delivery_unknown"] as const;
export function isLiveClaim(error: string | null): boolean;
export function isDelivered(error: string | null): boolean; // NULL or a DELIVERED_SENTINEL or legacy text
/** SQL fragment: `(<col> IS NULL OR <col> NOT IN ('in_progress','sending'))` */
export function notLiveClaimSql(col: string): string;
/** SQL fragment: `(<col> IS NULL OR <col> IN ('sent-by-cloud','delivery_unknown'))` */
export function deliveredSql(col: string): string;
```

`lib/earnings/cockpit-stages.ts` (E edits):

```ts
export type EmailSendState = "sent" | "sent-by-cloud" | "in-flight" | "delivery-unknown" | null;
// PreviewStage and RecapStage gain "delivery-unknown" too; derivation: a
// 'delivery_unknown' audit row → stage "delivery-unknown" (never "sent").
```

`getEmailStatesForEvents` maps `'sending'` → `"in-flight"`, `'delivery_unknown'` →
`"delivery-unknown"`. **F renders `"delivery-unknown"`** in every chip that renders
`EmailSendState` / `PreviewStage` / `RecapStage` (tone `warn`, glyph `?`, full-word label
`delivery unknown`, title "The provider's response was never received — check the mailbox
or the Resend log for the message id, then resend by hand if needed."). Until F merges, the
cockpit's `chipFor` fallback renders an unknown state as a bare label with the neutral tone
and no glyph (verified against `EarningsCockpit.tsx::chipFor`); that is acceptable on E's
branch and is why F's chip maps must be TOTAL over the unions.

**Two delivered predicates, on purpose (E plan finding, 2026-09-04).** `isDelivered(error)`
(NULL, a DELIVERED_SENTINEL, or legacy failure text — the `getEmailStatesForEvents` reading)
and `deliveredSql(col)` / `isDeliveredStrict(error)` (NULL or a DELIVERED_SENTINEL only — the
reading `wrap.ts`, `debrief.ts` and `event-merge.ts` use today). E documents which readers
take which; neither is merged into the other.

**A `delivery_unknown` row HAS a stored body (Codex E round 1, finding 14 — ruling R-E14).**
A fresh send that ended `delivery_unknown` stores the body it ATTEMPTED; a manual refire that
ended `delivery_unknown` keeps the PREVIOUSLY DELIVERED body (E's M-E13) while
`provider_message_id` names the LAST attempt's RFC Message-ID. `getEmailAudit` returns such
rows. Therefore **F renders a `delivery-unknown` chip as CLICKABLE** (it opens the existing
email viewer), and E's `GET /api/earnings/email-content` returns an additive
`deliveryState: "sent" | "sent-by-cloud" | "delivery-unknown"` beside `sentBy` so the viewer
can show a banner. Reconciliation actions (E): a manual resend through `POST /api/earnings/email`
(today's refire path, explicit) and a new additive body option `{ eventId, phase,
markDelivered: true }` that flips `delivery_unknown` → sent WITHOUT sending (the desk confirmed
delivery by hand); both are E-owned, F renders nothing new for them in this slice.

**Guard scope (Codex F round 1, finding 12 — ruling R-F12).** E's repo guard against
hand-rolled state literals scans `lib/**` and `app/api/**` ONLY — the server-side readers of
the column. `app/dashboard/**` is exempt by design: UI files carry the state words as
TypeScript union members and display keys (`EmailSendState` etc.), not as SQL. F therefore
needs no allowlist entry and no client-safe constant import.

## 2. `GET /api/print-watch/status` gains `outputs` per print (E adds; F renders)

```ts
export type RecapSendState =
  | "unsent" | "in-flight" | "sent" | "sent-by-cloud" | "delivery-unknown";

export interface PrintOutputs {
  printSheet: {
    /** true when at least one non-retired line carries a `value` (spec §4.5). */
    enabled: boolean;
    /** Domain copy when disabled, else null. */
    reason: string | null;
  };
  sendRecap: {
    /** true when the gate in §3 passes AND state is "unsent". */
    enabled: boolean;
    /** Gate refusal copy, or the state word when not unsent, else null. */
    reason: string | null;
    state: RecapSendState;
    /** Set when state is "delivery-unknown" or "sent" (local). */
    providerMessageId: string | null;
  };
}
```

Every entry in `data.prints[]` carries `outputs: PrintOutputs`. Computed by
`lib/earnings/print-outputs.ts::evaluatePrintOutputs(db, printId)` — store reads only; the
GET stays a pure read (`tests/api/no-state-changing-gets` guard).

**F's rule:** the outputs row (`PrintOutputs.tsx`, inside `LivePrintRow`) renders ONLY when
`print.outputs` is present in the payload; a payload without it (E unmerged) renders no
buttons and no error. F's render test seeds a fixture WITH `outputs`.

## 3. Routes (E creates; human auth by default through `proxy.ts`; envelope `{success, data|error}`)

### `POST /api/print-watch/print-sheet` — body `{ printId: number }`

- 400 `{success:false,error}` on a malformed body; 404 when no print.
- 409 `{success:false,error:<outputs.printSheet.reason>}` when disabled.
- 200 `{success:true,data:{ road: "pdf" | "monospace", pages: number | null, symbol: string }}`.

### `POST /api/print-watch/send-recap` — body `{ printId: number }`

- 400 malformed; 404 no print.
- 200 for EVERY coordination outcome (F renders `data.outcome` and `data.reason` verbatim):

```ts
export type SendRecapOutcome =
  | { outcome: "sent"; sentTo: string; providerMessageId: string; title: string }
  | { outcome: "in_progress" }
  | { outcome: "already_sent"; sentAt: string; sentBy: "local" | "cloud" }
  | { outcome: "delivery_unknown"; providerMessageId: string | null; since: string; note?: string }  // note: why it is unknown (timeout, ambiguous provider failure, post-accept persistence failure, reaper)
  | { outcome: "refused"; reason: string }   // gate refusal OR service refusal (no recipient, not ready)
  | { outcome: "failed"; reason: string };   // compose/model failure or definitive provider rejection; claim released; retryable
```

- 500 only for an unexpected exception.

Gate (E, `lib/earnings/recap-nudge-gate.ts::evaluateRecapNudge(db, printId)`), refusal copy
verbatim:

- `"No print for this event."`
- `"Accept the headline pair first — EPS (adjusted or GAAP) and revenue must both be accepted with a reported value."`
- `"Promote the headline pair first — the recap reads EPS and revenue from the event, and nothing has been promoted yet."`
- `"The recap needs a reported actual on the event — promote the headline pair first."` (`actual_value IS NULL` after a promote that did not land)

### `POST /api/earnings/email` (existing manual route) — unchanged body; now routes through the
service in `manual` mode. Responses keep their existing shape for the existing callers.

## 4. `POST /api/print-watch/go` (existing, slice C) — the paste box F adds posts

`{ eventId, url? }` or `{ eventId, contentBase64, filename? }` — exactly the route's current
body (`app/api/print-watch/go/route.ts`). F adds no route.

## 5. Extra metric lines (F owns `lib/print-watch/contracts.ts`; E never reads `extra_metrics_json`)

`compileContracts` keeps its signature and return keys and gains ONE additive key:

```ts
export function compileContracts(db, eventId, symbol): {
  contracts: LineContract[];
  expected: Record<string, ExpectedValue>;
  /** Extra-metric ids that appear on ≥2 bogey rows with disagreeing unit/kind/period/basis — NOT compiled. */
  conflicts: Array<{ id: string; fields: string[] }>;
};
```

Extra-metric line ids are `x_<uuid>_<period>`. E's sheet composer, read facts and the
callout verifier consume `LineContract[]` generically and need no change for them.

## 6. Ownership summary

| Slice | Creates | Edits |
|---|---|---|
| E | `lib/earnings/{email-states,send-service,recap-nudge-gate,print-outputs,post-print-sheet,print-ladder}.ts`, `lib/digest/print-watch-read-block.ts`, `lib/db/migrations/092_earnings_email_delivery_states.sql`, `app/api/print-watch/{print-sheet,send-recap}/route.ts`, tests | `lib/digest/send-earnings-email.ts`, `lib/calendar/email-sweep.ts`, `lib/email.ts`, `lib/earnings/{print-sheet,worksheet,reporter-recap,debrief-send,wrap-send,event-merge,cockpit-stages,debrief,wrap}.ts`, `lib/calendar/reconcile-earnings-dates.ts`, `lib/mutations/calendar.ts`, `lib/queries/earnings-emails.ts`, `app/api/earnings/email/route.ts`, `app/api/earnings/email-content/route.ts`, `app/api/print-watch/status/route.ts`, `workers/cron/src/fallback-earnings.ts` (+ its test), `scripts/rehearse-additive-migrations.ts`, docs. **Additive extensions after Codex E round 1 (F touches none of these):** `lib/print-watch/{first-pass-types,read-facts}.ts` (ONLY: a nominal brand on `DirectionSafeFacts`, applied inside `directionSafeFacts()`), `lib/earnings/actuals.ts` (ONLY: export the pure composer of the promoted `actual_value` string if it is not already exported) |
| F | `app/dashboard/today/{EarningsHubLive,LivePrintRow}.tsx`, `app/dashboard/today/live-print/*`, `app/dashboard/today/hub-live/*`, `lib/print-watch/extra-metrics.ts`, `lib/print-watch/recompile.ts`, tests | `app/dashboard/today/{page,EarningsHub,EarningsRowChips,BogeysEditModal}.tsx`, `app/dashboard/analysis/page.tsx`, `lib/print-watch/contracts.ts`, `lib/queries/earnings-cockpit.ts`, `app/api/earnings/cockpit/route.ts`, `app/api/earnings/bogeys/route.ts`, `lib/mutations/earnings-bogeys.ts`, `tests/dashboard/print-watch-panel.test.ts`, docs; DELETES `app/dashboard/today/{EarningsCockpit,PrintWatchPanel}.tsx`. **Additive extensions after Codex F round 1 (E touches none of these):** `lib/queries/earnings-bogeys.ts` (`extra_metrics_json` joins the explicit SELECT), `lib/queries/earnings-intel.ts` (`allCockpitRows` also walks `rowsByEvent`, deduped), `app/api/print-watch/sources/route.ts` (+ a read-only `GET ?symbol=`), `lib/print-watch/watcher.ts` (ONLY: `writeLines`' compile→reconcile→upsert wrapped in one `.immediate()` transaction) |

Shared-file check: none of E's edit list appears in F's, and vice versa. `docs/DECISIONS.md`,
`docs/plans/TODO.md` and `docs/reference/earnings-pipeline.md` are edited by both — each slice
appends its own section; the rebase resolves by keeping both (the C/D precedent).
