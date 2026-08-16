"use client";

import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import type { UIMessage } from "ai";
import { MarkdownMessage } from "./MarkdownMessage";
import { QuickActionChips } from "./QuickActionChips";
import { ConfirmDialog } from "./ConfirmDialog";
import { useToast } from "./Toast";
import { PrivateText } from "@/lib/privacy/components";
import { usePrivacy } from "@/lib/privacy/context";
import { getQuickActions } from "@/lib/chat/quick-actions";
import { getPageContext } from "@/lib/chat/page-context";
import type { ChatScope } from "@/lib/types";
import type { ChatConversation, ChatMessage } from "@/lib/queries/chat";
import apiFetch from "@/lib/http/apiFetch";

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
  query_press_releases: "Fetching press releases",
  query_analyst_coverage: "Fetching analyst coverage",
  query_filing_section: "Summarizing SEC filing",
  query_research_documents: "Searching research documents",
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

// Wraps MarkdownMessage with privacy masking. Direct PrivateText wrap is
// invalid HTML because PrivateText renders a <span> and MarkdownMessage
// outputs block elements (<p>, <h1>, <table>).
function PrivateMarkdown({ content }: { content: string }) {
  const { isPrivate } = usePrivacy();
  if (isPrivate) {
    return <div className="text-ink-dim">•••</div>;
  }
  return <MarkdownMessage content={content} />;
}

