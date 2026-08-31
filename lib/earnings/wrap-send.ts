/**
 * RETIRED from the sweep 2026-08-02 — the EOD wrap was replaced by the 7:45
 * ET morning debrief (lib/earnings/debrief-send.ts). The Worker's wrap-send
 * fallback is ALSO retired (2026-08-02 evening, suppress-but-never-send —
 * heavy-night names roll into the next Mac debrief instead of a cloud
 * staple). Kept: the Worker still mirrors the wrap constants + slot
 * classifier for cluster SUPPRESSION (parity-pinned via
 * workers/cron/test/wrap-parity.test.ts); delete only together with that.
 *
 * EOD earnings-wrap SEND (#17 Task 2) — the action half of the wrap feature
 * whose pure cluster decisions live in lib/earnings/wrap.ts.
 *
 * `runWrapPass` evaluates both slots (BMO, AMC) for today's ET date. A slot in
 * WRAP MODE (expected-unsent recap count ≥ WRAP_THRESHOLD) that is ready to
 * fire — all members ready, OR the slot deadline passed with ≥1 ready — is
 * collapsed into ONE stapled email instead of N individual recaps.
 *
 * Claim choreography (the load-bearing part): claim EVERY ready member BEFORE
 * composing anything. A single live claim conflict aborts the whole tick and
 * releases the fresh claims already taken (retry next tick) — never a partial
 * send that leaves siblings stranded. A "refire" claim (the slot already has a
 * COMPLETED row — a concurrent process finished that member's individual
 * recap between cluster-build and claim) is NOT a conflict: that member is
 * simply already delivered, so `claimReadyMembers` drops it silently rather
 * than stapling + re-sending it (#17 T2 review Finding 1). After compose, ONE
 * email goes out; each successfully-composed member then gets its own
 * completed audit row + mac-sent marker. A member whose compose fails renders
 * its scoreboard + a retry note in place, releases its claim, and writes NO
 * audit row so its individual recap fires later. A send failure releases all
 * fresh claims and returns zeros — the sweep must never fail on our account.
 * The whole compose-through-send region also carries an outer claim-leak
 * catch (#17 T2 review Finding 2): any unexpected throw there (not just a
 * failed `sendEmail`) releases every fresh claim and no-ops rather than
 * leaking claims into the 30-min 'in_progress' blackout.
 *
 * Spec: docs/superpowers/specs/2026-07-16-eod-earnings-wrap-design.md
 */

import type Database from "better-sqlite3";
import {
  getExpectedRecapCluster,
  slotDeadlinePassed,
  WRAP_THRESHOLD,
  type WrapSlot,
  type WrapClusterMember,
} from "@/lib/earnings/wrap";
import {
  composeEarningsEmail,
  claimEarningsEmailSlot,
  releaseEarningsEmailClaim,
  renderHeadlineTable,
  EarningsEmailError,
} from "@/lib/digest/send-earnings-email";
import { sendEmail } from "@/lib/email";
import { withClusterManualActuals } from "@/lib/queries/manual-actuals-cluster";
import { briefingToHtml } from "@/lib/calendar/briefing-html";
import {
  checkEarningsCloudMarker,
  setEarningsRunningMarker,
  clearEarningsRunningMarker,
  writeMacSentEarningsMarker,
} from "@/lib/cron/earnings-marker-check";
import { todayET } from "@/lib/calendar/date-utils";
import type { CalendarEvent } from "@/lib/types";

const SLOTS: WrapSlot[] = ["BMO", "AMC"];

export interface WrapPassResult {
  /** Number of wrap emails actually sent this pass (0–2, one per slot). */
  wrapsSent: number;
  /** Names successfully composed + stapled + audited across those emails. */
  wrapped: number;
  /** Symbols not sent because actuals hadn't landed by the deadline. */
  stillWaiting: string[];
}

