"use client";

import { useMemo, useState } from "react";
import type { SecurityDetailTransaction } from "@/lib/queries/security-detail";
import { Money, Shares } from "@/lib/privacy/components";
import { Chip } from "./Chip";

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

function typeToneOf(type: string): "up" | "down" | "gold" | "neutral" {
  if (type.startsWith("BUY")) return "up";
  if (type.startsWith("SELL")) return "down";
  if (type === "DIVIDEND") return "gold";
  return "neutral";
}

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

  const filtered = useMemo(() => {
    return all.filter((t) => {
      if (account !== "All" && t.account_name !== account) return false;
      if (typeScope === "stocks" && isOptionTxn(t)) return false;
      if (typeScope === "options" && !isOptionTxn(t)) return false;
      return true;
    });
  }, [all, account, typeScope]);

  if (all.length === 0) return null;

  // Hide filters entirely when there's nothing useful to filter on —
  // keeps single-account, stock-only pages visually quiet.
  const showAccountFilter = accountOptions.length > 1;
  const showTypeFilter = hasOptions;

  return (
    <section className="rounded-xl border border-edge bg-panel overflow-hidden">
      <div className="px-5 py-3 border-b border-edge flex items-center justify-between flex-wrap gap-3">
        <h2 className="text-sm font-semibold text-ink">Recent Transactions</h2>
        <span className="text-[11px] text-ink-faint">
          {filtered.length} of {all.length}
        </span>
      </div>

      {(showAccountFilter || showTypeFilter) && (
        <div className="px-5 py-2.5 border-b border-edge/50 flex items-center gap-3 flex-wrap">
          {showAccountFilter && (
            <div className="flex items-center gap-1 flex-wrap">
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
            <div className="flex items-center gap-1">
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
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-edge text-ink-faint text-xs">
              <th className="text-left px-5 py-2 font-medium">Date</th>
              <th className="text-left px-5 py-2 font-medium">Type</th>
              <th className="hidden md:table-cell text-left px-5 py-2 font-medium">Account</th>
              <th className="text-left px-5 py-2 font-medium">Security</th>
              <th className="text-right px-5 py-2 font-medium">Qty</th>
              <th className="hidden md:table-cell text-right px-5 py-2 font-medium">Price</th>
              <th className="text-right px-5 py-2 font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-5 py-6 text-center text-[11px] text-ink-faint italic"
                >
                  No transactions match these filters.
                </td>
              </tr>
            ) : (
              filtered.map((t) => {
                const isOpt = isOptionTxn(t);
                return (
                  <tr key={t.id} className="border-b border-edge/50 last:border-0">
                    <td className="px-5 py-2.5 font-mono text-ink-dim text-xs">
                      {t.trade_date}
                    </td>
                    <td className="px-5 py-2.5">
                      <Chip tone={typeToneOf(t.type)}>{t.type}</Chip>
                    </td>
                    <td className="hidden md:table-cell px-5 py-2.5 text-ink-dim">
                      {t.account_name}
                    </td>
                    <td className="px-5 py-2.5">
                      {isOpt ? (
                        <OptionLabel txn={t} />
                      ) : (
                        <span className="text-ink-dim">—</span>
                      )}
                    </td>
                    <td className="px-5 py-2.5 text-right font-mono text-ink">
                      <Shares value={t.quantity} fallback="–" />
                    </td>
                    <td className="hidden md:table-cell px-5 py-2.5 text-right font-mono text-ink-dim">
                      <Money value={t.price_per_share} precise fallback="–" />
                    </td>
                    <td className="px-5 py-2.5 text-right font-mono text-ink">
                      <Money value={t.amount} fallback="–" />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
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
      className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors ${
        active
          ? "bg-gold/20 text-gold"
          : "bg-raised text-ink-dim hover:text-ink"
      }`}
    >
      {label}
    </button>
  );
}

function OptionLabel({ txn }: { txn: SecurityDetailTransaction }) {
  const type = txn.option_type;
  const tone = type === "CALL" ? "up" : type === "PUT" ? "down" : "neutral";
  const strike = txn.strike_price;
  const exp = txn.expiration_date;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {type && (
        <Chip tone={tone} size="xs" uppercase>
          {type}
        </Chip>
      )}
      <span className="text-[11px] font-mono text-ink-dim">
        {strike != null && `$${strike}`}
        {strike != null && exp && " · "}
        {exp && exp}
      </span>
    </div>
  );
}
