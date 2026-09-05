import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getPrintById } from "@/lib/print-watch/store";
import { evaluateRecapNudge } from "@/lib/earnings/recap-nudge-gate";
import { sendEarningsCandidate, type SendOutcome } from "@/lib/earnings/send-service";
import { DELIVERY_UNKNOWN, IN_PROGRESS } from "@/lib/earnings/email-states";

export const dynamic = "force-dynamic";

/**
 * The desk-facing answer to one press of "send recap now"
 * (docs/superpowers/plans/2026-09-04-live-print-v2-outputs-contract.md §3).
 *
 * BINDING CROSS-SLICE CONTRACT: slice F renders `outcome` and `reason`
 * VERBATIM, so this union is the user interface and nothing may be added to it
 * without changing the contract on both sides.
 *
 * It is a PROJECTION of the send service's `SendOutcome`, not the same type
 * (session finding E-S7). Three fields stop here:
 *   - `refused.status` / `failed.status` — an HTTP code for the LEGACY manual
 *     route to re-raise; this route answers 200 for every one of these, so a
 *     status alongside it would only invite F to treat an answer as an error.
 *   - `sent.symbol` — F already knows the symbol; it is the row it pressed on.
 *   - `sent.modelOutputChars` — a composer diagnostic, not desk information.
 * `delivery_unknown.note` is KEPT: it says WHY the delivery is unknown (a
 * timeout, an ambiguous provider failure during DATA, a post-accept
 * persistence failure, or a reaper flip), and that sentence is the only thing
 * that tells the desk whether to go and look in the mailbox.
 *
 * The two state words are written as `typeof <const>` rather than retyped, so
 * this file spells no `earnings_emails.error` sentinel by hand — the
 * vocabulary lives in lib/earnings/email-states.ts and
 * tests/repo/no-handrolled-email-states.test.ts enforces it (the same
 * precedent lib/earnings/send-service.ts sets). The resolved union is
 * byte-identical to the contract's.
 */
export type SendRecapOutcome =
  | { outcome: "sent"; sentTo: string; providerMessageId: string; title: string }
  | { outcome: typeof IN_PROGRESS }
  | { outcome: "already_sent"; sentAt: string; sentBy: "local" | "cloud" }
  | {
      outcome: typeof DELIVERY_UNKNOWN;
      providerMessageId: string | null;
      since: string;
      note?: string;
    }
  | { outcome: "refused"; reason: string }
  | { outcome: "failed"; reason: string };

/**
 * Service outcome -> DTO. Written as an exhaustive switch on purpose: the
 * compiler, not a reviewer, is what notices when the service grows a seventh
 * ending that this projection has not decided how to show.
 */
function projectOutcome(res: SendOutcome): SendRecapOutcome {
  switch (res.outcome) {
    case "sent":
      return {
        outcome: res.outcome,
        sentTo: res.sentTo,
        providerMessageId: res.providerMessageId,
        title: res.title,
      };
    case IN_PROGRESS:
      return { outcome: res.outcome };
    case "already_sent":
      return { outcome: res.outcome, sentAt: res.sentAt, sentBy: res.sentBy };
    case DELIVERY_UNKNOWN:
      // `note` is optional on both sides; JSON.stringify drops an undefined
      // value, so a service outcome without one serialises without the key.
      return {
        outcome: res.outcome,
        providerMessageId: res.providerMessageId,
        since: res.since,
        note: res.note,
      };
    case "refused":
    case "failed":
      return { outcome: res.outcome, reason: res.reason };
  }
}

/**
 * POST /api/print-watch/send-recap { printId } — the desk's "send recap now".
 *
 * EVERY coordination outcome is a 200 whose `data.outcome` and `data.reason`
 * slice F renders verbatim (contract §3): a refusal is not an HTTP error, it
 * is an answer. 400 is a malformed body, 404 an unknown print, 500 only an
 * unexpected exception. Nothing the desk can act on arrives as a status code
 * it cannot read.
 *
 * `nudge` mode never refires: a recap that already went out comes back as
 * already-sent, and one that ended without a provider answer comes back as
 * delivery-unknown. Resending either is a human decision made through
 * POST /api/earnings/email, never a second press of this button.
 *
 * No mute check and no recipient allowlist check (M-E17): the body carries no
 * recipient, so this can only ever reach BRIEFING_EMAIL_TO, and the desk
 * pressing the button IS the decision. `shouldSendEarningsEmail` and
 * `checkRecipientAllowed` guard the AUTOMATIC roads; an explicit press is not
 * one of them.
 *
 * Thin by design: the gate is `lib/earnings/recap-nudge-gate.ts` and every
 * claim, marker and provider rule is `lib/earnings/send-service.ts`. This file
 * parses a body, asks two questions and shapes an answer.
 *
 * `human` route by the proxy's DEFAULT classification (session + CSRF +
 * trusted Origin on unsafe methods) — no lib/auth/route-policy.ts entry, and
 * none is wanted.
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as { printId?: unknown } | null;
    if (
      typeof body !== "object" ||
      body === null ||
      typeof body.printId !== "number" ||
      !Number.isInteger(body.printId)
    ) {
      return NextResponse.json(
        { success: false, error: "Body field 'printId' must be an integer." },
        { status: 400 },
      );
    }
    const printId = body.printId;

    if (!getPrintById(db, printId)) {
      return NextResponse.json({ success: false, error: `No print ${printId}.` }, { status: 404 });
    }

    const gate = evaluateRecapNudge(db, printId);
    if (!gate.ok) {
      return NextResponse.json({
        success: true,
        data: { outcome: "refused", reason: gate.reason } satisfies SendRecapOutcome,
      });
    }

    const res = await sendEarningsCandidate(
      db,
      { eventId: gate.eventId, symbol: gate.symbol, phase: "recap" },
      { mode: "nudge" },
    );

    return NextResponse.json({ success: true, data: projectOutcome(res) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
