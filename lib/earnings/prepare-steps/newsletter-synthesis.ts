/**
 * The `newsletter_synthesis` prepare step (2026-10-20): the frontier-tier deep
 * read of an armed name's previews (lib/earnings/deep-read-bogeys.ts).
 *
 * Fingerprint = the ids of the articles the read would see (received before
 * the print's slot floor, naming the company) plus the read's version. So a
 * new preview the day before the print re-runs the read once, and nothing
 * after the floor ever does: a recap cannot become a bogey. One model call per
 * run, on the frontier tier.
 *
 * Outcomes: no article names the company -> `done` with a note (nothing to
 * read is not a failure, and a later preview drifts the fingerprint); a model
 * or parse failure -> `failed` (an attempt; the runner caps at five).
 */
import { gatherDeepReadInputs, runDeepRead, DEEP_READ_VERSION } from "@/lib/earnings/deep-read-bogeys";
import { stableHash, type PrepareStepDefinition } from "../prepare-armed-event";

export function makeNewsletterSynthesisStep(
  deps: { run?: typeof runDeepRead } = {},
): PrepareStepDefinition {
  const run = deps.run ?? runDeepRead;
  return {
    fingerprint(db, eventId) {
      const inputs = gatherDeepReadInputs(db, eventId);
      return stableHash([
        "newsletter_synthesis",
        DEEP_READ_VERSION,
        eventId,
        inputs?.event.symbol ?? null,
        inputs?.event.event_date ?? null,
        inputs?.cutoffIso ?? null,
        (inputs?.articles ?? []).map((a) => a.id).sort((x, y) => x - y),
      ]);
    },

    async run(db, eventId, ctx) {
      try {
        const out = await run(db, eventId, { signal: ctx.signal });
        if (out.articlesRead === 0) return { status: "done", note: "no preview names the company yet" };
        return {
          status: "done",
          note: `${out.articlesRead} article(s) read${out.stored ? "" : ", nothing about this print"}`,
        };
      } catch (err) {
        return { status: "failed", error: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
      }
    },
  };
}

export const newsletterSynthesisStep = makeNewsletterSynthesisStep();
