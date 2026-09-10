/**
 * Shared Worker predicate: is a reaction leg's data usable?
 *
 * Mirror of lib/calendar/reaction-snapshot-core.ts::isUsableReactionLeg —
 * the Worker can't import from the Mac's lib/ (no Next path-alias across
 * the Cloudflare Workers boundary), so this is a hand-copied twin. Change
 * both sides together.
 *
 * A leg is only usable when both prices are real (finite AND positive) — a
 * 0/0 division (dead quote on both sides) still produces a finite
 * `delta_pct` of 0, which is indistinguishable from a genuine flat move
 * unless the underlying prices are checked too.
 *
 * Both Worker writers use it: captureReactionFromYahoo (yahoo.ts) omits an
 * unusable leg rather than storing a zero-filled sentinel, mirroring the
 * Mac's captureReactionFromTws. Every Worker reader that renders a leg
 * (fallback-earnings.ts's scoreboard, print-push-message.ts's push copy)
 * must apply this same guard before trusting a stored delta_pct.
 *
 * Real incident (2026-09, synthetic reproduction): a stored qqq leg of
 * {t_pre:0,t_post:0,delta_pct:0} — captured via this Worker's yahoo path
 * ("source":"yahoo") — rendered as "QQQ @ T+2h | +0.00%" in a sent recap
 * email as if the market had actually been flat. This predicate cannot
 * catch every bad leg — a leg whose prices are both real but merely
 * IDENTICAL (a stale/echoed quote, e.g. t_pre 100 -> t_post 100.002) still
 * passes as "usable" because both sides are finite and positive. It only
 * rules out the zero/negative/non-finite sentinel class.
 */

import type { BenchmarkReaction } from "./reaction-matcher";

export function isUsableReactionLeg(
  leg: { t_pre?: number; t_post?: number; delta_pct?: number } | null | undefined,
): leg is BenchmarkReaction {
  return (
    leg != null &&
    Number.isFinite(leg.t_pre) &&
    (leg.t_pre as number) > 0 &&
    Number.isFinite(leg.t_post) &&
    (leg.t_post as number) > 0 &&
    Number.isFinite(leg.delta_pct)
  );
}
