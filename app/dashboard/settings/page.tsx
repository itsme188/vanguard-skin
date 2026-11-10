export const dynamic = "force-dynamic";

/**
 * The Settings page.
 *
 * Replaces the old gear-button modal. Three things the modal could not do:
 *  - every control carries a one-line explanation of what it does and what
 *    changing it affects (the copy lives in settings-fields.ts for the
 *    file-store fields, and next to the control for the rest);
 *  - the settings that had no screen at all now have one — the OpenAI key the
 *    AI failover needs, the Finnhub key the earnings calendar runs on, the
 *    notification link base, the R2 archive, the Plaid credentials, the
 *    worksheet printer, the pdftotext path, the coverage-gap ignore list and
 *    the per-scope position limits;
 *  - each block says WHEN a change takes effect, because the two stores
 *    behave differently: the app's settings file is read into environment
 *    variables when the app starts (restart needed), while the database rows
 *    are re-read on every check (no restart).
 *
 * Settings is not a seventh desktop tab — the tab row is locked at six. It is
 * reached from the header gear and the mobile navigation drawer, the same way
 * Data Health is.
 */

import { AiFailoverSection } from "../components/AiFailoverSection";
import { AiModelsSection } from "../components/AiModelsSection";
import { EarningsEmailsSection } from "../components/EarningsEmailsSection";
import { EmailRecipientsSection } from "../components/EmailRecipientsSection";
import { PlaidSection } from "../components/PlaidSection";
import { SecuritySection } from "../components/SecuritySection";
import { PrivacyToggle } from "../components/PrivacyToggle";
import { ThemeToggle } from "../components/ThemeToggle";
import { FileStoreFieldGroup } from "../components/settings/FileStoreFieldGroup";
import { SettingsStoreProvider } from "../components/settings/SettingsStoreProvider";
import { PrintingPreferences } from "../components/settings/PrintingPreferences";
import { CoverageGapIgnoredSymbols } from "../components/settings/CoverageGapIgnoredSymbols";
import { ConstructionCapsPreferences } from "../components/settings/ConstructionCapsPreferences";
import { SETTINGS_GROUPS, type SettingsGroupId } from "../components/settings/settings-fields";

// Browser-tab title; the root template makes it "Settings · Portfolio Desk".
export const metadata = { title: "Settings" };

function groupTitle(id: SettingsGroupId): string {
  const group = SETTINGS_GROUPS.find((g) => g.id === id);
  if (!group) throw new Error(`unknown settings group: ${id}`);
  return group.title;
}

function groupDescription(id: SettingsGroupId): string {
  const group = SETTINGS_GROUPS.find((g) => g.id === id);
  if (!group) throw new Error(`unknown settings group: ${id}`);
  return group.description;
}

/** One group: heading, its one-line purpose, then its blocks. */
function Group({ id, children }: { id: SettingsGroupId; children: React.ReactNode }) {
  return (
    <section
      id={id}
      className="rounded-xl border border-edge bg-panel overflow-hidden scroll-mt-20"
    >
      <div className="px-5 py-4 border-b border-edge">
        <h2 className="text-sm font-medium text-ink whitespace-nowrap!">{groupTitle(id)}</h2>
        <p className="text-[12px] text-ink-faint mt-0.5 max-w-3xl">{groupDescription(id)}</p>
      </div>
      {children}
    </section>
  );
}

/**
 * When a change to a DATABASE row takes effect. Those rows are read fresh on
 * every background check, which runs every 15 minutes.
 */
function LiveNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-5 pt-4 text-[12px] text-ink-dim">
      <span className="font-medium text-ink">Takes effect on the next check, no restart.</span>{" "}
      {children}
    </p>
  );
}

