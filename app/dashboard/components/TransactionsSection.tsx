"use client";

import { useMemo, useState } from "react";
import type { SecurityDetailTransaction } from "@/lib/queries/security-detail";
import { Money, Shares } from "@/lib/privacy/components";
import { resolveOptionFields } from "@/lib/format";
import { displayCashEffect } from "@/lib/format/cash-effect";
import { SortableHeader } from "./SortableHeader";
import { compareValues, useSortParam, type SortDir } from "@/lib/hooks/useSortParam";
import { Section } from "./Section";
import { Chip, type ChipTone } from "./Chip";

type SortField = "trade_date" | "type" | "account_name" | "quantity" | "price_per_share" | "amount";

type TypeScope = "all" | "stocks" | "options";

// Option transaction types — anything else is "stock/other".
const OPTION_TYPES = new Set([
  "BUY_TO_OPEN",
  "SELL_TO_OPEN",
  "BUY_TO_CLOSE",
  "SELL_TO_CLOSE",
]);

function isOptionTxn(t: SecurityDetailTransaction): boolean {
  if (t.option_type != null) return true;
  if ((t.security_type ?? "").toLowerCase() === "option") return true;
  return OPTION_TYPES.has(t.type);
}

/**
 * Sorts security-detail transaction rows for the Amount column consistently
 * with what the column PRINTS. The `amount` field is compared via
 * displayCashEffect(row.type, row.amount) — the same sign-normalization the
 * Amount cell renders through (see displayCashEffect in
 * lib/format/cash-effect.ts) — so a raw-positive legacy Vanguard BUY, which
 * displays as a negative outflow, sorts among the other negative-displayed
 * rows instead of among the raw-positive ones. Every other field sorts on
 * its raw column value, unchanged.
 */
export function sortSecurityTransactions(
  rows: SecurityDetailTransaction[],
  field: SortField | null,
  dir: SortDir,
): SecurityDetailTransaction[] {
  if (!field) return rows;
  return [...rows].sort((a, b) => {
    if (field === "amount") {
      return compareValues(
        displayCashEffect(a.type, a.amount),
        displayCashEffect(b.type, b.amount),
        dir,
      );
    }
    return compareValues(
      a[field as keyof SecurityDetailTransaction],
      b[field as keyof SecurityDetailTransaction],
      dir,
    );
  });
}

function typeTone(type: string): ChipTone {
  if (type.startsWith("BUY")) return "up";
  if (type.startsWith("SELL")) return "down";
  if (type === "DIVIDEND") return "gold";
  return "neutral";
}

const TD_CLASS = "px-4 py-2.5 text-sm text-ink border-b border-edge";
const TD_MONO = "px-4 py-2.5 text-sm text-ink font-mono tabular-nums border-b border-edge";

