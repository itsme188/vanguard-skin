"use client";

import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses } from "ai";
import type { UIMessage } from "ai";
import { MarkdownMessage } from "./MarkdownMessage";
import { QuickActionChips } from "./QuickActionChips";
import { ConfirmDialog } from "./ConfirmDialog";
import { useToast } from "./Toast";
import { CHIP_TONE_TEXT, GOLD_FILL_CLASSES } from "./chip-tone-text";
import { conversationTitleFromMessages } from "@/lib/chat/conversation-title";
import { getQuickActions } from "@/lib/chat/quick-actions";
import {
  CHAT_MODEL_FAMILIES,
  DEFAULT_CHAT_MODEL_FAMILY,
  chatFamilyName,
  liveModelLabel,
  openConversationModelLabel,
  requestModelFamily,
  type ChatModelFamily,
} from "@/lib/chat/model-choice";
import { toolLabel } from "@/lib/chat/tool-labels";
import { turnOutcomeNotice } from "@/lib/chat/turn-outcome";
import {
  chatErrorText,
  conversationDayLabel,
  decideTurnAdoption,
  nextFollowBottom,
  noteApprovalView,
  shouldAutoContinue,
  shouldIgnoreStopClick,
  showThinking,
  settledAssistantView,
  toolIndicatorState,
  type NoteApprovalView,
  type NoteToolPartView,
} from "@/lib/chat/turn-adoption";
import type { ChatScope } from "@/lib/types";
import type { ChatConversation, ChatMessage } from "@/lib/queries/chat";
import apiFetch, { type ApiFetch } from "@/lib/http/apiFetch";
import { readMutationResult, networkFailureMessage } from "@/lib/ui/mutation-result";

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

