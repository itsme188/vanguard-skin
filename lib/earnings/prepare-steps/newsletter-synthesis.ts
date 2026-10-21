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
 * or parse failure -> `failed` (an attempt; the runner caps at five). A read
 * that could not fetch some of its images stores the text reading and is also
 * `failed`, so it is retried within that same cap (2026-10-21).
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
        // An article with images the read can fetch is keyed with a marker, so
        // the read re-runs once for an event whose previews carry pictures
        // (2026-10-21) while every text-only event keeps its fingerprint.
        [...(inputs?.articles ?? [])]
          .sort((x, y) => x.id - y.id)
          .map((a) => (a.imageUrls.length > 0 ? `${a.id}:img${a.imageUrls.length}` : a.id)),
      ]);
    },

    async run(db, eventId, ctx) {
      try {
        const out = await run(db, eventId, { signal: ctx.signal });
        if (out.articlesRead === 0) return { status: "done", note: "no preview names the company yet" };
        const read = out.imagesRead ?? 0;
        const unreadable = out.imagesUnreadable ?? 0;
        if (unreadable > 0) {
          // The text reading is stored, but a bogey screenshot may be among the
          // pictures it missed, so the read is not final. `failed` (one of the
          // runner's capped attempts), not `pending`: a pending step costs no
          // attempt and would re-run a frontier call every tick for a picture
          // that is gone for good.
          return {
            status: "failed",
            error: `${unreadable} image(s) unreadable; read ${out.articlesRead} article(s) without them, will retry`,
          };
        }
        const images =
          read > 0 || unreadable > 0 ? `, ${read} image(s)${unreadable > 0 ? ` (${unreadable} unreadable)` : ""}` : "";
        return {
          status: "done",
          note: `${out.articlesRead} article(s) read${images}${out.stored ? "" : ", nothing about this print"}`,
        };
      } catch (err) {
        return { status: "failed", error: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
      }
    },
  };
}

export const newsletterSynthesisStep = makeNewsletterSynthesisStep();
