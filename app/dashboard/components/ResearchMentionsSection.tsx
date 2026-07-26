"use client";

import { useState } from "react";
import Link from "next/link";
import type { ResearchMention } from "@/lib/queries/research";
import { Section } from "./Section";
import { Chip, type ChipTone } from "./Chip";
import { NewsletterArticleFrame } from "./NewsletterArticleFrame";

interface ArticleDetail {
  id: number;
  subject: string;
  received_at: string;
  source_name: string;
  raw_text: string;
  raw_html: string | null;
  source_url: string | null;
}

/**
 * A mention_context is a false-positive URL-fragment when the extractor
 * matched the ticker inside anchor-text / asset paths (e.g.
 * "net/assets/images/resources//section1."). Dropping these surfaces only
 * the mentions that actually refer to the company.
 */
function isUrlFragmentContext(ctx: string | null): boolean {
  if (!ctx) return false;
  const t = ctx.trim();
  if (/:\/\/|\/assets\/|<img|\.(png|jpg|jpeg|gif|css|svg|woff)/i.test(t)) return true;
  if (!/\s/.test(t) && /[/_]/.test(t)) return true;
  return false;
}

/**
 * True when the ticker appears only as a substring of a larger word in
 * the mention context / subject (e.g. "HOOD" inside "likelihood",
 * "NET" inside "internet").
 */
function lacksWordBoundaryMatch(
  ticker: string,
  ctx: string | null,
  subject: string,
): boolean {
  if (!ctx) return false;
  const escaped = ticker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\b${escaped}\\b`, "i");
  if (re.test(ctx)) return false;
  if (re.test(subject)) return false;
  return true;
}

function sentimentTone(s: string | null): ChipTone {
  if (s === "bullish" || s === "positive") return "up";
  if (s === "bearish" || s === "negative") return "down";
  return "neutral";
}

export function ResearchMentionsSection({
  ticker,
  mentions,
}: {
  ticker: string;
  mentions: ResearchMention[];
}) {
  const filtered = mentions.filter((m) => {
    if (isUrlFragmentContext(m.mention_context)) return false;
    if (lacksWordBoundaryMatch(ticker, m.mention_context, m.subject)) return false;
    return true;
  });

  if (filtered.length === 0) return null;

  const subtitle =
    mentions.length > filtered.length
      ? `${filtered.length} of ${mentions.length} — filtered`
      : undefined;

  return (
    <Section
      title={`Research Mentions · ${filtered.length}`}
      subtitle={subtitle}
      action={
        <Link
          href="/dashboard/research?view=feeds"
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
  const showContext =
    mention.mention_context != null &&
    mention.mention_context.trim().length >= 15;

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
            &quot;…{mention.mention_context}…&quot;
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
      {article.raw_html ? (
        // Same pattern as ResearchFeedsView — a sandboxed iframe, because an
        // email's document-global <style> block restyles the whole app when
        // injected via dangerouslySetInnerHTML (deep-QA style-leak finding).
        <NewsletterArticleFrame html={article.raw_html} />
      ) : (
        <div className="prose-reader whitespace-pre-wrap">{article.raw_text}</div>
      )}
    </div>
  );
}