function ToolIndicator({ name, kind }: { name: string; kind: "active" | "error" }) {
  const label = toolLabel(name);
  return (
    <div className="flex items-center gap-2 text-xs text-ink-dim my-1">
      {kind === "error" ? (
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
      className="relative pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-2 mt-2 text-[10px] text-ink-faint hover:text-ink-dim transition-colors focus-ring"
      aria-label="Copy message"
    >
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

// ─── create_note approval card (Contract C) ─────────────────────
//
// Module-level on purpose (a component defined inside ChatInterface would
// remount on each of its renders). A drafted note is saved only by a click
// here: the SDK holds the tool's execute until the owner answers, so text
// inside a tool result can draft a note but never save one.
function NoteApprovalCard({
  view,
  disabled,
  onAnswer,
}: {
  view: NoteApprovalView;
  disabled: boolean;
  onAnswer: (approvalId: string, approved: boolean) => void;
}) {
  if (view.kind === "ask") {
    const meta = [view.noteType ?? "note", view.symbol, view.eventDate].filter(Boolean).join(" · ");
    return (
      <div className="my-2 rounded-lg border border-edge bg-raised px-3 py-3" role="group" aria-label="Drafted note">
        <div className="text-xs text-ink-dim mb-1">Save this note to your journal?</div>
        <div className="text-xs text-ink-dim mb-2">{meta}</div>
        <div className="whitespace-pre-wrap text-sm text-ink mb-3">{view.content}</div>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={disabled}
            onClick={() => onAnswer(view.approvalId, true)}
            className={`min-h-9 pointer-coarse:min-h-11 px-3 py-1.5 rounded-lg text-xs font-medium ${GOLD_FILL_CLASSES} hover:brightness-110 transition-[filter] disabled:opacity-40 disabled:cursor-not-allowed focus-ring`}
          >
            Save note
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onAnswer(view.approvalId, false)}
            className="min-h-9 pointer-coarse:min-h-11 px-3 py-1.5 rounded-lg text-xs text-ink-dim border border-edge hover:text-ink hover:border-edge-strong transition-[color,border-color] disabled:opacity-40 disabled:cursor-not-allowed focus-ring"
          >
            {"Don't save"}
          </button>
        </div>
      </div>
    );
  }
  const text =
    view.kind === "saving"
      ? "Saving…"
      : view.kind === "saved"
        ? "Saved"
        : view.kind === "unconfirmed"
          ? "Save not confirmed; check Notes"
          : view.reason
          ? `Not saved: ${view.reason}`
          : "Not saved";
  return <div className="text-xs text-ink-dim my-1">Note: {text}</div>;
}

// ─── Message rendering ───────────────────────────────────────────

interface AssistantPartOptions {
  onNoteAnswer: (approvalId: string, approved: boolean) => void;
  /** A reply is pending: approval buttons are disabled. */
  busy: boolean;
  /** This message is the one streaming now (R4-3: otherwise it is settled). */
  live: boolean;
  /** This message is the last one (R4-2: only it can answer an approval). */
  inLastMessage: boolean;
}

function renderAssistantParts(parts: UIMessage["parts"], opts: AssistantPartOptions) {
  if (parts.length === 0 && opts.live) {
    return <span className="text-ink-faint animate-pulse">Thinking...</span>;
  }

  return parts.map((part, i) => {
    if (part.type === "text") {
      return part.text ? (
        <MarkdownMessage key={i} content={part.text} />
      ) : null;
    }

    if (part.type === "reasoning") {
      // Show indicator only while actively reasoning in the live message
      return showThinking((part as { state?: string }).state, opts.live) ? (
        <ThinkingIndicator key={i} />
      ) : null;
    }

    if (part.type === "step-start") {
      return null;
    }

    // Tool parts: type is 'tool-${toolName}'
    if (part.type.startsWith("tool-")) {
      const noteView = noteApprovalView(part as NoteToolPartView, { inLastMessage: opts.inLastMessage });
      if (noteView) {
        return (
          <NoteApprovalCard key={i} view={noteView} disabled={opts.busy} onAnswer={opts.onNoteAnswer} />
        );
      }
      const kind = toolIndicatorState((part as { state?: string }).state, opts.live);
      return kind ? <ToolIndicator key={i} name={part.type.slice(5)} kind={kind} /> : null;
    }

    return null;
  });
}

function renderUserParts(parts: UIMessage["parts"]) {
  const text = parts
    .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");
  return <div className="whitespace-pre-wrap">{text}</div>;
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
  fallbackTitle,
}: {
  conversations: ChatConversation[];
  currentId: number | null;
  onSelect: (conv: ChatConversation) => void;
  onNew: () => void;
  onDelete: (conv: ChatConversation) => void;
  /** The open conversation's first question, for a row with no title yet. */
  fallbackTitle: string | null;
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
  const displayTitle =
    currentConv?.title ?? fallbackTitle ?? "Current conversation";

  return (
    /* md:relative, not relative: at phone width the menu anchors to the fixed
       header row instead (that row is `relative`), so a 256px menu opening
       beside a long scope pill cannot run off the right edge of a 390px
       screen. */
    <div className="md:relative min-w-0" ref={dropdownRef}>
      {/* No `truncate` on the button itself: its overflow:hidden would clip
          the pointer-coarse ::after touch extension. The inner span truncates. */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-3 pointer-coarse:after:-inset-x-1 flex items-center gap-1.5 text-xs text-ink-dim hover:text-ink transition-colors max-w-[min(200px,100%)] min-w-0"
        title={displayTitle}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
        <span className="truncate">{displayTitle}</span>
      </button>

      {open && (
        <div className="absolute top-full left-0 max-md:left-4 mt-1 w-64 bg-panel border border-edge rounded-lg shadow-xl z-50 py-1 max-h-72 overflow-y-auto">
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
                {/* Wraps instead of truncating: the menu is a fixed 256px wide,
                    so a one-line title cut most names short, and a hover
                    `title` tooltip never shows on touch. */}
                <div className="[overflow-wrap:anywhere]">
                  {conv.title ?? `Conversation ${conv.id}`}
                </div>
                <div className="text-[10px] text-ink-faint mt-0.5">
                  {SCOPE_OPTIONS.find((s) => s.value === conv.scope)?.label ?? conv.scope}
                  {" \u00b7 "}
                  {conversationDayLabel(conv.updated_at)}
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

// ─── Conversation controls (scope pill · picker · New Conversation) ──
//
// Rendered twice by ChatInterface with the same props: in the fixed header row
// at phone width, and at the top of the transcript from md up. Presentational
// only — every handler is the parent's. Module-level on purpose: a component
// defined inside ChatInterface would remount on each of its renders.
function ConversationControls({
  scopeLabel,
  modelLabel,
  conversations,
  currentId,
  onSelect,
  onNew,
  onDelete,
  fallbackTitle,
}: {
  scopeLabel: string;
  /** The model the conversation runs on ("Opus 5.5"), or null to show nothing. */
  modelLabel: string | null;
  conversations: ChatConversation[];
  currentId: number | null;
  onSelect: (conv: ChatConversation) => void;
  onNew: () => void;
  onDelete: (conv: ChatConversation) => void;
  fallbackTitle: string | null;
}) {
  return (
    <>
      {/* min-w-0 on the left group + the picker root: without it the
          flex-child min-width:auto floor keeps the group at its content
          width (scope pill + 200px title) and the long-title case
          overpaints the New Conversation button at 390px viewports. */}
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
            currentId={currentId}
            onSelect={onSelect}
            onNew={onNew}
            onDelete={onDelete}
            fallbackTitle={fallbackTitle}
          />
        )}
      </div>
      <button
        onClick={onNew}
        className="relative pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-3 pointer-coarse:after:-inset-x-1 text-xs text-ink-faint hover:text-ink-dim transition-colors focus-ring shrink-0"
      >
        New Conversation
      </button>
      {/* The model the conversation is locked to (2026-11-13): quiet, one
          line of its own under the controls (the header rows wrap), so the
          scope pill, the title picker and New Conversation keep the room
          they had at every width. A long label is cut with the whole text in
          its tooltip. */}
      {modelLabel && (
        <span
          className="basis-full order-last min-w-0 truncate whitespace-nowrap text-[11px] text-ink-faint -mt-1"
          title={`Model: ${modelLabel}`}
        >
          <span className="sr-only">Model: </span>
          {modelLabel}
        </span>
      )}
    </>
  );
}

// ─── Main component ──────────────────────────────────────────────

interface ChatInterfaceProps {
  pathname: string;
}

export function ChatInterface({ pathname }: ChatInterfaceProps) {
  const [scope, setScope] = useState<ChatScope>("all");
  const [modelFamily, setModelFamily] = useState<ChatModelFamily>(DEFAULT_CHAT_MODEL_FAMILY);
  const [inputText, setInputText] = useState("");
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [loadedInitial, setLoadedInitial] = useState(false);
  const [deletePending, setDeletePending] = useState<ChatConversation | null>(null);
  const { toast } = useToast();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  // B21: follow the stream only while the reader is near the bottom.
  const followBottomRef = useRef(true);
  const lastScrollTopRef = useRef(0);

  // R4-12: the open conversation's id, written synchronously wherever it
  // changes (openConversation) and where a response header names it
  // (chatFetch). The per-call body reads it, so a follow-up sent in the frame
  // between a turn's finish and the adoption effect still carries it.
  const conversationIdRef = useRef<number | null>(null);
  // R4-4: when the last send began (Stop ignores clicks just after it).
  const stopGuardFromRef = useRef<number | null>(null);

  // Quick actions from the pathname. The page itself is described by the
  // SERVER from the path sent in the request body (Contract A).
  const quickActions = useMemo(() => getQuickActions(pathname), [pathname]);

  // Stable, api-only transport. Do NOT put request body (scope / conversationId
  // / page) here: `useChat` captures the transport from the FIRST render
  // and ignores later transport objects, so a body baked in here freezes at the
  // mount-time values (scope "all") — the scope selector then silently never
  // reaches /api/chat (the 2026-06-15 leak: a "Vanguard Taxable" chat ran
  // unscoped). The live scope is passed per-call via sendMessage/regenerate's
  // `body` instead (see currentRequestBody below), built at send time.
  //
  // `fetch: apiFetch` is what carries the `X-CSRF-Token` header the #35 trust
  // boundary requires on POST (lib/auth/verify-request.ts) — the SDK's own
  // fetch never sets it, so every send 401'd. It must be the WRAPPER, not a
  // token baked into `headers` here: the same first-render freeze above would
  // pin a stale/absent token forever, whereas apiFetch reads the `vgs_csrf`
  // cookie inside each call.
  //
  // chatFetch also records which conversation the server used for THIS turn:
  // /api/chat returns it in `X-Conversation-Id` on the stream response. A
  // request that fails before the server creates a row (network error, 4xx,
  // 5xx) carries no header, so the id stays null and nothing is adopted. The
  // box lives in the same memo as the transport, so the frozen transport and
  // the effect below always share it.
  //
  // `generation` (B17) counts conversation switches: New Conversation,
  // loading a conversation and deleting the open one bump it. A request
  // records the generation it was sent in (`sentGeneration`), and the
  // adoption effect ignores a header from an older generation.
  const { transport, turn, sendAutomaticallyWhen } = useMemo(() => {
    // Plain mutable box, written only inside the fetch call and the switch
    // handlers (never in render).
    const turn: {
      conversationId: number | null;
      generation: number;
      sentGeneration: number | null;
      autoContinuations: number;
    } = { conversationId: null, generation: 0, sentGeneration: null, autoContinuations: 0 };
    const chatFetch: ApiFetch = async (input, init) => {
      turn.sentGeneration = turn.generation;
      turn.conversationId = null;
      const res = await apiFetch(input, init);
      const id = Number(res.headers.get("X-Conversation-Id"));
      turn.conversationId = Number.isInteger(id) && id > 0 ? id : null;
      const adopt = decideTurnAdoption({
        openConversationId: conversationIdRef.current,
        turnConversationId: turn.conversationId,
        turnGeneration: turn.sentGeneration,
        currentGeneration: turn.generation,
      });
      if (adopt !== null) conversationIdRef.current = adopt;
      return res;
    };
    // R4-10: the SDK's completeness check, capped per owner action (send,
    // retry, approval click), so a continuation that never carries the tool
    // result cannot resend forever. Stable: useChat keeps the first one.
    const sendAutomaticallyWhen = ({ messages }: { messages: UIMessage[] }) => {
      const go = shouldAutoContinue(
        lastAssistantMessageIsCompleteWithApprovalResponses({ messages }),
        turn.autoContinuations,
      );
      if (go) turn.autoContinuations += 1;
      return go;
    };
    return {
      transport: new DefaultChatTransport({ api: "/api/chat", fetch: chatFetch }),
      turn,
      sendAutomaticallyWhen,
    };
  }, []);

  const {
    messages,
    status,
    error,
    sendMessage,
    regenerate,
    setMessages,
    clearError,
    stop,
    addToolApprovalResponse,
  } = useChat({
    transport,
    sendAutomaticallyWhen,
  });

  // Per-call request body — built at the moment of each send so the CURRENT
  // scope, conversation, and page path reach the server (see transport note
  // above). Never reads the turn box. The server resolves the path itself
  // (Contract A); no client-written page text is sent. The model class is
  // the open conversation's known class, or the picker's for a new chat
  // (requestModelFamily): the server uses it only when it creates a row (a
  // new chat, or one deleted elsewhere) and reads an existing row's own.
  const currentRequestBody = useCallback(() => {
    const family = requestModelFamily(conversations, conversationIdRef.current, modelFamily);
    return {
      scope,
      conversationId: conversationIdRef.current,
      page: { path: pathname },
      ...(family ? { modelFamily: family } : {}),
    };
  }, [scope, pathname, modelFamily, conversations]);

  // The one writer of the open conversation (state for the UI, ref for the
  // body; R4-12).
  const openConversation = useCallback((id: number | null) => {
    conversationIdRef.current = id;
    setConversationId(id);
  }, []);

  const isStreaming = status === "streaming" || status === "submitted";

  // The header's title until the list row carries one (the first turn was
  // stopped, or the list refresh beat the server's title write). Shown as
  // written, like any title (owner ruling 2026-11-12).
  const fallbackTitle = useMemo(() => conversationTitleFromMessages(messages) || null, [messages]);

  // Start a new turn generation (B17): a header that arrives later for a
  // request sent before this point is never adopted.
  const beginNewGeneration = useCallback(() => {
    turn.generation += 1;
    turn.conversationId = null;
    turn.sentGeneration = null;
  }, [turn]);
  const isLocked = messages.length > 0;
  const scopeLabel =
    SCOPE_OPTIONS.find((s) => s.value === scope)?.label ?? "All Accounts";

  // Fetch conversation list
  const fetchConversations = useCallback(async () => {
    try {
      const res = await fetch("/api/chat/conversations");
      const body = await res.json().catch(() => null);
      if (res.ok && body?.success === true) {
        const list: ChatConversation[] = body.data?.conversations ?? [];
        setConversations(list);
        return list;
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
      const payload = await res.json().catch(() => null);
      if (res.ok && payload?.success === true) {
        const dbMessages: ChatMessage[] = payload.data?.messages ?? [];
        const uiMessages = dbMessages.map(dbMessageToUIMessage);
        // B16: stop a streaming reply before showing the other conversation,
        // or the SDK keeps appending it there. Only now (R4-8): a failed
        // load leaves the current reply running.
        if (isStreaming) await stop();
        beginNewGeneration();
        clearError();
        followBottomRef.current = true;
        setMessages(uiMessages);
        openConversation(conv.id);
        setScope((conv.scope as ChatScope) || "all");
        return;
      }
      const reason =
        typeof payload?.error === "string" ? payload.error : `the server returned HTTP ${res.status}`;
      toast(`Couldn't open that conversation: ${reason}`, "error");
    } catch {
      toast(networkFailureMessage("open that conversation"), "error");
    }
  }, [setMessages, clearError, isStreaming, stop, beginNewGeneration, openConversation, toast]);

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
      // Adopt the conversation the server named on this turn's response (see
      // chatFetch). Never the head of the list: it is sorted by last update
      // and shared across devices, so after a first-turn failure it is an
      // unrelated old thread and Retry would save into it.
      //
      // B17: adopt synchronously, BEFORE the list refresh, so a follow-up
      // sent while the list loads already carries the id; and only for a
      // turn sent in the current generation (decideTurnAdoption).
      const adopt = decideTurnAdoption({
        openConversationId: conversationId,
        turnConversationId: turn.conversationId,
        turnGeneration: turn.sentGeneration,
        currentGeneration: turn.generation,
      });
      if (adopt !== null) openConversation(adopt);
      void fetchConversations();
    }
    prevStatusRef.current = status;
  }, [status, conversationId, fetchConversations, turn, openConversation]);

  // B21: a scroll event decides whether the stream keeps following.
  const handleMessagesScroll = useCallback(() => {
    const list = messagesScrollRef.current;
    if (!list) return;
    followBottomRef.current = nextFollowBottom(followBottomRef.current, list, lastScrollTopRef.current);
    lastScrollTopRef.current = list.scrollTop;
  }, []);

  // Auto-scroll on new content
  useEffect(() => {
    // Only while the reader is near the bottom (B21): scrolling up to reread
    // a table must not snap back on every streamed token.
    if (!followBottomRef.current) return;
    // Scroll the container itself, never an element into view: that moves the
    // browser's sequential-focus starting point into the chat, so the first
    // Tab skipped the "Skip to main content" link.
    const list = messagesScrollRef.current;
    list?.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
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
    followBottomRef.current = true;
    turn.autoContinuations = 0;
    stopGuardFromRef.current = Date.now();
    await sendMessage({ text }, { body: currentRequestBody() });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  }

  // R4-4: the second click of a double-click on Send lands on Stop, which
  // takes Send's place; ignore clicks just after a send began.
  const handleStopClick = useCallback(() => {
    if (shouldIgnoreStopClick(stopGuardFromRef.current, Date.now())) return;
    void stop();
  }, [stop]);

  function handleRetry() {
    turn.autoContinuations = 0;
    void regenerate({ body: currentRequestBody() });
  }

  function handleNewConversation() {
    if (isStreaming) stop();
    beginNewGeneration();
    followBottomRef.current = true;
    clearError();
    setMessages([]);
    openConversation(null);
    setScope("all");
    setModelFamily(DEFAULT_CHAT_MODEL_FAMILY);
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
      const result = await readMutationResult(res);
      // R4-9: a 404 means it is already gone (another device, an earlier
      // click); drop the stale row instead of reporting a failure.
      const alreadyGone = !result.ok && result.status === 404;
      if (!result.ok && !alreadyGone) {
        // The dialog already closed — without this the conversation just
        // stays in the list and the delete looks like it never happened.
        toast(`Couldn't delete the conversation: ${result.message}`, "error");
        return;
      }
      if (alreadyGone) toast("That conversation no longer exists.", "info");
      setConversations((list) => list.filter((c) => c.id !== conv.id));

      // If the deleted conversation is currently loaded, reset to empty state
      if (conv.id === conversationId) {
        if (isStreaming) stop();
        beginNewGeneration();
        clearError();
        setMessages([]);
        openConversation(null);
        setModelFamily(DEFAULT_CHAT_MODEL_FAMILY);
      }
      await fetchConversations();
    } catch {
      toast(networkFailureMessage("delete the conversation"), "error");
    }
  }, [deletePending, conversationId, fetchConversations, isStreaming, setMessages, clearError, stop, toast, beginNewGeneration, openConversation]);

  // Contract C: the owner's answer on a drafted note. The SDK resends on its
  // own once every approval has an answer (sendAutomaticallyWhen), with these
  // options, so the CURRENT per-call body travels with the continuation.
  const answerNoteApproval = useCallback((approvalId: string, approved: boolean) => {
    followBottomRef.current = true;
    turn.autoContinuations = 0;
    void addToolApprovalResponse({
      id: approvalId,
      approved,
      reason: approved ? undefined : "Owner chose not to save",
      options: { body: currentRequestBody() },
    });
  }, [addToolApprovalResponse, currentRequestBody, turn]);

  function handleQuickAction(prompt: string) {
    setInputText(prompt);
    inputRef.current?.focus();
  }

  return (
    <div className="flex flex-col h-[calc(100dvh-12rem)] md:h-full">
      {/* md:h-full (on the root above): from md up the drawer / rail gives
          this a definite height (ChatDrawer's h-[calc(100%-49px)] wrapper),
          so fill it — the viewport calc left a blank band under the composer.
          Below md the calc stays: it is what keeps the composer above the
          bottom nav. */}
      {/* Fixed conversation header (phone width): outside the transcript
          scroller, so the scope pill, the picker and New Conversation stay
          under the drawer's title bar however long the conversation is.
          `relative` anchors the picker's menu to this row (see
          ConversationHistory). */}
      {isLocked && (
        <div className="md:hidden relative shrink-0 flex flex-wrap items-center justify-between gap-2 px-4 py-3 mb-3 border-b border-edge">
          <ConversationControls
            scopeLabel={scopeLabel}
            modelLabel={openConversationModelLabel(conversations, conversationId, modelFamily, liveModelLabel(messages))}
            conversations={conversations}
            currentId={conversationId}
            onSelect={loadConversation}
            onNew={handleNewConversation}
            onDelete={handleDeleteConversation}
            fallbackTitle={fallbackTitle}
          />
        </div>
      )}

      {/* Messages area */}
      <div
        ref={messagesScrollRef}
        onScroll={handleMessagesScroll}
        className="flex-1 overflow-y-auto space-y-4 pb-4"
        aria-live="polite"
        aria-label="Chat messages"
      >
        {/* Conversation header (shown when conversation is active) — from md
            up it stays at the top of the transcript, as before. */}
        {isLocked && (
          <div className="hidden md:flex flex-wrap items-center justify-between gap-2 pb-3 mb-3 border-b border-edge">
            <ConversationControls
              scopeLabel={scopeLabel}
              modelLabel={openConversationModelLabel(conversations, conversationId, modelFamily, liveModelLabel(messages))}
              conversations={conversations}
              currentId={conversationId}
              onSelect={loadConversation}
              onNew={handleNewConversation}
              onDelete={handleDeleteConversation}
              fallbackTitle={fallbackTitle}
            />
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
                        ? `border-gold ${CHIP_TONE_TEXT.gold}`
                        : "border-edge text-ink-dim hover:text-ink hover:border-edge-strong"
                    }`}
                    style={
                      scope === opt.value
                        ? {
                            // color deliberately NOT set inline — it would
                            // override the checked gold text token.
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

              {/* Model class for this conversation (2026-11-13): Sonnet is
                  preselected each time; the choice locks at the first
                  message, so the row shows only before a conversation
                  exists. Same pill as the scope bar above. */}
              {conversationId === null && (
                <div
                  className="flex flex-nowrap justify-center items-center gap-2 mb-6"
                  role="group"
                  aria-label="Model for this conversation"
                >
                  <span className="text-[11px] text-ink-faint">Model</span>
                  {CHAT_MODEL_FAMILIES.map((family) => (
                    <button
                      key={family}
                      type="button"
                      onClick={() => setModelFamily(family)}
                      aria-pressed={modelFamily === family}
                      className={`px-4 py-1.5 rounded-full text-xs border whitespace-nowrap transition-[color,border-color] focus-ring ${
                        modelFamily === family
                          ? `border-gold ${CHIP_TONE_TEXT.gold}`
                          : "border-edge text-ink-dim hover:text-ink hover:border-edge-strong"
                      }`}
                      style={
                        modelFamily === family
                          ? {
                              // color deliberately NOT set inline — it would
                              // override the checked gold text token.
                              background: "rgba(201,164,78,0.2)",
                              borderColor: "#c9a44e",
                            }
                          : undefined
                      }
                    >
                      {chatFamilyName(family)}
                    </button>
                  ))}
                </div>
              )}

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
        {messages.map((msg, index) => {
          const isLive = isStreaming && index === messages.length - 1;
          const endedInError = status === "error" && index === messages.length - 1;
          const settled =
            msg.role === "assistant" && !isLive
              ? settledAssistantView(msg, { endedInError, outcomeNotice: turnOutcomeNotice(msg) })
              : null;
          if (settled?.kind === "hidden") return null;
          const notice = settled?.kind === "notice" ? settled.text : null;
          // RF-7: a cut-off turn that wrote some text keeps the text and
          // says, on a quieter line under it, that it stopped early.
          const trailingNotice = settled?.kind === "parts" ? (settled.trailingNotice ?? null) : null;
          return (
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
                  {/* Contract B: a finished turn with no written reply shows
                      why, in place of an empty bubble. */}
                  {notice ? (
                    <p className="text-ink-dim">{notice}</p>
                  ) : (
                    renderAssistantParts(msg.parts, {
                      onNoteAnswer: answerNoteApproval,
                      busy: isStreaming,
                      live: isLive,
                      inLastMessage: index === messages.length - 1,
                    })
                  )}
                  {trailingNotice && <p className="mt-2 text-ink-dim">{trailingNotice}</p>}
                  {/* Copy button — only show if there's actual text content;
                      it copies the text parts only, never the notice. */}
                  {!isLive && !notice && msg.parts.some(
                    (p) => p.type === "text" && (p as { text: string }).text
                  ) && <CopyButton message={msg} />}
                </>
              )}
            </div>
          </div>
          );
        })}

        {/* Error display */}
        {error && (
          <div className="flex justify-start">
            <div className="max-w-[80%] rounded-xl px-4 py-3 text-sm bg-down-tint border border-down/20 text-down">
              {chatErrorText(error)}
            </div>
          </div>
        )}

        {/* Retry button on error */}
        {status === "error" && messages.length > 0 && (
          <div className="flex justify-start">
            <button
              onClick={handleRetry}
              className="px-3 py-1.5 text-xs text-ink-dim border border-edge rounded-lg hover:text-ink hover:border-edge-strong transition-[color,border-color] focus-ring"
            >
              Retry
            </button>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area — max-md:px-4 gives the composer the drawer's 16px inset
          on a phone (Send used to touch the screen edge); the border-t still
          spans the full width, like the header's border-b. */}
      <div className="border-t border-edge pt-4 max-md:px-4">
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
          {/* Contract B: Stop replaces Send while a reply is pending. */}
          {isStreaming ? (
            <button
              type="button"
              onClick={handleStopClick}
              aria-label="Stop the answer"
              className="px-5 py-3 rounded-xl border border-edge text-ink font-medium text-sm hover:border-edge-strong transition-[border-color,scale] active:scale-[0.96] focus-ring"
            >
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!inputText.trim()}
              aria-label="Send message"
              title={!inputText.trim() ? "Type a message first" : undefined}
              className={`px-5 py-3 rounded-xl ${GOLD_FILL_CLASSES} font-medium text-sm hover:brightness-110 transition-[filter,scale] active:scale-[0.96] disabled:opacity-40 disabled:hover:brightness-100 disabled:cursor-not-allowed focus-ring`}
            >
              Send
            </button>
          )}
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
