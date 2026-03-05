"use client";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="rounded-xl border border-down/30 bg-down-tint p-8 max-w-md text-center">
        <div className="w-12 h-12 rounded-full bg-down/10 flex items-center justify-center mx-auto mb-4">
          <svg
            className="w-6 h-6 text-down"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
            />
          </svg>
        </div>
        <h2 className="text-lg font-medium text-ink mb-2">
          Something went wrong
        </h2>
        <p className="text-sm text-ink-dim mb-6">
          {error.message || "An unexpected error occurred while loading this page."}
        </p>
        <button
          onClick={reset}
          className="px-5 py-2.5 rounded-lg bg-gold text-canvas font-medium text-sm hover:brightness-110 transition-all"
        >
          Try Again
        </button>
      </div>
    </div>
  );
}