export function TransactionsSection({
  stockTransactions,
  optionTransactions,
}: {
  stockTransactions: SecurityDetailTransaction[];
  optionTransactions: SecurityDetailTransaction[];
}) {
  // Merge + stable sort by trade_date DESC.
  const all = useMemo(() => {
    const merged = [...stockTransactions, ...optionTransactions];
    return merged.sort((a, b) => (a.trade_date < b.trade_date ? 1 : -1));
  }, [stockTransactions, optionTransactions]);

  const accountOptions = useMemo(() => {
    const set = new Set<string>();
    for (const t of all) set.add(t.account_name);
    return Array.from(set).sort();
  }, [all]);

  const hasOptions = optionTransactions.length > 0;
  const [account, setAccount] = useState<string>("All");
  const [typeScope, setTypeScope] = useState<TypeScope>("all");
  const { sort, setSort } = useSortParam<SortField>("secTxns", "trade_date", "desc");

  const filtered = useMemo(() => {
    const base = all.filter((t) => {
      if (account !== "All" && t.account_name !== account) return false;
      if (typeScope === "stocks" && isOptionTxn(t)) return false;
      if (typeScope === "options" && !isOptionTxn(t)) return false;
      return true;
    });
    return sortSecurityTransactions(base, sort.field, sort.dir);
  }, [all, account, typeScope, sort]);

  if (all.length === 0) return null;

  // Hide filters entirely when there's nothing useful to filter on.
  const showAccountFilter = accountOptions.length > 1;
  const showTypeFilter = hasOptions;

  return (
    <Section
      title="Recent Transactions"
      action={
        <span className="text-xs font-mono text-ink-faint">
          {filtered.length} of {all.length}
        </span>
      }
    >
      {(showAccountFilter || showTypeFilter) && (
        <div className="px-5 py-3 border-b border-edge flex items-center gap-3 flex-wrap">
          {showAccountFilter && (
            <div className="flex gap-1 p-1 rounded-lg border border-edge bg-canvas">
              <FilterPill
                label="All accounts"
                active={account === "All"}
                onClick={() => setAccount("All")}
              />
              {accountOptions.map((a) => (
                <FilterPill
                  key={a}
                  label={a}
                  active={account === a}
                  onClick={() => setAccount(a)}
                />
              ))}
            </div>
          )}
          {showAccountFilter && showTypeFilter && (
            <span className="h-4 w-px bg-edge" aria-hidden />
          )}
          {showTypeFilter && (
            <div className="flex gap-1 p-1 rounded-lg border border-edge bg-canvas">
              <FilterPill
                label="All"
                active={typeScope === "all"}
                onClick={() => setTypeScope("all")}
              />
              <FilterPill
                label="Stocks"
                active={typeScope === "stocks"}
                onClick={() => setTypeScope("stocks")}
              />
              <FilterPill
                label={`Options (${optionTransactions.length})`}
                active={typeScope === "options"}
                onClick={() => setTypeScope("options")}
              />
            </div>
          )}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-raised">
            <tr>
              <SortableHeader field="trade_date" sort={sort} onSort={setSort}>
                Date
              </SortableHeader>
              <SortableHeader field="type" sort={sort} onSort={setSort}>
                Type
              </SortableHeader>
              <SortableHeader
                field="account_name"
                sort={sort}
                onSort={setSort}
                className="hidden md:table-cell"
              >
                Account
              </SortableHeader>
              <th className="px-4 py-2.5 text-left text-xs font-medium text-ink-faint">
                Security
              </th>
              <SortableHeader field="quantity" sort={sort} onSort={setSort} align="right">
                Qty
              </SortableHeader>
              <SortableHeader
                field="price_per_share"
                sort={sort}
                onSort={setSort}
                align="right"
                className="hidden md:table-cell"
              >
                Price
              </SortableHeader>
              <SortableHeader field="amount" sort={sort} onSort={setSort} align="right">
                Amount
              </SortableHeader>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-5 text-center text-xs uppercase tracking-wider text-ink-faint"
                >
                  No transactions match these filters
                </td>
              </tr>
            ) : (
              filtered.map((t) => {
                const isOpt = isOptionTxn(t);
                return (
                  <tr key={t.id}>
                    <td className={`${TD_MONO} text-ink-dim`}>{t.trade_date}</td>
                    <td className={TD_CLASS}>
                      <Chip tone={typeTone(t.type)} size="xs" uppercase>
                        {t.type}
                      </Chip>
                    </td>
                    <td className={`${TD_CLASS} hidden md:table-cell text-ink-dim`}>
                      {t.account_name}
                    </td>
                    <td className={TD_CLASS}>
                      {isOpt ? (
                        <OptionLabel txn={t} />
                      ) : (
                        <span className="text-ink-faint">—</span>
                      )}
                    </td>
                    <td className={`${TD_MONO} text-right`}>
                      <Shares value={t.quantity} fallback="–" />
                    </td>
                    <td className={`${TD_MONO} text-right text-ink-dim hidden md:table-cell`}>
                      <Money value={t.price_per_share} precise fallback="–" />
                    </td>
                    <td className={`${TD_MONO} text-right whitespace-nowrap`}>
                      <Money value={displayCashEffect(t.type, t.amount)} fallback="–" />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function FilterPill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 text-[11px] rounded transition-colors ${
        active
          ? "bg-gold/20 text-gold-ink font-medium"
          : "text-ink-faint hover:text-ink hover:bg-raised"
      }`}
    >
      {label}
    </button>
  );
}

function OptionLabel({ txn }: { txn: SecurityDetailTransaction }) {
  // Unenriched option securities carry NULL option_type/strike/expiration, so
  // these rows used to print the raw OCC string beside neighbours rendering
  // the compact chip form. resolveOptionFields parses the identity back out of
  // the symbol in exactly that case (QA security-detail-transactions--raw-occ-
  // fallback-beside-formatted-option-rows).
  const { optionType: type, strike, expiration: exp } = resolveOptionFields(
    txn.symbol,
    txn.option_type,
    txn.strike_price,
    txn.expiration_date,
  );
  const hasStructured = type != null || strike != null || exp != null;

  if (!hasStructured) {
    return (
      <span className="font-mono text-sm text-ink-dim">
        {txn.symbol?.replace(/\s+/g, " ").trim() ?? "—"}
      </span>
    );
  }

  const tone: ChipTone = type === "CALL" ? "up" : type === "PUT" ? "down" : "neutral";
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {type && (
        <Chip tone={tone} size="xs" uppercase>
          {type}
        </Chip>
      )}
      <span className="font-mono text-sm text-ink-dim">
        {strike != null && `$${strike}`}
        {strike != null && exp && " · "}
        {exp && exp}
      </span>
    </div>
  );
}
