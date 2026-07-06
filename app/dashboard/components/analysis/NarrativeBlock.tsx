"use client";

import { useEffect, useState } from "react";
import { PrivateText } from "@/lib/privacy/components";

interface Props {
  scope: string;
  surfaceKey: "factor-analysis" | "risk-metrics" | "position-risk" | "factor-heatmap" | "defense";
}

export function NarrativeBlock({ scope, surfaceKey }: Props) {
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetch(`/api/analysis/narrative?scope=${scope}&surface=${surfaceKey}`)
      .then((r) => r.json())
      .then((data) => {
        if (!alive) return;
        if (data.success) setText(data.narrativeMd);
        else setError(data.error ?? "Failed to load narrative");
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : "Failed to load narrative"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [scope, surfaceKey]);

  if (loading) return <div className="text-xs text-ink-faint italic mt-2">Loading narrative…</div>;
  if (error || !text) return null; // graceful no-render on error

  return (
    <div className="text-sm text-ink-dim italic border-l-2 border-gold/40 pl-3 my-3 leading-relaxed">
      {/* AI narrative embeds portfolio-derived figures at generation time, so
          the only correct mask is the whole prose block (same rule as the
          interpretation sentences). */}
      <PrivateText>{text}</PrivateText>
    </div>
  );
}