function renderAssistantParts(parts: UIMessage["parts"]) {
  if (parts.length === 0) {
    return <span className="text-ink-faint animate-pulse">Thinking...</span>;
  }

  return parts.map((part, i) => {
    if (part.type === "text") {
      return part.text ? (
        <PrivateMarkdown key={i} content={part.text} />
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
  const text = parts
    .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");
  return (
    <div className="whitespace-pre-wrap">
      <PrivateText>{text}</PrivateText>
    </div>
  );
}

// ─── Helper: convert DB messages to UIMessage format ────────────

function dbMessageToUIMessage(m: ChatMessage): UIMessage {
  return {
    id: String(m.id),
    role: m.role as "user" | "assistant",
    parts: m.parts
      ? JSON.parse(m.parts)
      : [{ type: "text" as const, text: m.content ?? "" }],
  };
}

// ─── Conversation history dropdown ──────────────────────────────

function ConversationHistory({
  conversations,
  currentId,
  onSelect,
  onNew,
  onDelete,
}: {
  conversations: ChatConversation[];
  currentId: number | null;
  onSelect: (conv: ChatConversation) => void;
  onNew: () => void;
  onDelete: (conv: ChatConversation) => void;
}) {
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on click outside
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const currentConv = conversations.find((c) => c.id === currentId);
  const displayTitle = currentConv?.title ?? "Current conversation";

  return (
    <div className="relative min-w-0" ref={dropdownRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-ink-dim hover:text-ink transition-colors max-w-[min(200px,100%)] truncate"
        title={displayTitle}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
        <span className="truncate">{displayTitle}</span>
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 w-64 bg-panel border border-edge rounded-lg shadow-xl z-50 py-1 max-h-72 overflow-y-auto">
          <button
            onClick={() => { onNew(); setOpen(false); }}
            className="w-full text-left px-3 py-2 text-xs text-gold-ink hover:bg-raised transition-colors flex items-center gap-2"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            New Conversation
          </button>
          <div className="border-t border-edge my-1" />
          {conversations.length === 0 && (
            <div className="px-3 py-2 text-xs text-ink-faint">No conversations yet</div>
          )}
          {conversations.map((conv) => (
            <div
              key={conv.id}
              className={`group flex items-center transition-colors ${
                conv.id === currentId ? "bg-raised" : "hover:bg-raised"
              }`}
            >
              <button
                onClick={() => { onSelect(conv); setOpen(false); }}
                className={`flex-1 min-w-0 text-left pl-3 pr-2 py-2 text-xs ${
                  conv.id === currentId ? "text-ink" : "text-ink-dim group-hover:text-ink"
                }`}
                title={conv.title ?? `Conversation ${conv.id}`}
              >
                <div className="truncate">
                  {conv.title ?? `Conversation ${conv.id}`}
                </div>
                <div className="text-[10px] text-ink-faint mt-0.5">
                  {SCOPE_OPTIONS.find((s) => s.value === conv.scope)?.label ?? conv.scope}
                  {" \u00b7 "}
                  {new Date(conv.updated_at).toLocaleDateString()}
                </div>
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(conv); }}
                className="shrink-0 p-2 mr-1 text-ink-faint hover:text-down opacity-0 group-hover:opacity-100 focus:opacity-100 pointer-coarse:opacity-100 transition-opacity relative pointer-coarse:after:absolute pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-0.5 pointer-coarse:after:content-['']"
                aria-label={`Delete conversation ${conv.title ?? conv.id}`}
                title="Delete"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6" />
                  <path d="M14 11v6" />
                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────

interface ChatInterfaceProps {
  pathname: string;
}

export function ChatInterface({ pathname }: ChatInterfaceProps) {
  const [scope, setScope] = useState<ChatScope>("all");
  const [inputText, setInputText] = useState("");
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [loadedInitial, setLoadedInitial] = useState(false);
  const [deletePending, setDeletePending] = useState<ChatConversation | null>(null);
  const { toast } = useToast();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Compute page context and quick actions from pathname
  const pageContext = useMemo(() => getPageContext(pathname), [pathname]);
  const quickActions = useMemo(() => getQuickActions(pathname), [pathname]);

  // Stable, api-only transport. Do NOT put request body (scope / conversationId
  // / pageContext) here: `useChat` captures the transport from the FIRST render
  // and ignores later transport objects, so a body baked in here freezes at the
  // mount-time values (scope "all") — the scope selector then silently never
  // reaches /api/chat (the 2026-06-15 leak: a "Vanguard Taxable" chat ran
  // unscoped). The live scope is passed per-call via sendMessage/regenerate's
  // `body` instead (see requestBody below), which reads current state at send time.
  const transport = useMemo(() => new DefaultChatTransport({ api: "/api/chat" }), []);

  const {
    messages,
    status,
    error,
    sendMessage,
    regenerate,
    setMessages,
    stop,
  } = useChat({ transport });

  // Per-call request body — re-read on every send so the CURRENT scope,
  // conversation, and page context reach the server (see transport note above).
  const requestBody = useMemo(
    () => ({ scope, conversationId, pageContext }),
    [scope, conversationId, pageContext]
  );

  const isStreaming = status === "streaming" || status === "submitted";
  const isLocked = messages.length > 0;
  const scopeLabel =
    SCOPE_OPTIONS.find((s) => s.value === scope)?.label ?? "All Accounts";

  // Fetch conversation list
  const fetchConversations = useCallback(async () => {
    try {
      const res = await fetch("/api/chat/conversations");
      if (res.ok) {
        const data = await res.json();
        setConversations(data.conversations ?? []);
        return data.conversations ?? [];
      }
    } catch {
      // Silently fail — conversations are non-critical
    }
    return [];
  }, []);

  // Load a conversation's messages by ID
  const loadConversation = useCallback(async (conv: ChatConversation) => {
    try {
      const res = await fetch(`/api/chat/conversations/${conv.id}/messages`);
      if (res.ok) {
        const data = await res.json();
        const dbMessages: ChatMessage[] = data.messages ?? [];
        const uiMessages = dbMessages.map(dbMessageToUIMessage);
        setMessages(uiMessages);
        setConversationId(conv.id);
        setScope((conv.scope as ChatScope) || "all");
      }
    } catch {
      // Silently fail
    }
  }, [setMessages]);

  // On mount: default to a FRESH conversation (U2a). We populate the history
  // list so past chats stay reachable (Recent Conversations in the empty state),
  // but deliberately do NOT auto-resume the most recent one — opening the app
  // lands on an empty "New conversation" rather than mid-thread.
  useEffect(() => {
    if (loadedInitial) return;
    setLoadedInitial(true);
    void fetchConversations();
  }, [loadedInitial, fetchConversations]);

  // After streaming ends, refresh conversation list to pick up new/updated conversations
  const prevStatusRef = useRef(status);
  useEffect(() => {
    const wasStreaming = prevStatusRef.current === "streaming" || prevStatusRef.current === "submitted";
    const doneNow = status === "ready" || status === "error";
    if (wasStreaming && doneNow) {
      // Refresh conversations + capture conversationId from the latest if we don't have one
      (async () => {
        const convs = await fetchConversations();
        if (!conversationId && convs.length > 0) {
          // The server created a conversation — find the most recent one
          setConversationId(convs[0].id);
        }
      })();
    }
    prevStatusRef.current = status;
  }, [status, conversationId, fetchConversations]);

  // Auto-scroll on new content
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // focus-chat-input: dispatched by ChatDrawer when Cmd+J fires on the
  // persistent rail (≥1280px). The rail is already visible there so toggling
  // would be wrong — we focus the textarea instead.
  useEffect(() => {
    function handleFocus() {
      inputRef.current?.focus();
    }
    window.addEventListener("focus-chat-input", handleFocus);
    return () => window.removeEventListener("focus-chat-input", handleFocus);
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!inputText.trim() || isStreaming) return;

    const text = inputText.trim();
    setInputText("");
    await sendMessage({ text }, { body: requestBody });
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
    setConversationId(null);
    setScope("all");
    setInputText("");
  }

  const handleDeleteConversation = useCallback((conv: ChatConversation) => {
    setDeletePending(conv);
  }, []);

  const confirmDeleteConversation = useCallback(async () => {
    const conv = deletePending;
    if (!conv) return;
    setDeletePending(null);

    try {
      const res = await apiFetch(`/api/chat/conversations/${conv.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        // The dialog already closed — without this the conversation just
        // stays in the list and the delete looks like it never happened.
        toast(`Couldn't delete the conversation (server returned ${res.status}).`, "error");
        return;
      }

      // If the deleted conversation is currently loaded, reset to empty state
      if (conv.id === conversationId) {
        if (isStreaming) stop();
        setMessages([]);
        setConversationId(null);
      }
      await fetchConversations();
    } catch {
      toast("Couldn't delete the conversation: could not reach the server.", "error");
    }
  }, [deletePending, conversationId, fetchConversations, isStreaming, setMessages, stop, toast]);

  function handleQuickAction(prompt: string) {
    setInputText(prompt);
    inputRef.current?.focus();
  }

  return (
    <div className="flex flex-col h-[calc(100dvh-12rem)]">
      {/* Messages area */}
      <div
        className="flex-1 overflow-y-auto space-y-4 pb-4"
        aria-live="polite"
        aria-label="Chat messages"
      >
        {/* Conversation header (shown when conversation is active) */}
        {isLocked && (
          /* min-w-0 on the left group + the picker root: without it the
             flex-child min-width:auto floor keeps the group at its content
             width (scope pill + 200px title) and the long-title case
             overpaints the New Conversation button at 390px viewports. */
          <div className="flex items-center justify-between gap-2 pb-3 mb-3 border-b border-edge">
            <div className="flex items-center gap-2 min-w-0">
              <span
                className="px-3 py-1 rounded-full text-[11px] border shrink-0"
                style={{
                  background: "rgba(201,164,78,0.15)",
                  borderColor: "rgba(201,164,78,0.3)",
                  color: "#c9a44e",
                }}
              >
                {scopeLabel}
              </span>
              {conversations.length > 0 && (
                <ConversationHistory
                  conversations={conversations}
                  currentId={conversationId}
                  onSelect={loadConversation}
                  onNew={handleNewConversation}
                  onDelete={handleDeleteConversation}
                />
              )}
            </div>
            <button
              onClick={handleNewConversation}
              className="text-xs text-ink-faint hover:text-ink-dim transition-colors focus-ring shrink-0"
            >
              New Conversation
            </button>
          </div>
        )}

        {/* Empty state */}
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-full">
            {/* min-w-0 + w-full: flex-child min-width:auto otherwise lets long
                conversation titles push this past narrow (mobile) viewports,
                clipping both edges and defeating the buttons' truncate */}
            <div className="text-center w-full max-w-md min-w-0 px-4">
              <div className="text-3xl text-ink-faint mb-4 italic font-light">
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
                    className={`px-4 py-1.5 rounded-full text-xs border transition-[color,border-color] focus-ring ${
                      scope === opt.value
                        ? "border-gold text-gold-ink"
                        : "border-edge text-ink-dim hover:text-ink hover:border-edge-strong"
                    }`}
                    style={
                      scope === opt.value
                        ? {
                            // color deliberately NOT set inline — it would
                            // override the text-gold-ink contrast token.
                            background: "rgba(201,164,78,0.2)",
                            borderColor: "#c9a44e",
                          }
                        : undefined
                    }
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              {/* Conversation history in empty state */}
              {conversations.length > 0 && (
                <div className="mb-6">
                  <div className="text-[11px] text-ink-faint mb-2 uppercase tracking-wider">Recent Conversations</div>
                  <div className="flex flex-col gap-1 max-h-32 overflow-y-auto">
                    {conversations.slice(0, 5).map((conv) => (
                      <button
                        key={conv.id}
                        onClick={() => loadConversation(conv)}
                        className="text-left px-3 py-1.5 rounded-lg border border-edge text-xs text-ink-dim hover:text-ink hover:border-edge-strong transition-[color,border-color] focus-ring truncate"
                        title={conv.title ?? `Conversation ${conv.id}`}
                      >
                        {conv.title ?? `Conversation ${conv.id}`}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Quick action chips (context-aware) */}
              <QuickActionChips
                actions={quickActions}
                onSelect={handleQuickAction}
              />
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
              className={`rounded-xl px-4 py-3 text-sm leading-relaxed ${
                msg.role === "user"
                  ? "max-w-[80%] bg-raised border border-edge text-ink"
                  : "max-w-[92%] bg-panel border border-edge text-ink"
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
              onClick={() => regenerate({ body: requestBody })}
              className="px-3 py-1.5 text-xs text-ink-dim border border-edge rounded-lg hover:text-ink hover:border-edge-strong transition-[color,border-color] focus-ring"
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
            className="px-5 py-3 rounded-xl bg-gold text-canvas font-medium text-sm hover:brightness-110 transition-[filter,scale] active:scale-[0.96] disabled:opacity-40 disabled:hover:brightness-100 disabled:cursor-not-allowed focus-ring"
          >
            {isStreaming ? "..." : "Send"}
          </button>
        </form>
        <p className="text-[11px] text-ink-faint mt-2 text-center">
          Powered by Claude. Analyzes portfolio data — does not provide
          investment advice.
        </p>
      </div>
      <ConfirmDialog
        open={deletePending !== null}
        title="Delete conversation"
        message={`Delete "${deletePending?.title ?? `Conversation ${deletePending?.id}`}"? This cannot be undone.`}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={confirmDeleteConversation}
        onCancel={() => setDeletePending(null)}
      />
    </div>
  );
}
