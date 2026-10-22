/**
 * The filing summary's registration root. Called from `registerPrintWatch()`
 * (lib/print-watch/register.ts) after the first-pass registration, never at
 * module top level: the registry import cycle
 * event-merge -> registry-bootstrap -> print-watch/register -> here would touch
 * the merge registry in its temporal dead zone (see print-watch/register.ts).
 *
 * The merge handler is registered once per process (latched, like
 * `registerFirstPass`). The tick is started whenever a db is passed; that
 * start is itself idempotent, so a first call without a db (the earnings
 * bootstrap) does not stop a later call with one from starting it.
 */
import type Database from "better-sqlite3";
import { registerEventMergeHandler } from "@/lib/earnings/event-merge";
import { FILING_SUMMARY_MERGE_HANDLER_NAME, mergeFilingSummaryState } from "./merge";
import { startFilingSummaryTick } from "./tick";

let registered = false;

export function registerFilingSummary(db?: Database.Database): void {
  if (!registered) {
    registered = true;
    registerEventMergeHandler(FILING_SUMMARY_MERGE_HANDLER_NAME, mergeFilingSummaryState);
  }
  if (db) startFilingSummaryTick(db);
}

export function __resetFilingSummaryRegisterForTests(): void {
  registered = false;
}
