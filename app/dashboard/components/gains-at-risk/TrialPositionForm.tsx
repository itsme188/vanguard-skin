"use client";

import { useEffect, useReducer, useRef, useState, type KeyboardEvent } from "react";
import apiFetch from "@/lib/http/apiFetch";
import { readMutationResult, networkFailureMessage } from "@/lib/ui/mutation-result";
import { PrivateNumberInput } from "@/lib/privacy/components";
import { formatPositionsDate } from "@/lib/ui/positions-freshness-label";
import { TRIAL_POSITION_BOUNDS } from "@/lib/analysis/gains-at-risk-constants";
import {
  optionQuoteRefusalSentence,
  trialSecurityRefusalSentence,
  type EnsureBarsResponse,
  type OptionQuoteResponse,
  type TrialEntryResponse,
  type TrialLookup,
} from "@/lib/analysis/gains-at-risk-input";
import {
  TRIAL_CONNECT_FOR_QUOTES,
  TRIAL_MULTIPLIER_NOTE,
  TRIAL_STRIKES_NOTE,
  addBlockedBy,
  applyTrialEdit,
  barsStep,
  chainFieldState,
  lookupBarsLine,
  trialSymbolKey,
  draftFromTrial,
  emptyTrialDraft,
  formatMarketPrice,
  formatStrike,
  initialTrialFormState,
  isCurrentTrialReply,
  newTrialId,
  quoteText,
  trialEntryRequest,
  trialFormProblem,
  trialFormReducer,
  trialStateFromEntry,
  type TrialDraft,
  type TrialFormAction,
  type TrialFormPayloads,
  type TrialFormRequestKind,
  type TrialFormState,
  type TrialPositionState,
  type TrialQuote,
} from "@/lib/analysis/gains-at-risk-trial-view";
import { CHIP_TONE_TEXT, GOLD_FILL_CLASSES } from "../chip-tone-text";

const ENTRY_ROUTE = "/api/compute/gains-at-risk/trial-entry";
const QUOTE_ROUTE = "/api/tws/option-quote";
const ENSURE_ROUTE = "/api/tws/daily-bars/ensure";

const CHAIN_UNAVAILABLE = "The broker's list of expiries and strikes is not available. Type them.";
const OFF_CHAIN_STRIKE = "That strike is not in the broker's list. The quote will say whether it trades; clear it to pick from the list.";
const OFF_CHAIN_EXPIRY = "That expiry is not in the broker's list. The quote will say whether it trades; clear it to pick from the list.";

const inputClass = "px-2 py-1.5 rounded-md border border-edge bg-panel text-sm text-ink";
const pillClass = (on: boolean) =>
  `px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${
    on ? "bg-panel text-ink shadow-sm" : "text-ink-dim hover:text-ink"
  }`;

const onEnterBlur = (e: KeyboardEvent<HTMLInputElement>) => {
  if (e.key === "Enter") e.currentTarget.blur();
};

