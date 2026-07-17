/**
 * Marker-deduped push-at-print sender — both Mac capture sites (enrichment
 * runner + cloud reconcile) call this. Best-effort everywhere: marker
 * check degrades to "not pushed" when the Worker is unreachable, and
 * sendPushover never throws.
 */

import { sendPushover } from "./notify-pushover";
import {
  composePrintPushMessage,
  type PrintPushReadThrough,
} from "./print-push-message";
import {
  checkPrintPushMarker,
  writePrintPushMarker,
} from "@/lib/cron/earnings-marker-check";

export async function sendEarningsPrintPush(input: {
  eventId: number;
  symbol: string;
  actualValue: string;
  consensusValue: string | null;
  reactionJson: string | null;
  /** Live read-through pairs for this reporter (#13) — rendered as
   *  `→ TARGET (status): hypothesis` lines by the composer. */
  readThroughs?: PrintPushReadThrough[];
  /** The push exists only because of the read-through (reporter not
   *  held/watchlisted) — flags the title. */
  readThroughOnly?: boolean;
}): Promise<{ pushed: boolean; reason?: string }> {
  const alreadyPushed = await checkPrintPushMarker(input.eventId);
  if (alreadyPushed) return { pushed: false, reason: "already_pushed" };

  const { title, message } = composePrintPushMessage(input);
  const result = await sendPushover({
    title,
    message,
    url: `${process.env.PUSHOVER_LINK_BASE ?? "http://localhost:3099"}/dashboard/today`,
    urlTitle: "Open Earnings Hub",
  });
  if (result.sent) void writePrintPushMarker(input.eventId);
  return result.sent
    ? { pushed: true }
    : { pushed: false, reason: result.reason ?? "pushover_failed" };
}