/** Jump links. Sticky beside the groups on a wide screen, wrapped above them on a phone. */
function JumpNav() {
  return (
    <nav aria-label="Settings sections" className="lg:sticky lg:top-20 lg:self-start">
      <p className="text-[11px] uppercase tracking-wider text-ink-faint mb-2">On this page</p>
      <ul className="flex flex-wrap gap-1.5 lg:flex-col lg:gap-0.5">
        {SETTINGS_GROUPS.map((group) => (
          <li key={group.id}>
            <a
              href={`#${group.id}`}
              className="inline-block rounded px-2 py-1 text-[12px] text-ink-dim hover:text-ink hover:bg-raised/60 transition-colors"
            >
              {group.title}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export default function SettingsPage() {
  return (
    <div className="max-w-[1400px] mx-auto px-4 md:px-6 py-6 md:py-8 space-y-6">
      <div>
        <h1 className="text-xl font-medium text-ink">Settings</h1>
        <p className="text-[13px] text-ink-dim mt-1 max-w-3xl">
          Everything the app needs to reach the outside world, and the choices that shape what it
          sends you. Each setting says what it does and when a change takes effect.
        </p>
      </div>

      <div className="lg:grid lg:grid-cols-[190px_minmax(0,1fr)] lg:gap-8 space-y-6 lg:space-y-0">
        <JumpNav />

        {/* One provider for every file-store field on the page: one dirty map,
            one Save, whichever groups the owner edited. */}
        <SettingsStoreProvider>
          <Group id="earnings-email">
            <FileStoreFieldGroup group="earnings-email" />
            <LiveNote>
              Who receives each kind of email, and whether earnings emails are sent at all.
            </LiveNote>
            <div className="px-5 py-4 border-b border-edge">
              <EmailRecipientsSection />
            </div>
            <div className="px-5 py-4">
              <EarningsEmailsSection />
            </div>
          </Group>

          <Group id="ai">
            <FileStoreFieldGroup group="ai" />
            <LiveNote>Which model each feature uses, and where it goes when a provider is down.</LiveNote>
            <div className="px-5 py-4 border-b border-edge">
              <AiModelsSection />
            </div>
            <div className="px-5 py-4">
              <AiFailoverSection />
            </div>
          </Group>

          <Group id="market-data">
            <FileStoreFieldGroup group="market-data" />
          </Group>

          <Group id="broker">
            <FileStoreFieldGroup group="broker" />
            <LiveNote>The live Vanguard connection itself, including when it needs re-linking.</LiveNote>
            <div className="px-5 py-4">
              <PlaidSection />
            </div>
          </Group>

          <Group id="printing">
            <LiveNote>Both are read each time a worksheet is printed or a PDF is read.</LiveNote>
            <PrintingPreferences />
          </Group>

          <Group id="data">
            <FileStoreFieldGroup group="data" />
          </Group>

          <Group id="limits">
            <LiveNote>
              Read each time the What-if calculator or the cash-deploy suggestion runs.
            </LiveNote>
            <ConstructionCapsPreferences />
          </Group>

          <Group id="notifications">
            <FileStoreFieldGroup group="notifications" />
            <LiveNote>Which names are left out of the earnings coverage warning.</LiveNote>
            <CoverageGapIgnoredSymbols />
          </Group>

          <Group id="display">
            <div className="px-5 py-4 space-y-4">
              <p className="text-[12px] text-ink-dim max-w-2xl">
                <span className="font-medium text-ink">Takes effect at once, in this browser
                only.</span>{" "}
                Both choices are remembered per browser and are not part of your portfolio
                settings, so changing them here does not change anything on your phone.
              </p>
              <div className="flex items-center justify-between gap-4 max-w-2xl">
                <div>
                  <p className="text-[13px] font-medium text-ink">Dark theme</p>
                  <p className="text-[12px] text-ink-dim">
                    Switches the whole dashboard between the light and dark palette.
                  </p>
                </div>
                <ThemeToggle />
              </div>
              <div className="flex items-center justify-between gap-4 max-w-2xl">
                <div>
                  <p className="text-[13px] font-medium text-ink">Privacy mode</p>
                  <p className="text-[12px] text-ink-dim">
                    Hides your own figures — balances, returns, share counts — so the screen is
                    safe to show someone. Public market data, such as a stock&apos;s price or a
                    day&apos;s move, stays visible.
                  </p>
                </div>
                <PrivacyToggle />
              </div>
            </div>
          </Group>

          <Group id="system">
            <LiveNote>
              Your password and unlock PIN change the moment you save them.
            </LiveNote>
            <div className="px-5 py-4">
              <SecuritySection />
            </div>
          </Group>
        </SettingsStoreProvider>
      </div>
    </div>
  );
}
