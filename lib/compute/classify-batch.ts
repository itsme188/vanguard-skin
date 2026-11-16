/**
 * Shared batch runner for the AI classifiers (classify-securities fallback and
 * classify-factors). One model call per batch of up to `batchSize` securities;
 * a reply that is unparseable or parses to nothing usable is retried ONCE as
 * two half batches (a single-item batch retries itself). Hard failures
 * (network, refusal, DB) are NOT retried — they would just fail again.
 *
 * Origin: e5f002ef (auto-classify) — extracted here so classify-factors, which
 * had the same one-shot parse failure, shares the exact behaviour.
 */

import { AIRefusalError } from "@/lib/ai/generate";
import { parseJsonArrayLenient } from "@/lib/ai/extract-json";

/**
 * "The model answered but the answer is useless" (unparseable reply /
 * parsed-but-nothing-usable). Only this class earns the automatic retry.
 */
export class UnusableBatchReplyError extends Error {}

/**
 * The reply stopped at the output cap (finish reason "length"). A cut-off
 * reply is a failure even when its text happens to parse. It is an
 * UnusableBatchReplyError so a multi-item batch still splits (a smaller batch
 * fits the cap), but it is logged as a truncation, and a one-item batch is
 * never re-sent at the same cap (it would only be cut off again).
 */
export class TruncatedBatchReplyError extends UnusableBatchReplyError {}

export const CUT_OFF_MESSAGE = "reply cut off at the output cap";

/**
 * Throw TruncatedBatchReplyError when the helper reports the reply hit the
 * output cap. Call BEFORE parsing: a cut-off reply can still parse (a complete
 * first object, or a lenient slice), and must not be written.
 */
export function throwIfCutOff(finishReason: unknown): void {
  if (finishReason === "length") throw new TruncatedBatchReplyError(CUT_OFF_MESSAGE);
}

/**
 * Parse a model reply into an element list (fence-strip, whole-text parse,
 * first-`[`…last-`]` fallback, each with the C0-control-char retry — see
 * lib/ai/extract-json.ts). A failure becomes an UnusableBatchReplyError with
 * the SyntaxError as `cause`.
 */
export function parseBatchReply(text: string, label: string): unknown[] {
  try {
    return parseJsonArrayLenient(text, label);
  } catch (err) {
    throw new UnusableBatchReplyError(
      err instanceof Error ? err.message : `AI reply was not a JSON list of ${label}`,
      { cause: err },
    );
  }
}

/**
 * Run `runBatch` over `items` in batches of `batchSize`, retrying an unusable
 * reply once as two halves. `runBatch` returns the number of rows it
 * classified and throws UnusableBatchReplyError / AIRefusalError / anything.
 * Failures are appended to `errors` as `Batch N: …`. Returns the total
 * classified count.
 */
export async function runClassifyBatches<T>(
  items: T[],
  batchSize: number,
  runBatch: (batch: T[]) => Promise<number>,
  errors: string[],
): Promise<number> {
  let classified = 0;
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchNumber = i / batchSize + 1;
    try {
      classified += await runBatch(batch);
    } catch (err) {
      if (err instanceof AIRefusalError) {
        errors.push(`Batch ${batchNumber}: AI refusal`);
        continue;
      }
      if (!(err instanceof UnusableBatchReplyError)) {
        errors.push(`Batch ${batchNumber}: ${err instanceof Error ? err.message : "unknown"}`);
        continue;
      }

      // Retry ONCE (qa:analysis-classification--auto-classify-ai-batch-parse-
      // failure-no-retry-leaves-held-names-unclassified): split into two
      // half-size batches (smaller prompts are less likely to be truncated); a
      // batch already down to one security just retries itself. No retry of a
      // retry — each half records its own failure straight to `errors`.
      const truncated = err instanceof TruncatedBatchReplyError;
      if (truncated) {
        // Content-free: the batch number and size only.
        console.warn(
          `[classify] Batch ${batchNumber}: ${CUT_OFF_MESSAGE} (${batch.length} item${batch.length === 1 ? "" : "s"})` +
            (batch.length > 1 ? "; retrying as two half batches" : "; not re-sent at the same cap"),
        );
      }
      if (batch.length === 1) {
        if (truncated) {
          errors.push(`Batch ${batchNumber}: ${CUT_OFF_MESSAGE}`);
          continue;
        }
        try {
          classified += await runBatch(batch);
        } catch (retryErr) {
          if (retryErr instanceof AIRefusalError) {
            errors.push(`Batch ${batchNumber}: AI refusal`);
          } else {
            errors.push(`Batch ${batchNumber}: ${retryErr instanceof Error ? retryErr.message : "unknown"}`);
          }
        }
        continue;
      }

      const mid = Math.ceil(batch.length / 2);
      const halves = [batch.slice(0, mid), batch.slice(mid)];
      for (let h = 0; h < halves.length; h++) {
        try {
          classified += await runBatch(halves[h]);
        } catch (halfErr) {
          if (halfErr instanceof AIRefusalError) {
            errors.push(`Batch ${batchNumber}: AI refusal`);
          } else {
            errors.push(
              `Batch ${batchNumber}: ${halfErr instanceof Error ? halfErr.message : "unknown"} (retry, part ${h + 1} of 2)`,
            );
          }
        }
      }
    }
  }
  return classified;
}
