"use client";

import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import type { UIMessage } from "ai";
import { MarkdownMessage } from "./MarkdownMessage";
import type { ChatScope } from "@/lib/types";

// Friendly labels for tool call indicators
const TOOL_LABELS: Record<string, string> = {
  query_holdings: "Querying holdings",
  query_price_history: "Fetching price history",
  query_allocation: "Computing allocation",
  query_tax_lots: "Analyzing tax lots",
  query_transactions: "Searching transactions",
  query_performance: "Loading performance data",
  query_income_summary: "Summarizing income",
  query_twr: "Computing time-weighted return",
  query_fred: "Fetching economic data",
  query_company_fundamentals: "Looking up company financials",
  query_insider_trades: "Fetching insider trading data",
  query_notes: "Searching notes",
  create_note: "Saving note",
  query_earnings_transcript: "Fetching earnings transcript",
};

// Scope configuration
const SCOPE_OPTIONS: { value: ChatScope; label: string }[] = [
  { value: "all", label: "All Accounts" },
  { value: "ibkr", label: "IBKR" },
  { value: "vanguard-taxable", label: "Vanguard Taxable" },
  { value: "vanguard-roth-ira", label: "Vanguard Roth IRA" },
  { value: "macro", label: "Macro" },
];

const SCOPE_SUBTITLES: Record<ChatScope, string> = {
  all: "Ask about your portfolio — concentration risk, tax optimization, performance attribution, income analysis, and more.",
  ibkr: "Analyzing your IBKR trading account.",
  "vanguard-taxable": "Analyzing your Vanguard taxable account.",
  "vanguard-roth-ira": "Analyzing your Vanguard Roth IRA.",
  macro: "Market & macro analysis — no portfolio data by default.",
};

const PORTFOLIO_SUGGESTIONS = [
  "Give me a full portfolio health check",
  "Analyze my sector concentration",
  "Find tax-loss harvesting opportunities",
  "Which factor am I most exposed to right now?",
];

const MACRO_SUGGESTIONS = [
  "What's moving markets today?",
  "Compare sector performance YTD",
  "Summarize the current yield curve",
  "What are the biggest macro risks right now?",
];

// ─── Sub-components ──────────────────────────────────────────────

function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-2 text-xs text-ink-dim my-1">
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-gold animate-pulse" />
      Thinking…
    </div>
  );
}

function ToolIndicator({ name, state }: { name: string; state: string }) {
  // Hide completed tools — they served their purpose
  if (state === "output-available") return null;

  const label = TOOL_LABELS[name] ?? `Using ${name}`;
  const isError = state === "output-error";

  return (
    <div className="flex items-center gap-2 text-xs text-ink-dim my-1">
      {isError ? (
        <span className="text-down">Tool error</span>
      ) : (
        <>
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-gold animate-pulse" />
          {label}
        </>
      )}
    </div>
  );
}

