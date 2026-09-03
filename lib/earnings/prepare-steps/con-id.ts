/**
 * Live print v2 slice A, spec §4.1 step 4 — the IBKR contract-id prepare
 * step. Resolves `securities.ib_con_id` for an armed event's symbol ahead
 * of print time so the intel/straddle paths (which need a conId) and the
 * print-watch acquisition (slice B) never wait on TWS to look up the
 * contract mid-release.
 *
 * TWS being down is a precondition failure, not an attempt — `pending`, per
 * the runner contract (prepare-armed-event.ts) and CLAUDE.md's "pending =
 * precondition not met".
 *
 * [R13] Single external call (`enrichSecurities`); the callee accepts no
 * `AbortSignal`, so nothing is forwarded — but `ctx.signal` IS checked right
 * after that call returns, before the post-read below, so a deadline that
 * fires while `enrich` is in flight never lets an abandoned invocation book
 * a done/failed outcome off state the runner has already moved on from.
 */
import type Database from "better-sqlite3";
import { enrichSecurities } from "@/lib/tws/contracts";
import { getIbApi } from "@/lib/tws/client";
import { stableHash, type PrepareStepDefinition } from "../prepare-armed-event";

interface SecRow { id: number; ib_con_id: number | null; }
function resolveSecurity(db: Database.Database, eventId: number): { symbol: string | null; sec: SecRow | null } {
  const e = db.prepare(`SELECT symbol, security_id FROM calendar_events WHERE id = ?`).get(eventId) as { symbol: string | null; security_id: number | null } | undefined;
  if (!e) return { symbol: null, sec: null };
  const sec = (e.security_id != null
    ? db.prepare(`SELECT id, ib_con_id FROM securities WHERE id = ?`).get(e.security_id)
    : db.prepare(`SELECT id, ib_con_id FROM securities WHERE UPPER(symbol) = UPPER(?) ORDER BY id LIMIT 1`).get(e.symbol ?? "")) as SecRow | undefined;
  return { symbol: e.symbol, sec: sec ?? null };
}

export function makeConIdStep(deps: { twsUp?: () => boolean; enrich?: typeof enrichSecurities } = {}): PrepareStepDefinition {
  const twsUp = deps.twsUp ?? (() => getIbApi() != null);
  const enrich = deps.enrich ?? enrichSecurities;
  return {
    fingerprint(db, eventId) { const { sec } = resolveSecurity(db, eventId); return stableHash(["con_id", 1, sec?.id ?? null, sec?.ib_con_id ?? null]); },
    async run(db, eventId, ctx) {
      const { symbol, sec } = resolveSecurity(db, eventId);
      if (!sec) return { status: "done", note: `no securities row for ${symbol ?? "?"}` };
      if (sec.ib_con_id != null) return { status: "done", note: "already resolved" };
      if (!twsUp()) return { status: "pending", reason: "TWS offline" };   // not an attempt (spec §4.1 step 4)
      const results = await enrich(db, [sec.id]);
      // [R13] The deadline may have fired while `enrich` was in flight — the runner has
      // already raced this invocation and moved on, so don't book a result off it now.
      if (ctx.signal.aborted) return { status: "pending", reason: "aborted" };
      const after = db.prepare(`SELECT ib_con_id FROM securities WHERE id = ?`).get(sec.id) as { ib_con_id: number | null };
      if (after.ib_con_id != null) return { status: "done" };
      const err = results.find((r) => r.securityId === sec.id)?.error ?? "contract not resolved";
      return { status: "failed", error: err.slice(0, 300) };
    },
  };
}
export const conIdStep = makeConIdStep();
