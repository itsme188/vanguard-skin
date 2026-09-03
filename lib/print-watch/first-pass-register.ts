// Slice D's registration root: the merge handler (before B's — plan M-D12) and
// the durable reconcile timer (#16). Called from lib/print-watch/register.ts
// inside registerPrintWatch(), never at module top level (TDZ on the
// registry import cycle — see register.ts).
import type Database from "better-sqlite3";
import { registerEventMergeHandler } from "@/lib/earnings/event-merge";
import { mergeFirstPassState, FIRST_PASS_MERGE_HANDLER_NAME } from "./first-pass-merge";
import { armReconcileTimer } from "./read-scheduler";

let registered = false;
export function registerFirstPass(db?: Database.Database): void {
  if (registered) return;
  registered = true;
  registerEventMergeHandler(FIRST_PASS_MERGE_HANDLER_NAME, mergeFirstPassState);
  if (db) armReconcileTimer(db);
}
export function __resetFirstPassRegisterForTests(): void { registered = false; }