function Pills<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { key: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="space-y-1">
      <span className="block text-xs text-ink-faint">{label}</span>
      <div className="flex items-center gap-1 rounded-lg bg-raised border border-edge p-0.5 w-fit" role="group" aria-label={label}>
        {options.map((o) => (
          <button key={o.key} type="button" aria-pressed={value === o.key} onClick={() => onChange(o.key)} className={pillClass(value === o.key)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The "Try a position" form. Every request it makes (lookup, chain, quote,
 * daily-price fetch, entry) goes through `trialFormReducer` and carries the
 * draft's revision and contract key (P6): a late or mismatched reply is
 * dropped, and nothing is added after the form is closed. Editing an existing
 * trial runs `applyTrialEdit` first: a size-only change is saved with no
 * server call (P1); anything else is a new entry.
 *
 * All pricing and solving happens on the server. Contracts and quantities
 * are the owner's (PrivateNumberInput); prices and strikes are market data.
 */
export function TrialPositionForm({
  editing,
  listCount,
  today,
  onSave,
  onClose,
}: {
  editing: TrialPositionState | null;
  listCount: number;
  today: string;
  onSave: (trial: TrialPositionState) => void;
  onClose: () => void;
}) {
  const [state, dispatch] = useReducer(trialFormReducer, editing, (e: TrialPositionState | null) =>
    // An edit opens with no quote: a size-only change keeps the click's own quote (P1);
    // any other change is a new click, so an old quote must not price it.
    trialFormReducer(initialTrialFormState(), { type: "open", draft: e ? draftFromTrial(e) : emptyTrialDraft(), quote: null }),
  );
  // Kept in step with every action, so an async step reads the form as it now stands.
  const stateRef = useRef<TrialFormState>(state);
  const act = (action: TrialFormAction) => {
    stateRef.current = trialFormReducer(stateRef.current, action);
    dispatch(action);
  };
  const idRef = useRef(0);
  const [connected, setConnected] = useState<boolean | null>(null);
  // The status answer as a promise too, so Add can wait for it rather than skip the fetch.
  const statusRef = useRef<Promise<boolean> | null>(null);
  // One lookup per symbol on the way; Add joins it rather than being swallowed by it.
  const lookupRef = useRef<{ symbol: string; promise: Promise<TrialLookup | null> } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [lookupWanted, setLookupWanted] = useState<string | null>(null);
  // The field the owner is typing in: it is never swapped for a select under their cursor.
  const [typing, setTyping] = useState<null | "expiry" | "strike">(null);

  const draft = state.draft;
  const symbol = trialSymbolKey(draft);
  const security = state.security;
  // A lookup or the chain never holds up Add (Add joins the lookup); a quote, a fetch or an entry does.
  const busy = addBlockedBy(state);

  // Unmounted (a scope switch, the panel closing) while a request is on the way:
  // the same cancel transition, so no reply can add a position after the form is gone.
  useEffect(() => {
    // A development double mount runs the cleanup and mounts again: follow the rendered form.
    stateRef.current = state;
    return () => {
      stateRef.current = trialFormReducer(stateRef.current, { type: "cancel" });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Is the broker connected? Asked once when the form opens.
  useEffect(() => {
    let live = true;
    const ask = (async () => {
      try {
        const r = await readMutationResult<{ data: { state?: string } }>(await apiFetch("/api/tws/status"));
        return r.ok && r.data.data?.state === "connected";
      } catch {
        return false;
      }
    })();
    statusRef.current = ask;
    void ask.then((c) => {
      if (live) setConnected(c);
    });
    return () => {
      live = false;
    };
  }, []);

  async function connectedNow(): Promise<boolean> {
    if (connected !== null) return connected;
    return statusRef.current ? statusRef.current : false;
  }

  function edit(patch: Partial<TrialDraft>) {
    setProblem(null);
    act({ type: "edit", patch });
  }

  /**
   * A switch between option and shares changes what the count and the price
   * mean (contracts and premium, or shares and share price): both are
   * cleared, and shares start at the app's own price for the name.
   */
  function switchKind(kind: TrialDraft["kind"]) {
    const s = stateRef.current;
    if (kind === s.draft.kind) return;
    const appPrice = kind === "shares" && s.security?.price != null ? String(s.security.price) : "";
    edit({ kind, count: "", price: appPrice });
  }

  /** One request: register it, run it, then hand its payload to the reducer. Returns it only when still current. */
  async function request<K extends TrialFormRequestKind>(
    kind: K,
    send: (s: TrialFormState) => Promise<TrialFormPayloads[K]>,
  ): Promise<{ payload: TrialFormPayloads[K]; sent: TrialFormState } | null> {
    const sent = stateRef.current;
    if (!sent.open) return null;
    const id = ++idRef.current;
    const sym = trialSymbolKey(sent.draft);
    act({ type: "request", kind, id });
    const payload = await send(stateRef.current);
    const current = isCurrentTrialReply(stateRef.current, kind, id, sent.revision, sent.contractKey, sym);
    // The cast ties `payload` to `kind`: TypeScript cannot narrow a generic K into the reply union.
    act({ type: "reply", kind, id, revision: sent.revision, contractKey: sent.contractKey, symbol: sym, payload } as TrialFormAction);
    return current ? { payload, sent } : null;
  }

  function lookup(): Promise<TrialLookup | null> {
    const s = stateRef.current;
    const sym = trialSymbolKey(s.draft);
    if (s.security) return Promise.resolve(s.security);
    if (lookupRef.current && lookupRef.current.symbol === sym) return lookupRef.current.promise;
    const promise = (async (): Promise<TrialLookup | null> => {
      const r = await request("lookup", async () => {
        try {
          const res = await apiFetch(ENTRY_ROUTE, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "lookup", symbol: sym }),
          });
          const m = await readMutationResult<{ data: TrialEntryResponse }>(res);
          if (!m.ok) return { ok: false as const, message: m.message };
          if (m.data.data.action !== "lookup") return { ok: false as const, message: "Could not look up that symbol." };
          return { ok: true as const, security: m.data.data.security };
        } catch {
          return { ok: false as const, message: networkFailureMessage("look up that symbol") };
        }
      });
      return r && r.payload.ok ? r.payload.security : null;
    })();
    lookupRef.current = { symbol: sym, promise };
    void promise.finally(() => {
      if (lookupRef.current?.promise === promise) lookupRef.current = null;
    });
    return promise;
  }

  async function loadChain() {
    await request("chain", async (s) => {
      const sym = trialSymbolKey(s.draft);
      try {
        const res = await apiFetch(`/api/tws/option-chain?symbol=${encodeURIComponent(sym)}`);
        const m = await readMutationResult<{ data: { expirations?: string[]; strikes?: number[] } }>(res);
        if (!m.ok) return { ok: false as const, message: CHAIN_UNAVAILABLE };
        const expirations = (m.data.data.expirations ?? []).filter((e) => typeof e === "string" && e >= today);
        const strikes = (m.data.data.strikes ?? []).filter((k) => typeof k === "number" && Number.isFinite(k) && k > 0);
        if (expirations.length === 0 || strikes.length === 0) {
          return { ok: false as const, message: `The broker lists no expiries or strikes for ${sym}. Type them.` };
        }
        return { ok: true as const, expirations, strikes };
      } catch {
        return { ok: false as const, message: CHAIN_UNAVAILABLE };
      }
    });
  }

  async function ensureBars(securityId: number): Promise<boolean> {
    const r = await request("ensure", async () => {
      try {
        const res = await apiFetch(ENSURE_ROUTE, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ securityId }),
        });
        const m = await readMutationResult<{ data: EnsureBarsResponse }>(res);
        if (!m.ok) return { ok: false as const, message: m.message };
        return { ok: true as const, message: null };
      } catch {
        return { ok: false as const, message: networkFailureMessage("fetch daily prices") };
      }
    });
    return r !== null && r.payload.ok;
  }

  async function getQuote() {
    setProblem(null);
    const sec = await lookup();
    if (!sec) return;
    const d = stateRef.current.draft;
    const strike = Number(d.strike.trim());
    await request("quote", async () => {
      try {
        const res = await apiFetch(QUOTE_ROUTE, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ underlyingSecurityId: sec.securityId, right: d.right, expiry: d.expiry, strike }),
        });
        const m = await readMutationResult<{ data: OptionQuoteResponse }>(res);
        if (!m.ok) return { ok: false as const, message: m.message };
        const { quote, session } = m.data.data;
        if (!quote.ok) return { ok: false as const, message: optionQuoteRefusalSentence(quote.reason) };
        const q: TrialQuote = {
          tickKind: quote.tickKind,
          session,
          bid: quote.bid,
          ask: quote.ask,
          mid: quote.mid,
          underlyingLast: quote.underlyingLast,
          fetchedAt: quote.fetchedAt,
        };
        return { ok: true as const, quote: q };
      } catch {
        return { ok: false as const, message: networkFailureMessage("fetch the quote") };
      }
    });
  }

  function close() {
    act({ type: "cancel" });
    onClose();
  }

  async function submit() {
    const s = stateRef.current;
    // An edit may keep its own (now past) expiry: a size-only change of an expired trial is allowed.
    const keptExpiry = editing?.position.kind === "option" ? editing.position.expiry : undefined;
    const p = trialFormProblem(s.draft, listCount, today, { keptExpiry });
    if (p) {
      setProblem(p);
      return;
    }
    setProblem(null);
    if (editing) {
      const e = applyTrialEdit(editing, s.draft);
      if (e.kind === "resize") {
        // P1: the click's entry and holdings snapshot stand; no server call.
        onSave(e.next);
        close();
        return;
      }
    }
    if (s.draft.kind === "option" && s.draft.expiry < today) {
      setProblem("That expiry is before today. Pick a later one.");
      return;
    }
    // An edit while a step runs stops here: the owner presses Add again on the new draft.
    const unchanged = () => stateRef.current.open && stateRef.current.revision === s.revision;
    // Add joins a lookup the symbol's blur started, and waits for the broker status.
    const [sec, isConnected] = await Promise.all([lookup(), connectedNow()]);
    if (!sec || !unchanged()) return;
    const step = barsStep(stateRef.current, sec, isConnected);
    // P8: after a failed fetch, the owner chooses (try again, or add without daily prices).
    if (step === "blocked") return;
    if (step === "fetch") {
      // No daily prices yet: fetch them once before the entry measures the link.
      if (!(await ensureBars(sec.securityId)) || !unchanged()) return;
    }
    const r = await request("entry", async (now) => {
      try {
        const res = await apiFetch(ENTRY_ROUTE, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "entry", request: trialEntryRequest(now.draft, now.quote) }),
        });
        const m = await readMutationResult<{ data: TrialEntryResponse }>(res);
        if (!m.ok) return { ok: false as const, message: m.message };
        if (m.data.data.action !== "entry") return { ok: false as const, message: "Could not prepare the trial position." };
        return { ok: true as const, entry: m.data.data };
      } catch {
        return { ok: false as const, message: networkFailureMessage("prepare the trial position") };
      }
    });
    if (!r || !r.payload.ok) return;
    // The reply is current, so the draft and quote it was built from are still the form's.
    onSave(trialStateFromEntry(r.payload.entry, editing?.position.id ?? newTrialId(), r.sent.draft, r.sent.quote));
    close();
  }

  // A lookup dropped by a symbol edit is asked again once the symbol stands.
  useEffect(() => {
    if (!state.open || lookupWanted === null || lookupWanted !== symbol || symbol === "") return;
    if (state.security || state.pending.lookup !== undefined || state.messages.lookup) return;
    void lookup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.open, lookupWanted, symbol, state.security, state.pending.lookup, state.messages.lookup]);

  // The broker's expiries and strikes, once the name is known and the broker is connected.
  useEffect(() => {
    if (!state.open || draft.kind !== "option" || connected !== true || !state.security) return;
    if (state.chain || state.pending.chain !== undefined || state.messages.chain) return;
    void loadChain();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.open, draft.kind, connected, state.security, state.chain, state.pending.chain, state.messages.chain]);

  const isOption = draft.kind === "option";
  const fields = state.chain && isOption ? chainFieldState(draft, state.chain) : null;
  // A select only for a value in the chain, and never under the owner's cursor.
  const expirySelect = fields !== null && fields.expiry.inChain && typing !== "expiry";
  const strikeSelect = fields !== null && fields.strike.inChain && typing !== "strike";
  const strikeOk = Number.isFinite(Number(draft.strike.trim())) && Number(draft.strike.trim()) > 0;
  const noContract = security !== null && !security.hasContractId;
  const quoteBlocked = connected !== true || noContract || !draft.expiry || !strikeOk || busy;
  const barsLine = security ? lookupBarsLine(security, connected) : null;
  const barsBlocked = security !== null && connected === true && barsStep(state, security, true) === "blocked";
  const messages = (["lookup", "chain", "quote", "ensure", "entry"] as const)
    .map((k) => state.messages[k])
    .filter((m): m is string => typeof m === "string");

  return (
    <div className="rounded-lg border border-edge bg-raised p-3 space-y-3" role="group" aria-label={editing ? "Edit a trial position" : "Try a position"}>
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <Pills
          label="Kind"
          value={draft.kind}
          options={[
            { key: "option", label: "Option" },
            { key: "shares", label: "Shares" },
          ]}
          onChange={switchKind}
        />
        <label className="space-y-1">
          <span className="block text-xs text-ink-faint">{isOption ? "Underlying symbol" : "Symbol"}</span>
          <input
            type="text"
            value={draft.symbol}
            maxLength={32}
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            placeholder="ZZQ"
            onChange={(e) => edit({ symbol: e.target.value })}
            onBlur={() => {
              setLookupWanted(symbol);
              if (symbol !== "") void lookup();
            }}
            onKeyDown={onEnterBlur}
            className={`w-28 uppercase ${inputClass}`}
          />
        </label>
        <Pills
          label={isOption ? "Buy or write" : "Buy or sell"}
          value={draft.side}
          options={[
            { key: "buy", label: "Buy" },
            { key: "sell", label: isOption ? "Write" : "Sell" },
          ]}
          onChange={(side) => edit({ side })}
        />
        {isOption && (
          <Pills
            label="Put or call"
            value={draft.right}
            options={[
              { key: "put", label: "Put" },
              { key: "call", label: "Call" },
            ]}
            onChange={(right) => edit({ right })}
          />
        )}
      </div>

      {security && (
        <p className="text-xs text-ink-faint">
          {security.name ? `${security.name}. ` : ""}
          {security.price !== null && security.priceDate
            ? `The app's price ${formatMarketPrice(security.price)}, ${formatPositionsDate(security.priceDate)}.`
            : "The app has no price for it."}
          {barsLine ? ` ${barsLine}` : ""}
        </p>
      )}

      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        {isOption && (
          <label className="space-y-1">
            <span className="block text-xs text-ink-faint">Expiry</span>
            {expirySelect && fields ? (
              <select value={fields.expiry.value} onChange={(e) => edit({ expiry: e.target.value })} className={inputClass}>
                <option value="">Pick one</option>
                {state.chain?.expirations.map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="date"
                value={draft.expiry}
                min={today}
                onFocus={() => setTyping("expiry")}
                onBlur={() => setTyping(null)}
                onChange={(e) => edit({ expiry: e.target.value })}
                className={inputClass}
              />
            )}
          </label>
        )}
        {isOption && (
          <label className="space-y-1">
            <span className="block text-xs text-ink-faint">Strike</span>
            {strikeSelect && fields ? (
              <select value={fields.strike.value} onChange={(e) => edit({ strike: e.target.value })} className={inputClass}>
                <option value="">Pick one</option>
                {state.chain?.strikes.map((k) => (
                  <option key={k} value={String(k)}>
                    {formatStrike(k)}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="number"
                inputMode="decimal"
                step={0.5}
                min={0}
                value={draft.strike}
                onFocus={() => setTyping("strike")}
                onBlur={() => setTyping(null)}
                onChange={(e) => edit({ strike: e.target.value })}
                className={`w-24 tabular-nums ${inputClass}`}
              />
            )}
          </label>
        )}
        <label className="space-y-1">
          <span className="block text-xs text-ink-faint">{isOption ? "Contracts" : "Shares"}</span>
          <PrivateNumberInput
            inputMode="numeric"
            step={1}
            min={1}
            max={isOption ? TRIAL_POSITION_BOUNDS.maxContracts : TRIAL_POSITION_BOUNDS.maxShares}
            value={draft.count}
            onChange={(e) => edit({ count: e.target.value })}
            onKeyDown={onEnterBlur}
            className={`w-28 tabular-nums ${inputClass}`}
          />
        </label>
        <div className="space-y-1">
          <label htmlFor="trial-price" className="block text-xs text-ink-faint">
            Price per share
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id="trial-price"
              type="number"
              inputMode="decimal"
              step={0.01}
              min={0}
              value={draft.price}
              onChange={(e) => edit({ price: e.target.value })}
              onKeyDown={onEnterBlur}
              className={`w-24 tabular-nums ${inputClass}`}
            />
            {isOption && (
              <button
                type="button"
                disabled={quoteBlocked}
                onClick={() => void getQuote()}
                className="px-3 py-1.5 rounded-md border border-edge text-xs text-ink-dim hover:text-ink disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {state.pending.quote !== undefined ? "Fetching…" : "Get quote"}
              </button>
            )}
          </div>
        </div>
      </div>

      {isOption && fields && <p className="text-xs text-ink-faint">{TRIAL_STRIKES_NOTE}</p>}
      {isOption && fields && !fields.expiry.inChain && <p className="text-xs text-ink-faint">{OFF_CHAIN_EXPIRY}</p>}
      {isOption && fields && !fields.strike.inChain && <p className="text-xs text-ink-faint">{OFF_CHAIN_STRIKE}</p>}
      {isOption && connected === false && <p className="text-xs text-ink-faint">{TRIAL_CONNECT_FOR_QUOTES}</p>}
      {isOption && noContract && security && (
        <p className="text-xs text-ink-faint">{trialSecurityRefusalSentence("no-contract-id", security.symbol)}</p>
      )}
      {isOption && state.quote && <p className="text-xs text-ink-faint">Quote: {quoteText(state.quote)}.</p>}
      {isOption && <p className="text-xs text-ink-faint">{TRIAL_MULTIPLIER_NOTE}</p>}

      {problem && (
        <p role="alert" className={`text-xs ${CHIP_TONE_TEXT.down}`}>
          {problem}
        </p>
      )}
      {messages.map((m) => (
        <p key={m} role="status" className={`text-xs ${CHIP_TONE_TEXT.warn}`}>
          {m}
        </p>
      ))}

      {barsBlocked ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              act({ type: "retry-bars" });
              void submit();
            }}
            className={`px-3 py-1.5 rounded-md text-xs font-medium ${GOLD_FILL_CLASSES} disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            Try the daily-price fetch again
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              act({ type: "skip-bars" });
              void submit();
            }}
            className="px-3 py-1.5 rounded-md border border-edge text-xs text-ink-dim hover:text-ink disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Add without daily prices
          </button>
          <button type="button" onClick={close} className="px-3 py-1.5 rounded-md border border-edge text-xs text-ink-dim hover:text-ink">
            Cancel
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit()}
            className={`px-3 py-1.5 rounded-md text-xs font-medium ${GOLD_FILL_CLASSES} disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {busy ? "Working…" : editing ? "Save" : "Add"}
          </button>
          <button type="button" onClick={close} className="px-3 py-1.5 rounded-md border border-edge text-xs text-ink-dim hover:text-ink">
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