/**
 * Evaluate both slots for today (ET) and fire wrap emails where due. Called by
 * the sweep (Task 3) AFTER its per-candidate loop.
 */
export async function runWrapPass(
  db: Database.Database,
  opts: { now?: Date; recipient?: string } = {},
): Promise<WrapPassResult> {
  const now = opts.now ?? new Date();
  const date = todayET(now);
  const recipient = opts.recipient || process.env.BRIEFING_EMAIL_TO;
  if (!recipient) {
    throw new EarningsEmailError(
      "No recipient. Set BRIEFING_EMAIL_TO env var or pass 'recipient'.",
      400,
    );
  }

  const result: WrapPassResult = { wrapsSent: 0, wrapped: 0, stillWaiting: [] };
  for (const slot of SLOTS) {
    const slotResult = await runSlotWrap(db, date, slot, now, recipient);
    result.wrapsSent += slotResult.wrapsSent;
    result.wrapped += slotResult.wrapped;
    result.stillWaiting.push(...slotResult.stillWaiting);
  }
  return result;
}

interface Claimed {
  member: WrapClusterMember;
  mode: "fresh" | "refire";
  token?: string;
}

interface Section {
  member: WrapClusterMember;
  scoreboard: string;
  /** null ⇒ compose failed for this member. */
  aiMarkdown: string | null;
  promptHash: string | null;
}

export interface ClaimReadyMembersResult {
  /** Fresh claims taken — ready to compose + staple + send. */
  claims: Claimed[];
  /**
   * Event ids whose recap was ALREADY completed by a concurrent process
   * between cluster-build and claim (`claimEarningsEmailSlot` returned mode
   * "refire" — a completed row exists, not a live 'in_progress' conflict). No
   * token was issued for these, so there's nothing to release; the caller
   * must drop them silently: never composed, never stapled, never counted in
   * `wrapped`, never re-audited.
   */
  delivered: number[];
}

/**
 * Claim EVERY ready member's recap slot BEFORE composing anything.
 *
 * A live claim conflict ('in_progress' held by another process, not stale
 * enough to take over) aborts the whole batch: every claim taken so far in
 * this call is released and an empty result is returned so the caller
 * no-ops the whole tick (next tick retries everyone, including the members
 * that claimed fine here).
 *
 * A "refire" claim means the slot already has a COMPLETED row — the
 * member's individual recap was sent by a concurrent process sometime
 * between the cluster being built and this claim attempt. That is NOT a
 * conflict and must NOT abort the batch; it just means this member is
 * already delivered, so it goes into `delivered` instead of `claims` and is
 * never touched again by the wrap.
 */
export function claimReadyMembers(
  db: Database.Database,
  ready: WrapClusterMember[],
  recipient: string,
): ClaimReadyMembersResult {
  const claims: Claimed[] = [];
  const delivered: number[] = [];
  for (const m of ready) {
    const claim = claimEarningsEmailSlot(db, m.eventId, "recap", recipient);
    if (!claim.claimed) {
      releaseFreshClaims(db, claims);
      return { claims: [], delivered: [] };
    }
    if (claim.mode === "refire") {
      delivered.push(m.eventId);
      continue;
    }
    claims.push({ member: m, mode: claim.mode, token: claim.token });
  }
  return { claims, delivered };
}

