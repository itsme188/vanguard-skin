"use client";

import { useMemo, useState } from "react";
import type { SecurityDetailTransaction } from "@/lib/queries/security-detail";
import { Money, Shares } from "@/lib/privacy/components";
import { SortableHeader } from "./SortableHeader";
import { compareValues, useSortParam } from "@/lib/hooks/useSortParam";
import { TerminalSection, TerminalTD, TerminalTag } from "./TerminalSection";

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

/** Terminal-aesthetic color per transaction type. */
function typeColorOf(type: string): string {
  if (type.startsWith("BUY")) return "#22c55e";
  if (type.startsWith("SELL")) return "#ef4444";
  if (type === "DIVIDEND") return "#ffb84d";
  return "#888";
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
  const { sort, setSort } = useSortParam<SortField>("secTxns", "trade_date", "desc");

  const filtered = useMemo(() => {
    const base = all.filter((t) => {
      if (account !== "All" && t.account_name !== account) return false;
      if (typeScope === "stocks" && isOptionTxn(t)) return false;
      if (typeScope === "options" && !isOptionTxn(t)) return false;
      return true;
    });
    if (!sort.field) return base;
    const field = sort.field;
    return [...base].sort((a, b) =>
      compareValues(
        a[field as keyof SecurityDetailTransaction],
        b[field as keyof SecurityDetailTransaction],
        sort.dir,
      ),
    );
  }, [all, account, typeScope, sort]);

  if (all.length === 0) return null;

  // Hide filters entirely when there's nothing useful to filter on —
  // keeps single-account, stock-only pages visually quiet.
  const showAccountFilter = accountOptions.length > 1;
  const showTypeFilter = hasOptions;

  return (
    <TerminalSection
      title="Recent Transactions"
      action={
        <span
          style={{
            fontFamily: "var(--font-mono), monospace",
            fontSize: "11px",
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: "#666",
          }}
        >
          {filtered.length} of {all.length}
        </span>
      }
    >

      {(showAccountFilter || showTypeFilter) && (
        <div
          style={{
            padding: "10px 20px",
            borderBottom: "1px solid #1f1f1f",
            display: "flex",
            alignItems: "center",
            gap: "12px",
            flexWrap: "wrap",
          }}
        >
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
            <span style={{ height: "16px", width: "1px", background: "#333" }} aria-hidden />
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
        <table className="w-full" style={{ borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <SortableHeader field="trade_date" sort={sort} onSort={setSort} variant="terminal">
                Date
              </SortableHeader>
              <SortableHeader field="type" sort={sort} onSort={setSort} variant="terminal">
                Type
              </SortableHeader>
              <SortableHeader
                field="account_name"
                sort={sort}
                onSort={setSort}
                className="hidden md:table-cell"
                variant="terminal"
              >
                Account
              </SortableHeader>
              <th
                className="text-left"
                style={{
                  padding: "10px 20px",
                  background: "#0a0a0a",
                  borderBottom: "1px solid #1f1f1f",
                  fontFamily: "var(--font-mono), monospace",
                  fontSize: "11px",
                  letterSpacing: "0.18em",
                  textTransform: "uppercase",
                  color: "#888",
                  fontWeight: 400,
                }}
              >
                Security
              </th>
              <SortableHeader field="quantity" sort={sort} onSort={setSort} align="right" variant="terminal">
                Qty
              </SortableHeader>
              <SortableHeader
                field="price_per_share"
                sort={sort}
                onSort={setSort}
                align="right"
                className="hidden md:table-cell"
                variant="terminal"
              >
                Price
              </SortableHeader>
              <SortableHeader field="amount" sort={sort} onSort={setSort} align="right" variant="terminal">
                Amount
              </SortableHeader>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  style={{
                    padding: "20px",
                    textAlign: "center",
                    fontFamily: "var(--font-mono), monospace",
                    fontSize: "12px",
                    letterSpacing: "0.18em",
                    textTransform: "uppercase",
                    color: "#555",
                  }}
                >
                  No transactions match these filters
                </td>
              </tr>
            ) : (
              filtered.map((t) => {
                const isOpt = isOptionTxn(t);
                return (
                  <tr key={t.id}>
                    <TerminalTD mono color="#888">{t.trade_date}</TerminalTD>
                    <TerminalTD>
                      <TerminalTag color={typeColorOf(t.type)} size="xs">
                        {t.type}
                      </TerminalTag>
                    </TerminalTD>
                    <TerminalTD className="hidden md:table-cell" color="#aaa">
                      {t.account_name}
                    </TerminalTD>
                    <TerminalTD>
                      {isOpt ? (
                        <OptionLabel txn={t} />
                      ) : (
                        <span style={{ color: "#555" }}>—</span>
                      )}
                    </TerminalTD>
                    <TerminalTD align="right" mono>
                      <Shares value={t.quantity} fallback="–" />
                    </TerminalTD>
                    <TerminalTD align="right" mono color="#888" className="hidden md:table-cell">
                      <Money value={t.price_per_share} precise fallback="–" />
                    </TerminalTD>
                    <TerminalTD align="right" mono>
                      <Money value={t.amount} fallback="–" />
                    </TerminalTD>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </TerminalSection>
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
      style={{
        padding: "4px 10px",
        background: active ? "rgba(255, 184, 77, 0.1)" : "transparent",
        border: `1px solid ${active ? "#ffb84d" : "#333"}`,
        color: active ? "#ffb84d" : "#888",
        fontFamily: "var(--font-mono), monospace",
        fontSize: "11px",
        fontWeight: 600,
        letterSpacing: "0.16em",
        textTransform: "uppercase",
        borderRadius: "2px",
        cursor: "pointer",
        transition: "all 180ms ease",
      }}
      onMouseEnter={(e) => {
        if (!active) {
          e.currentTarget.style.color = "#ddd";
          e.currentTarget.style.borderColor = "#555";
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          e.currentTarget.style.color = "#888";
          e.currentTarget.style.borderColor = "#333";
        }
      }}
    >
      {label}
    </button>
  );
}

function OptionLabel({ txn }: { txn: SecurityDetailTransaction }) {
  const type = txn.option_type;
  const strike = txn.strike_price;
  const exp = txn.expiration_date;
  const hasStructured = type != null || strike != null || exp != null;

  if (!hasStructured) {
    return (
      <span style={{ fontFamily: "var(--font-mono), monospace", fontSize: "13px", color: "#888" }}>
        {txn.symbol?.replace(/\s+/g, " ").trim() ?? "—"}
      </span>
    );
  }

  const color = type === "CALL" ? "#22c55e" : type === "PUT" ? "#ef4444" : "#888";
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {type && (
        <TerminalTag color={color} size="xs">
          {type}
        </TerminalTag>
      )}
      <span style={{ fontFamily: "var(--font-mono), monospace", fontSize: "13px", color: "#aaa" }}>
        {strike != null && `$${strike}`}
        {strike != null && exp && " · "}
        {exp && exp}
      </span>
    </div>
  );
}
