"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function RecomputeButton({
  endpoint,
  label,
}: {
  endpoint: string;
  label: string;
}) {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function handleClick() {
    setIsLoading(true);
    setResult(null);
    try {
      const res = await fetch(endpoint, { method: "POST" });
      const data = await res.json();
      if (data.success) {
        setResult("Done");
        router.refresh();
      } else {
        setResult(`Error: ${data.error}`);
      }
    } catch {
      setResult("Failed to connect");
    } finally {
      setIsLoading(false);
      setTimeout(() => setResult(null), 3000);
    }
  }

  return (
    <div className="flex items-center gap-3">
      {result && (
        <span
          className={`text-xs font-mono ${
            result.startsWith("Error") || result === "Failed to connect"
              ? "text-down"
              : "text-up"
          }`}
        >
          {result}
        </span>
      )}
      <button
        onClick={handleClick}
        disabled={isLoading}
        className="px-4 py-2 rounded-lg bg-raised border border-edge text-sm font-medium text-ink-dim hover:text-ink hover:border-edge-strong transition-all disabled:opacity-50"
      >
        {isLoading ? "Computing..." : label}
      </button>
    </div>
  );
}
