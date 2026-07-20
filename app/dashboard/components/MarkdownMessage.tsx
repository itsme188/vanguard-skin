"use client";

import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";

const components: Components = {
  p({ node, ...props }) {
    return <p className="mb-3 last:mb-0" {...props} />;
  },
  strong({ node, ...props }) {
    return <strong className="font-semibold text-ink" {...props} />;
  },
  em({ node, ...props }) {
    return <em className="italic text-ink-dim" {...props} />;
  },
  h1({ node, ...props }) {
    return (
      <h1
        className="text-base font-semibold text-ink mt-4 mb-2 first:mt-0"
        {...props}
      />
    );
  },
  h2({ node, ...props }) {
    return (
      <h2
        className="text-sm font-semibold text-ink mt-3 mb-1.5 first:mt-0"
        {...props}
      />
    );
  },
  h3({ node, ...props }) {
    return (
      <h3
        className="text-sm font-medium text-ink-dim mt-2 mb-1 first:mt-0"
        {...props}
      />
    );
  },
  ul({ node, ...props }) {
    return <ul className="list-disc list-outside pl-4 mb-3 space-y-0.5" {...props} />;
  },
  ol({ node, ...props }) {
    return <ol className="list-decimal list-outside pl-4 mb-3 space-y-0.5" {...props} />;
  },
  li({ node, ...props }) {
    return <li className="text-ink leading-relaxed" {...props} />;
  },
  code({ node, className, children, ...props }) {
    // Fenced code blocks have className="language-*" from remark
    const isBlock = /language-/.test(className || "");
    if (isBlock) {
      return (
        <code className="font-mono text-ink-dim whitespace-pre" {...props}>
          {children}
        </code>
      );
    }
    return (
      <code
        className="font-mono text-[0.85em] bg-raised border border-edge rounded px-1 py-0.5 text-gold-ink"
        {...props}
      >
        {children}
      </code>
    );
  },
  pre({ node, ...props }) {
    return (
      <pre
        className="rounded-lg bg-canvas border border-edge p-3 overflow-x-auto mb-3 text-xs"
        {...props}
      />
    );
  },
  table({ node, ...props }) {
    return (
      <div className="overflow-x-auto mb-3">
        <table className="w-full border-collapse text-xs" {...props} />
      </div>
    );
  },
  thead({ node, ...props }) {
    return <thead {...props} />;
  },
  th({ node, ...props }) {
    return (
      <th
        className="text-left text-[10px] uppercase tracking-widest text-ink-faint font-medium border-b border-edge pb-1 pr-3"
        {...props}
      />
    );
  },
  td({ node, ...props }) {
    return <td className="py-1.5 pr-3 text-ink tabular-nums" {...props} />;
  },
  tr({ node, ...props }) {
    return <tr className="border-b border-edge/50 last:border-0" {...props} />;
  },
  a({ node, ...props }) {
    return (
      <a
        className="text-gold-ink underline underline-offset-2 hover:brightness-125"
        target="_blank"
        rel="noopener noreferrer"
        {...props}
      />
    );
  },
  blockquote({ node, ...props }) {
    return (
      <blockquote
        className="border-l-2 border-edge-strong pl-3 italic text-ink-dim mb-3"
        {...props}
      />
    );
  },
  hr({ node, ...props }) {
    return <hr className="border-edge my-3" {...props} />;
  },
};

export function MarkdownMessage({ content }: { content: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={components}>
      {content}
    </Markdown>
  );
}
