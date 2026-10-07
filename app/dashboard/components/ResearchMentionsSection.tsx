"use client";

import { useState } from "react";
import Link from "next/link";
import type { ResearchMention } from "@/lib/queries/research";
import { Section } from "./Section";
import { EmptySection } from "./EmptySection";
import { Chip, type ChipTone } from "./Chip";
import { NewsletterArticleFrame } from "./NewsletterArticleFrame";
import {
  displayableMentionContext,
  filterHubMentions,
  mentionsHeading,
} from "@/lib/research/mention-context";
import { trimEmailFooter, htmlHidesStoredText, visibleTextLength } from "@/lib/gmail/sanitize";

interface ArticleDetail {
  id: number;
  subject: string;
  received_at: string;
  source_name: string;
  raw_text: string;
  raw_html: string | null;
  source_url: string | null;
}

function sentimentTone(s: string | null): ChipTone {
  if (s === "bullish" || s === "positive") return "up";
  if (s === "bearish" || s === "negative") return "down";
  return "neutral";
}

export function ResearchMentionsSection({
  ticker,
  mentions,
  totalCount,
}: {
  ticker: string;
  mentions: ResearchMention[];
  /** Every processed, relevant mention on file for this security — not the
   *  handful loaded here. Without it the heading prints no count at all. */
  totalCount?: number | null;
}) {
  const filtered = filterHubMentions(ticker, mentions);

  if (mentions.length === 0) return null;
  if (filtered.length === 0) {
    return (
      <EmptySection
        title="Research Mentions"
        reason={`The latest newsletters linked to ${ticker} only matched it inside a link or a longer word, so none is shown.`}
      />
    );
  }

  const { title, subtitle } = mentionsHeading(filtered.length, totalCount);

  return (
    <Section
      title={title}
      subtitle={subtitle}
      action={
        <Link
          href={`/dashboard/research?view=feeds&symbol=${encodeURIComponent(ticker)}`}
          className="text-xs font-medium text-blue hover:brightness-110 transition-colors"
        >
          All feeds →
        </Link>
      }
    >
      <div className="divide-y divide-edge">
        {filtered.map((m) => (
          <MentionRow key={m.article_id} mention={m} />
        ))}
      </div>
    </Section>
  );
}

function MentionRow({ mention }: { mention: ResearchMention }) {
  const [expanded, setExpanded] = useState(false);
  const [article, setArticle] = useState<ArticleDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    const next = !expanded;
    setExpanded(next);
    if (next && !article && !loading) {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/research/articles/${mention.article_id}`);
        const json = await res.json();
        if (!res.ok || !json.success) {
          setError(json.error ?? "Failed to load article");
        } else {
          setArticle(json.data as ArticleDetail);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Network error");
      } finally {
        setLoading(false);
      }
    }
  }

  // Context lines under 15 chars are rarely useful (often single words like
  // a proper-noun match). Hide them from the row.
  const excerpt = displayableMentionContext(mention.mention_context);
  const showContext = excerpt != null && excerpt.length >= 15;

  return (
    <div className="px-5 py-3">
      <button
        type="button"
        onClick={toggle}
        className="w-full text-left group"
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <span
            className="font-mono uppercase font-semibold text-gold-ink"
            style={{ fontSize: "11px", letterSpacing: "0.05em" }}
          >
            {mention.source_name}
          </span>
          <span className="text-xs text-ink-faint font-mono">
            {mention.received_at.slice(0, 10)}
          </span>
          {mention.sentiment && (
            <Chip tone={sentimentTone(mention.sentiment)} size="xs">
              {mention.sentiment}
            </Chip>
          )}
          <span className="ml-auto text-[11px] text-ink-faint group-hover:text-ink-dim transition-colors">
            {expanded ? "collapse ▴" : "read ▾"}
          </span>
        </div>
        <p className="text-sm text-ink font-medium">{mention.subject}</p>
        {showContext && (
          <p className="text-xs text-ink-dim italic mt-1 line-clamp-3">
            &quot;…{excerpt}…&quot;
          </p>
        )}
      </button>

      {expanded && (
        <div className="mt-3 pt-3 border-t border-edge/50">
          {loading && (
            <p className="text-[11px] text-ink-faint italic">Loading article…</p>
          )}
          {error && <p className="text-[11px] text-down font-medium">{error}</p>}
          {article && <ArticleBody article={article} />}
        </div>
      )}
    </div>
  );
}

function ArticleBody({ article }: { article: ArticleDetail }) {
  // Body choice, identical to the Feeds reader (ResearchFeedsView.handleExpand)
  // and single-sourced on htmlHidesStoredText.
  //
  // A bare `article.raw_html ? frame : text` used to win on truthiness alone.
  // Substack-style senders store HTML that is little more than an inbox
  // preheader — two words plus thousands of INVISIBLE padding characters —
  // while raw_text holds the whole article, so the reader opened a ~490px
  // blank iframe on that entire class of email (a whole class of stored emails). QA 2026-09-07.
  const text = article.raw_text ? trimEmailFooter(article.raw_text) : null;
  const trimmedHtml = article.raw_html ? trimEmailFooter(article.raw_html) : null;
  const html = trimmedHtml && htmlHidesStoredText(trimmedHtml, text) ? null : trimmedHtml;
  // A raw_text that survives trimEmailFooter as a non-empty string can still
  // be pure preheader padding (invisible Unicode chars) — truthiness alone
  // rendered a blank div instead of falling through to the empty-state copy
  // below. Gate on rendered length, not string length.
  const hasVisibleText = text != null && visibleTextLength(text) > 0;

  return (
    <div>
      {article.source_url && (
        <a
          href={article.source_url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block text-[11px] font-medium text-blue hover:brightness-110 mb-3"
        >
          Open on publisher site ↗
        </a>
      )}
      {html ? (
        // Same pattern as ResearchFeedsView — a sandboxed iframe, because an
        // email's document-global <style> block restyles the whole app when
        // injected via dangerouslySetInnerHTML (deep-QA style-leak finding).
        <NewsletterArticleFrame html={html} />
      ) : hasVisibleText ? (
        <div className="prose-reader whitespace-pre-wrap">{text}</div>
      ) : (
        // Say it, rather than leaving an empty pane behind the "read" chip.
        <p className="text-[11px] text-ink-faint italic">
          No article body was stored for this email — open it on the publisher
          site instead.
        </p>
      )}
    </div>
  );
}