async function runSlotWrap(
  db: Database.Database,
  date: string,
  slot: WrapSlot,
  now: Date,
  recipient: string,
): Promise<WrapPassResult> {
  const noop = (stillWaiting: string[] = []): WrapPassResult => ({
    wrapsSent: 0,
    wrapped: 0,
    stillWaiting,
  });

  // Wrap MODE is keyed on the full expected cluster (Task 1) — below threshold
  // there is nothing to collapse.
  const cluster = getExpectedRecapCluster(db, date, slot);
  if (cluster.length < WRAP_THRESHOLD) return noop();

  // Per-member cloud-sent exclusion: a Worker (or already-Mac) delivery that
  // hasn't been reconciled into a local audit row yet should not be re-stapled.
  // (Recording the sent-by-cloud audit row is the sweep's job — here we just
  // drop the member.)
  const members: WrapClusterMember[] = [];
  for (const m of cluster) {
    const status = await checkEarningsCloudMarker("recap", m.eventId);
    if (status?.sentBy != null) continue;
    members.push(m);
  }

  const byRelease = (a: WrapClusterMember, b: WrapClusterMember) =>
    (a.releaseTime ?? "99:99").localeCompare(b.releaseTime ?? "99:99") ||
    a.symbol.localeCompare(b.symbol);

  const ready = members.filter((m) => m.ready).sort(byRelease);
  const notReady = members.filter((m) => !m.ready).sort(byRelease);
  const stillWaiting = notReady.map((m) => m.symbol);

  // Fire when all members are ready, OR the deadline has passed and at least
  // one is ready (never an empty email). Otherwise keep waiting.
  const shouldSend =
    ready.length >= 1 && (notReady.length === 0 || slotDeadlinePassed(slot, now));
  if (!shouldSend) return noop(stillWaiting);

  // ── Claim ALL ready members BEFORE composing. A live conflict aborts the
  //    whole tick; a "refire" claim (already delivered by a concurrent
  //    process) is dropped silently rather than re-staple/re-sent (#17 T2
  //    review Finding 1).
  const { claims } = claimReadyMembers(db, ready, recipient);
  if (claims.length === 0) return noop(stillWaiting);

  // Best-effort running markers so the Worker fallback backs off mid-fire.
  await Promise.all(
    claims.map((c) =>
      setEarningsRunningMarker("recap", c.member.eventId).catch(() => null),
    ),
  );

  try {
    let sections: Section[] = [];

    // ── Compose-through-send: an outer claim-leak catch (#17 T2 review
    //    Finding 2). getEventRow / renderHeadlineTable / briefingToHtml (or
    //    anything else unexpected before the email is actually sent) must
    //    never leak the fresh claims taken above into the 30-min
    //    'in_progress' blackout — the never-throws contract. The inner
    //    send-failure catch below has distinct semantics (a successful
    //    compose followed by an SMTP failure) and is kept as-is, nested
    //    inside this one.
    try {
      // ── Compose each. A per-member compose failure renders the scoreboard +
      //    a retry note in place, releases that member's claim, writes no
      //    audit row.
      for (const c of claims) {
        const event = getEventRow(db, c.member.eventId);
        const scoreboard = event
          ? renderHeadlineTable(event, c.member.symbol, "recap")
          : "";
        try {
          const composed = await composeEarningsEmail(db, c.member.eventId, "recap");
          sections.push({
            member: c.member,
            scoreboard,
            aiMarkdown: composed.aiMarkdown,
            promptHash: composed.promptHash,
          });
        } catch (err) {
          console.warn(
            `[wrap] compose failed for event ${c.member.eventId} (${c.member.symbol}); its individual recap will retry:`,
            err instanceof Error ? err.message : err,
          );
          if (c.mode === "fresh" && c.token) {
            releaseEarningsEmailClaim(db, c.member.eventId, "recap", c.token);
          }
          sections.push({ member: c.member, scoreboard, aiMarkdown: null, promptHash: null });
        }
      }

      // ── Staple: combined scoreboard index, then a `# {SYM}` section per name.
      const scoreboardIndex = sections
        .map((s) => s.scoreboard)
        .filter(Boolean)
        .join("\n\n");
      const bodyParts = sections.map((s) =>
        s.aiMarkdown != null
          ? `# ${s.member.symbol}\n\n${s.aiMarkdown}`
          : `# ${s.member.symbol}\n\n${s.scoreboard}\n\n*Compose failed — its individual recap will retry.*`,
      );
      const waitingLine =
        notReady.length > 0
          ? `\n\n*Still waiting on actuals: ${notReady.map((m) => m.symbol).join(", ")}*`
          : "";
      const stapledMarkdown = `${scoreboardIndex}\n\n${bodyParts.join("\n\n")}${waitingLine}`;

      const subject = `\u{1F4CA} Earnings wrap — ${slot} ${date} (${sections.length} names)`;
      const title = `Earnings wrap — ${slot} ${date}`;
      const html = briefingToHtml(stapledMarkdown, title);

      try {
        await sendEmail({ to: recipient, subject, html, fromLocalPart: "earnings" });
      } catch (err) {
        // The sweep must never fail on our account: release every fresh claim
        // still held (composed ones), write no audit rows, return zeros. The
        // next tick retries the whole wrap.
        releaseFreshClaims(db, claims);
        console.warn(
          `[wrap] send failed for ${slot} ${date}; released ${claims.length} claim(s):`,
          err instanceof Error ? err.message : err,
        );
        return noop(stillWaiting);
      }
    } catch (err) {
      // Outer claim-leak defense: an unexpected throw anywhere in
      // compose/staple/render before the send attempt above (the send's own
      // failure is handled by the inner catch and never reaches here) must
      // still release the fresh claims — this function must never throw.
      releaseFreshClaims(db, claims);
      console.warn(
        `[wrap] unexpected error building ${slot} ${date}; released ${claims.length} claim(s):`,
        err instanceof Error ? err.message : err,
      );
      return noop(stillWaiting);
    }

    // ── Post-send: one completed audit row + mac-sent marker per composed name.
    //    (Compose-failed members already released their claim above.)
    let wrapped = 0;
    for (const s of sections) {
      if (s.aiMarkdown == null) continue;
      recordWrapAudit(db, {
        eventId: s.member.eventId,
        recipient,
        aiInputHash: s.promptHash,
        aiOutputMd: s.aiMarkdown,
      });
      await writeMacSentEarningsMarker("recap", s.member.eventId).catch(() => null);
      wrapped += 1;
    }

    return { wrapsSent: 1, wrapped, stillWaiting };
  } finally {
    await Promise.all(
      claims.map((c) =>
        clearEarningsRunningMarker("recap", c.member.eventId).catch(() => null),
      ),
    );
  }
}