function CopyButton({ message }: { message: UIMessage }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    const text = message.parts
      .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
      .map((p) => p.text)
      .join("\n\n");
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [message]);

  return (
    <button
      onClick={handleCopy}
      className="mt-2 text-[10px] text-ink-faint hover:text-ink-dim transition-colors focus-ring"
      aria-label="Copy message"
    >
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

// ─── Message rendering ───────────────────────────────────────────

function renderAssistantParts(parts: UIMessage["parts"]) {
  if (parts.length === 0) {
    return <span className="text-ink-faint animate-pulse">Thinking...</span>;
  }

  return parts.map((part, i) => {
    if (part.type === "text") {
      return part.text ? (
        <MarkdownMessage key={i} content={part.text} />
      ) : null;
    }

    if (part.type === "reasoning") {
      // Show indicator only while actively reasoning — hide completed
      return (part as { state?: string }).state === "streaming" ? (
        <ThinkingIndicator key={i} />
      ) : null;
    }

    if (part.type === "step-start") {
      return null;
    }

    // Tool parts: type is 'tool-${toolName}'
    if (part.type.startsWith("tool-")) {
      const toolName = part.type.slice(5);
      const state = (part as { state: string }).state;
      return <ToolIndicator key={i} name={toolName} state={state} />;
    }

    return null;
  });
}

function renderUserParts(parts: UIMessage["parts"]) {
  return (
    <div className="whitespace-pre-wrap">
      {parts
        .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
        .map((p) => p.text)
        .join("")}
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────

export function ChatInterface() {
  const [scope, setScope] = useState<ChatScope>("all");
  const [inputText, setInputText] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Recreate transport when scope changes (scope is locked after first message)
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        body: { scope },
      }),
    [scope]
  );

  const {
    messages,
    status,
    error,
    sendMessage,
    regenerate,
    setMessages,
    stop,
  } = useChat({ transport });

  const isStreaming = status === "streaming" || status === "submitted";
  const isLocked = messages.length > 0;
  const suggestions = scope === "macro" ? MACRO_SUGGESTIONS : PORTFOLIO_SUGGESTIONS;
  const scopeLabel =
    SCOPE_OPTIONS.find((s) => s.value === scope)?.label ?? "All Accounts";

  // Auto-scroll on new content
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!inputText.trim() || isStreaming) return;

    const text = inputText.trim();
    setInputText("");
    await sendMessage({ text });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  }

  function handleNewConversation() {
    if (isStreaming) stop();
    setMessages([]);
    setScope("all");
    setInputText("");
  }

  return (
    <div className="flex flex-col h-[calc(100vh-12rem)]">
      {/* Messages area */}
      <div
        className="flex-1 overflow-y-auto space-y-4 pb-4"
        aria-live="polite"
        aria-label="Chat messages"
      >
        {/* Scope badge header (shown when conversation is active) */}
        {isLocked && (
          <div className="flex items-center justify-between pb-3 mb-3 border-b border-edge">
            <div className="flex items-center gap-2">
              <span
                className="px-3 py-1 rounded-full text-[11px] border"
                style={{
                  background: "rgba(201,164,78,0.15)",
                  borderColor: "rgba(201,164,78,0.3)",
                  color: "#c9a44e",
                }}
              >
                {scopeLabel}
              </span>
              <span className="text-[10px] text-ink-faint">
                Start a new conversation to change scope
              </span>
            </div>
            <button
              onClick={handleNewConversation}
              className="text-xs text-ink-faint hover:text-ink-dim transition-colors focus-ring"
            >
              New Conversation
            </button>
          </div>
        )}

        {/* Empty state */}
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <div className="text-center max-w-md">
              <div className="text-3xl text-ink-faint mb-4 font-serif italic">
                Analyst
              </div>
              <h3 className="text-ink font-medium mb-2">
                {scope === "macro" ? "Market Analyst" : "Portfolio Analyst"}
              </h3>
              <p className="text-ink-dim text-sm mb-6">
                {SCOPE_SUBTITLES[scope]}
              </p>

              {/* Scope chip bar */}
              <div
                className="flex flex-wrap justify-center gap-2 mb-6"
                role="group"
                aria-label="Analysis scope"
              >
                {SCOPE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setScope(opt.value)}
                    aria-pressed={scope === opt.value}
                    className={`px-4 py-1.5 rounded-full text-xs border transition-all focus-ring ${
                      scope === opt.value
                        ? "border-gold text-gold"
                        : "border-edge text-ink-dim hover:text-ink hover:border-edge-strong"
                    }`}
                    style={
                      scope === opt.value
                        ? {
                            background: "rgba(201,164,78,0.2)",
                            borderColor: "#c9a44e",
                            color: "#c9a44e",
                          }
                        : undefined
                    }
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              {/* Dynamic prompt suggestions */}
              <div className="flex flex-wrap justify-center gap-2">
                {suggestions.map((suggestion) => (
                  <button
                    key={suggestion}
                    onClick={() => {
                      setInputText(suggestion);
                      inputRef.current?.focus();
                    }}
                    className="px-3 py-1.5 rounded-lg border border-edge text-xs text-ink-dim hover:text-ink hover:border-edge-strong transition-all focus-ring"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Message list */}
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[80%] rounded-xl px-4 py-3 text-sm leading-relaxed ${
                msg.role === "user"
                  ? "bg-raised border border-edge text-ink"
                  : "bg-panel border border-edge text-ink"
              }`}
            >
              {msg.role === "user" ? (
                renderUserParts(msg.parts)
              ) : (
                <>
                  {renderAssistantParts(msg.parts)}
                  {/* Copy button — only show if there's actual text content */}
                  {msg.parts.some(
                    (p) => p.type === "text" && (p as { text: string }).text
                  ) && <CopyButton message={msg} />}
                </>
              )}
            </div>
          </div>
        ))}

        {/* Error display */}
        {error && (
          <div className="flex justify-start">
            <div className="max-w-[80%] rounded-xl px-4 py-3 text-sm bg-down-tint border border-down/20 text-down">
              {error.message}
            </div>
          </div>
        )}

        {/* Retry button on error */}
        {status === "error" && messages.length > 0 && (
          <div className="flex justify-start">
            <button
              onClick={() => regenerate()}
              className="px-3 py-1.5 text-xs text-ink-dim border border-edge rounded-lg hover:text-ink hover:border-edge-strong transition-all focus-ring"
            >
              Retry
            </button>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="border-t border-edge pt-4">
        <form onSubmit={handleSubmit} className="flex gap-3">
          <textarea
            ref={inputRef}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              scope === "macro"
                ? "Ask about markets and macro..."
                : "Ask your portfolio analyst..."
            }
            aria-label="Chat message"
            rows={1}
            className="flex-1 rounded-xl bg-raised border border-edge px-4 py-3 text-sm text-ink placeholder:text-ink-faint resize-none transition-colors"
          />
          <button
            type="submit"
            disabled={isStreaming || !inputText.trim()}
            aria-label={isStreaming ? "Streaming response" : "Send message"}
            title={!inputText.trim() ? "Type a message first" : undefined}
            className="px-5 py-3 rounded-xl bg-gold text-canvas font-medium text-sm hover:brightness-110 transition-all disabled:opacity-40 disabled:hover:brightness-100 disabled:cursor-not-allowed focus-ring"
          >
            {isStreaming ? "..." : "Send"}
          </button>
        </form>
        <p className="text-[11px] text-ink-faint mt-2 text-center">
          Powered by Claude. Analyzes portfolio data — does not provide
          investment advice.
        </p>
      </div>
    </div>
  );
}
