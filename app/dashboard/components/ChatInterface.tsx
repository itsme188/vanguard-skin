"use client";

import { useState, useRef, useEffect } from "react";
import { MarkdownMessage } from "./MarkdownMessage";
import type { ChatScope } from "@/lib/types";

interface Message {
  role: "user" | "assistant";
  content: string;
}

const TOOL_LABELS: Record<string, string> = {
  query_holdings: "Querying holdings",
  query_price_history: "Fetching price history",
  query_allocation: "Computing allocation",
  query_tax_lots: "Analyzing tax lots",
  query_transactions: "Searching transactions",
  query_performance: "Loading performance data",
  query_income_summary: "Summarizing income",
  query_twr: "Computing time-weighted return",
};

// Scope configuration — labels, prompts, and personas
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

export function ChatInterface() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toolStatus, setToolStatus] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const [scope, setScope] = useState<ChatScope>("all");
  const isLocked = messages.length > 0;
  const suggestions = scope === "macro" ? MACRO_SUGGESTIONS : PORTFOLIO_SUGGESTIONS;
  const scopeLabel = SCOPE_OPTIONS.find((s) => s.value === scope)?.label ?? "All Accounts";

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, toolStatus]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || isStreaming) return;

    const userMessage = input.trim();
    setInput("");
    setError(null);
    setToolStatus(null);

    const newMessages: Message[] = [
      ...messages,
      { role: "user", content: userMessage },
    ];
    setMessages(newMessages);
    setIsStreaming(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: newMessages, scope }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to get response");
        setIsStreaming(false);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        setError("No response stream");
        setIsStreaming(false);
        return;
      }

      const decoder = new TextDecoder();
      let assistantContent = "";

      // Add empty assistant message that we'll stream into
      setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);

          if (data === "[DONE]") break;

          try {
            const parsed = JSON.parse(data);
            if (parsed.error) {
              setError(parsed.error);
              break;
            }
            if (parsed.status === "thinking") {
              setToolStatus("Thinking…");
            } else if (parsed.status === "analyzing" && parsed.tool) {
              // Show tool activity indicator
              const label = TOOL_LABELS[parsed.tool] ?? `Running ${parsed.tool}`;
              setToolStatus(label);
            }
            if (parsed.text) {
              // Clear tool status when text starts flowing
              setToolStatus(null);
              assistantContent += parsed.text;
              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = {
                  role: "assistant",
                  content: assistantContent,
                };
                return updated;
              });
            }
          } catch {
            // Skip malformed JSON lines
          }
        }
      }
    } catch {
      setError("Failed to connect to chat API");
    } finally {
      setIsStreaming(false);
      setToolStatus(null);
      inputRef.current?.focus();
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  }

  function handleNewConversation() {
    setMessages([]);
    setScope("all");
    setInput("");
    setError(null);
    setToolStatus(null);
  }

  return (
    <div className="flex flex-col h-[calc(100vh-12rem)]">
      {/* Messages area */}
      <div className="flex-1 overflow-y-auto space-y-4 pb-4">
        {/* Scope badge header (shown when conversation is active) */}
        {isLocked && (
          <div className="flex items-center justify-between pb-3 mb-3 border-b border-edge">
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
            <button
              onClick={handleNewConversation}
              className="text-xs text-ink-faint hover:text-ink-dim transition-colors"
            >
              New Conversation
            </button>
          </div>
        )}

        {messages.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <div className="text-center max-w-md">
              <div className="text-3xl text-ink-faint mb-4 font-serif italic">Analyst</div>
              <h3 className="text-ink font-medium mb-2">
                {scope === "macro" ? "Market Analyst" : "Portfolio Analyst"}
              </h3>
              <p className="text-ink-dim text-sm mb-6">
                {SCOPE_SUBTITLES[scope]}
              </p>

              {/* Scope chip bar */}
              <div className="flex flex-wrap justify-center gap-2 mb-6">
                {SCOPE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setScope(opt.value)}
                    className={`px-4 py-1.5 rounded-full text-xs border transition-all ${
                      scope === opt.value
                        ? "border-gold text-gold"
                        : "border-edge text-ink-dim hover:text-ink hover:border-edge-strong"
                    }`}
                    style={
                      scope === opt.value
                        ? { background: "rgba(201,164,78,0.2)", borderColor: "#c9a44e", color: "#c9a44e" }
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
                      setInput(suggestion);
                      inputRef.current?.focus();
                    }}
                    className="px-3 py-1.5 rounded-lg border border-edge text-xs text-ink-dim hover:text-ink hover:border-edge-strong transition-all"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[80%] rounded-xl px-4 py-3 text-sm leading-relaxed ${
                msg.role === "user"
                  ? "bg-raised border border-edge text-ink"
                  : "bg-panel border border-edge text-ink"
              }`}
            >
              {msg.role === "assistant" ? (
                msg.content ? (
                  <MarkdownMessage content={msg.content} />
                ) : (
                  <span className="text-ink-faint animate-pulse">Thinking...</span>
                )
              ) : (
                <div className="whitespace-pre-wrap">{msg.content}</div>
              )}
            </div>
          </div>
        ))}

        {/* Tool status indicator */}
        {toolStatus && (
          <div className="flex justify-start">
            <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-panel/50 border border-edge/50 text-xs text-ink-dim">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-gold animate-pulse" />
              {toolStatus}
            </div>
          </div>
        )}

        {error && (
          <div className="flex justify-start">
            <div className="max-w-[80%] rounded-xl px-4 py-3 text-sm bg-down-tint border border-down/20 text-down">
              {error}
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="border-t border-edge pt-4">
        <form onSubmit={handleSubmit} className="flex gap-3">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={scope === "macro" ? "Ask about markets and macro..." : "Ask your portfolio analyst..."}
            rows={1}
            className="flex-1 rounded-xl bg-raised border border-edge px-4 py-3 text-sm text-ink placeholder:text-ink-faint resize-none focus:outline-none focus:border-gold transition-colors"
          />
          <button
            type="submit"
            disabled={isStreaming || !input.trim()}
            className="px-5 py-3 rounded-xl bg-gold text-canvas font-medium text-sm hover:brightness-110 transition-all disabled:opacity-40 disabled:hover:brightness-100"
          >
            {isStreaming ? "..." : "Send"}
          </button>
        </form>
        <p className="text-[11px] text-ink-faint mt-2 text-center">
          Powered by Claude. Analyzes portfolio data — does not provide investment advice.
        </p>
      </div>
    </div>
  );
}