function releaseFreshClaims(db: Database.Database, claims: Claimed[]): void {
  for (const c of claims) {
    if (c.mode === "fresh" && c.token) {
      releaseEarningsEmailClaim(db, c.member.eventId, "recap", c.token);
    }
  }
}

function getEventRow(db: Database.Database, id: number): CalendarEvent | null {
  // Cluster-scoped acceptance stamp — the wrap scoreboard runs the
  // plausibility gate, and the stamp can sit on a superseded twin of this
  // same print (lib/queries/manual-actuals-cluster.ts).
  return withClusterManualActuals(
    db,
    db.prepare(`SELECT * FROM calendar_events WHERE id = ?`).get(id) as
      | CalendarEvent
      | undefined,
  );
}

// Same upsert shape as recordEarningsEmailAudit (module-private in
// send-earnings-email.ts): converts the 'in_progress' claim row into a
// completed row (error = NULL). UNIQUE(event_id, phase) makes it idempotent.
function recordWrapAudit(
  db: Database.Database,
  input: {
    eventId: number;
    recipient: string;
    aiInputHash: string | null;
    aiOutputMd: string;
  },
): void {
  db.prepare(
    `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, ai_input_hash, ai_output_md, error)
     VALUES (?, 'recap', ?, datetime('now'), ?, ?, NULL)
     ON CONFLICT(event_id, phase) DO UPDATE SET
       recipient = excluded.recipient,
       sent_at = excluded.sent_at,
       ai_input_hash = excluded.ai_input_hash,
       ai_output_md = excluded.ai_output_md,
       error = excluded.error`,
  ).run(input.eventId, input.recipient, input.aiInputHash, input.aiOutputMd);
}
