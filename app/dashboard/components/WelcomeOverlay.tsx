"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useElectron } from "@/lib/hooks/useElectron";

/**
 * First-run onboarding overlay for the Electron app.
 * Guides new users through initial setup: API key, data import, TWS connection.
 * Only renders in Electron and only on first launch (before firstRunComplete is set).
 */
export function WelcomeOverlay() {
  const { isElectron, api } = useElectron();
  const [show, setShow] = useState(false);
  const router = useRouter();

  useEffect(() => {
    if (!api) return;
    api.isFirstRun().then((firstRun) => {
      if (firstRun) setShow(true);
    });
  }, [api]);

  if (!isElectron || !show) return null;

  async function handleGetStarted() {
    if (api) {
      await api.completeFirstRun();
    }
    setShow(false);
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-canvas/95 backdrop-blur-md" />

      {/* Card */}
      <div className="relative w-full max-w-md rounded-xl border border-edge bg-panel shadow-2xl p-8 space-y-6">
        {/* Header */}
        <div className="text-center space-y-2">
          <h1 className="text-3xl text-gold tracking-tight font-medium">
            Vanguard Dashboard
          </h1>
          <p className="text-sm text-ink-dim">
            Your local-first portfolio tracker
          </p>
        </div>

        {/* Setup steps */}
        <div className="space-y-4">
          <SetupStep
            number={1}
            title="Configure your API key"
            description="Required for AI chat and PDF import. Open Settings to enter your Anthropic API key."
            action={
              <button
                onClick={() => window.dispatchEvent(new Event("open-settings"))}
                className="px-3 py-1 text-xs font-medium rounded-lg bg-gold/20 text-gold-ink hover:bg-gold/30 transition-colors"
              >
                Open Settings
              </button>
            }
          />

          <SetupStep
            number={2}
            title="Import your data"
            description="Drop Vanguard PDFs, IBKR CSVs, or cost-basis CSVs on the Import tab."
            action={
              <button
                onClick={() => {
                  handleGetStarted();
                  router.push("/dashboard/import");
                }}
                className="px-3 py-1 text-xs font-medium rounded-lg bg-raised border border-edge text-ink-dim hover:text-ink hover:border-edge-strong transition-colors"
              >
                Go to Import
              </button>
            }
          />

          <SetupStep
            number={3}
            title="Connect to TWS"
            description="Optional — if you have IBKR Trader Workstation running, the app will auto-connect for live data."
            optional
          />
        </div>

        {/* Get Started */}
        <button
          onClick={handleGetStarted}
          className="w-full py-2.5 text-sm font-medium rounded-lg bg-gold text-canvas hover:bg-gold/90 transition-colors"
        >
          Get Started
        </button>
      </div>
    </div>
  );
}

function SetupStep({
  number,
  title,
  description,
  action,
  optional,
}: {
  number: number;
  title: string;
  description: string;
  action?: React.ReactNode;
  optional?: boolean;
}) {
  return (
    <div className="flex gap-3">
      <div className="flex-shrink-0 w-6 h-6 rounded-full bg-gold/15 text-gold-ink text-xs font-medium flex items-center justify-center mt-0.5">
        {number}
      </div>
      <div className="flex-1 space-y-1.5">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-ink">{title}</p>
          {optional && (
            <span className="text-[10px] text-ink-faint px-1.5 py-0.5 rounded-full border border-edge">
              optional
            </span>
          )}
        </div>
        <p className="text-xs text-ink-dim leading-relaxed">{description}</p>
        {action && <div className="pt-0.5">{action}</div>}
      </div>
    </div>
  );
}
