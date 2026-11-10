/**
 * The Settings page's field table — a plain module (NO "use client"), so the
 * page (server), the controls (client) and the tests can all read one list.
 *
 * Every entry here is a key of `AppSettings` (lib/settings/file-store.ts and
 * electron/settings-store.ts, kept in lockstep by hand). Those values live in
 * the Electron JSON settings file and reach the server as ENV VARS AT BOOT, so
 * a change to any of them needs an app restart. That is why the page says so
 * once per field group instead of burying it in a tooltip.
 *
 * `help` is a one-line, plain-language explanation of what the setting does
 * and what changing it affects. It is a deliverable, not decoration: if a
 * reader cannot tell from `help` whether they need the field, rewrite it.
 *
 * Two keys are deliberately absent and must stay absent:
 *  - `cronSharedSecret` — the secret shared with the Cloudflare Worker. It is
 *    rotated as a PAIR with the Worker's copy; changing only this side 403s
 *    every /api/cron/* route and silently stops the cloud fallback.
 *  - `firstRunComplete` — an internal bootstrap flag, not a preference.
 *
 * The dev-mode `POST /api/settings` route drops any key missing from its
 * ALLOWED list, so tests/api/settings-route-allowlist.test.ts reads THIS table
 * and fails if a field here is not allowed there.
 */

/** How a field is edited. `secret` is a text box whose value is masked. */
export type SettingsFieldKind = "text" | "secret" | "number" | "toggle" | "select";

export interface SettingsField {
  /** The `AppSettings` key. Sent to the save path exactly as written here. */
  key: string;
  /** Short name shown above the control. */
  label: string;
  /** One line: what it does, and what changes when you change it. */
  help: string;
  kind: SettingsFieldKind;
  /** True when the stored value is a credential (masked, with a show/hide). */
  sensitive: boolean;
  /** For `kind: "select"`: the stored values, in the order shown. */
  options?: readonly { value: string; label: string }[];
  /** Which group on the page this field belongs to. */
  group: SettingsGroupId;
}

export type SettingsGroupId =
  | "earnings-email"
  | "ai"
  | "market-data"
  | "broker"
  | "printing"
  | "data"
  | "limits"
  | "notifications"
  | "display"
  | "system";

export interface SettingsGroup {
  id: SettingsGroupId;
  /** The <h2> on the page and the label in the jump nav. */
  title: string;
  /** One line under the heading: what this group of settings is for. */
  description: string;
}

/**
 * The groups, in the order they appear on the page and in the jump nav.
 *
 * The order runs from the settings the owner touches most (the daily earnings
 * and email pipeline) down to the ones touched once (security, data directory).
 * "Printing & documents" and "Data, imports & cloud backup" each hold two
 * things that live together in practice: a local tool that turns documents
 * into paper or text, and the cloud copy of what the Mac has.
 */
export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  {
    id: "earnings-email",
    title: "Earnings & email",
    description:
      "Who gets the briefing, digest and earnings emails, which mailbox sends them, and which mailbox newsletters are read from.",
  },
  {
    id: "ai",
    title: "AI providers & models",
    description:
      "The accounts the app writes with, which model each feature uses, and what happens when a provider is down.",
  },
  {
    id: "market-data",
    title: "Market data & research",
    description:
      "The data feeds behind earnings dates, economic releases, transcripts and company filings.",
  },
  {
    id: "broker",
    title: "Broker & sync",
    description:
      "How the app reaches Interactive Brokers Trader Workstation, how often it refreshes, and the Plaid link that keeps Vanguard holdings current while TWS is closed.",
  },
  {
    id: "printing",
    title: "Printing & documents",
    description:
      "The printer earnings worksheets go to, and the local tool that reads text out of a PDF.",
  },
  {
    id: "data",
    title: "Data, imports & cloud backup",
    description:
      "Where imported statement PDFs are archived, and how the Mac checks what the cloud fallback has already sent.",
  },
  {
    id: "limits",
    title: "Position limits",
    description:
      "The concentration limits the What-if calculator and the cash-deploy suggestions respect. They are set per account scope on purpose.",
  },
  {
    id: "notifications",
    title: "Notifications",
    description:
      "Phone push notifications for price levels, earnings prints and coverage gaps.",
  },
  {
    id: "display",
    title: "Display",
    description:
      "How this browser shows the dashboard. These are per-browser display preferences, not portfolio settings.",
  },
  {
    id: "system",
    title: "Account & system",
    description:
      "Your sign-in password and unlock PIN, where the data lives on disk, and which version is running.",
  },
] as const;

const PLAID_ENVIRONMENTS = [
  { value: "sandbox", label: "Sandbox (test data only)" },
  { value: "development", label: "Development" },
  { value: "production", label: "Production (your real accounts)" },
] as const;

const REFRESH_INTERVALS = [
  { value: "0", label: "Off — only refresh when I connect" },
  { value: "15", label: "Every 15 minutes" },
  { value: "30", label: "Every 30 minutes" },
  { value: "60", label: "Every 60 minutes" },
] as const;

/**
 * Every `AppSettings` key the Settings page offers a control for.
 *
 * Order within a group is the order shown on the page: the field you are most
 * likely to need first, then the ones that only matter once the first is set.
 */
export const FILE_STORE_FIELDS: SettingsField[] = [
  // ── Earnings & email ─────────────────────────────────────────────────────
  {
    key: "resendApiKey",
    label: "Resend API key",
    help: "The account every outbound email is sent from — the morning briefing, the evening digest and the earnings preview and recap. Without it no email leaves the app. Outbound only; newsletters are read through the Gmail fields below.",
    kind: "secret",
    sensitive: true,
    group: "earnings-email",
  },
  {
    key: "resendFromDomain",
    label: "Resend sending domain",
    help: "The domain outgoing email is sent from, for example myportfoliodesk.com. The part before the @ is chosen per email (briefing, digest, earnings), so enter the domain only. It must be a domain you have verified with Resend, or the send is rejected.",
    kind: "text",
    sensitive: false,
    group: "earnings-email",
  },
  {
    key: "briefingEmailTo",
    label: "Default recipient",
    help: "Where email goes when a particular email type has no recipient of its own. Set a per-type recipient below to override it.",
    kind: "text",
    sensitive: false,
    group: "earnings-email",
  },
  {
    key: "gmailAddress",
    label: "Gmail address (inbound newsletters)",
    help: "The mailbox the app reads market newsletters out of. Inbound only — nothing is ever sent from it.",
    kind: "text",
    sensitive: false,
    group: "earnings-email",
  },
  {
    key: "gmailAppPassword",
    label: "Gmail app password (inbound)",
    help: "A Google app password for reading that mailbox over IMAP. It is not your Google account password; generate one in your Google account's security settings.",
    kind: "secret",
    sensitive: true,
    group: "earnings-email",
  },
  {
    key: "googleClientId",
    label: "Google OAuth client ID",
    help: "The newer, token-based way of reading the same inbound newsletter mailbox, used in place of the IMAP app password. Not a secret, so it is shown in full.",
    kind: "text",
    sensitive: false,
    group: "earnings-email",
  },
  {
    key: "googleClientSecret",
    label: "Google OAuth client secret",
    help: "The secret half of that inbound Google OAuth client. Keep it private; losing it means re-creating the client in Google Cloud.",
    kind: "secret",
    sensitive: true,
    group: "earnings-email",
  },
  {
    key: "googleRefreshToken",
    label: "Google OAuth refresh token",
    help: "The long-lived token that lets the app keep reading the inbound mailbox without you signing in again. If newsletter ingestion stops, this is usually what expired.",
    kind: "secret",
    sensitive: true,
    group: "earnings-email",
  },

  // ── AI providers & models ────────────────────────────────────────────────
  {
    key: "anthropicApiKey",
    label: "Anthropic API key",
    help: "The main AI account. Everything written by AI depends on it: chat, PDF statement parsing, earnings prep, digest writing and filing summaries.",
    kind: "secret",
    sensitive: true,
    group: "ai",
  },
  {
    key: "openaiApiKey",
    label: "OpenAI API key",
    help: "The key the failover below needs in order to actually fail over to OpenAI. Switching failover on without this key leaves the app with nowhere to go when Anthropic is down.",
    kind: "secret",
    sensitive: true,
    group: "ai",
  },
  {
    key: "cloudflareAccountId",
    label: "Cloudflare account ID",
    help: "Set this together with the gateway ID below to route every AI call through Cloudflare's AI Gateway, which records what each feature spends. Leave both blank to call the providers directly.",
    kind: "text",
    sensitive: false,
    group: "ai",
  },
  {
    key: "cloudflareGatewayId",
    label: "Cloudflare AI Gateway ID",
    help: "Which gateway in that account the AI calls go through. Routing only switches on when this and the account ID are both filled in.",
    kind: "text",
    sensitive: false,
    group: "ai",
  },
  {
    key: "cloudflareGatewayToken",
    label: "Cloudflare AI Gateway token",
    help: "The token that authenticates the app to that gateway. Needed only if your gateway is set to require one.",
    kind: "secret",
    sensitive: true,
    group: "ai",
  },
  {
    key: "cloudflareWorkersAIToken",
    label: "Cloudflare Workers AI token",
    help: "Lets the app use Cloudflare's own hosted models as a last resort when both Anthropic and OpenAI are unreachable.",
    kind: "secret",
    sensitive: true,
    group: "ai",
  },

  // ── Market data & research ───────────────────────────────────────────────
  {
    key: "finnhubApiKey",
    label: "Finnhub API key",
    help: "Drives the earnings calendar: for each stock you hold, when it reports and what the consensus is. Without it the week-ahead earnings list goes empty.",
    kind: "secret",
    sensitive: true,
    group: "market-data",
  },
  {
    key: "fredApiKey",
    label: "FRED API key",
    help: "The St. Louis Fed feed behind economic release dates (CPI, jobs, GDP) and the risk-free rate used in Sharpe ratios.",
    kind: "secret",
    sensitive: true,
    group: "market-data",
  },
  {
    key: "alphaVantageApiKey",
    label: "Alpha Vantage key",
    help: "Fetches earnings call transcripts. The free tier allows 25 requests a day, so transcripts stop arriving once that is used up.",
    kind: "secret",
    sensitive: true,
    group: "market-data",
  },
  {
    key: "apiNinjasKey",
    label: "API Ninjas key",
    help: "A small supporting data feed used for company reference details. Nothing breaks without it; those details are simply blank.",
    kind: "secret",
    sensitive: true,
    group: "market-data",
  },
  {
    key: "edgarContactEmail",
    label: "EDGAR contact email",
    help: "The SEC asks every automated reader to identify itself by email. Filings (8-K reads, filing summaries) are refused without it.",
    kind: "text",
    sensitive: false,
    group: "market-data",
  },

  // ── Broker & sync ────────────────────────────────────────────────────────
  {
    key: "ibkrAccountCode",
    label: "IBKR account code",
    help: "Which Interactive Brokers account the app reads positions from. Wrong code, no positions.",
    kind: "text",
    sensitive: false,
    group: "broker",
  },
  {
    key: "twsHost",
    label: "TWS host",
    help: "The machine Trader Workstation runs on. 127.0.0.1 means this Mac, which is the normal setting.",
    kind: "text",
    sensitive: false,
    group: "broker",
  },
  {
    key: "twsPort",
    label: "TWS port",
    help: "The port Trader Workstation listens on: 7496 for live trading, 7497 for paper. It must match TWS's own API settings or the connection times out.",
    kind: "number",
    sensitive: false,
    group: "broker",
  },
  {
    key: "autoConnectTws",
    label: "Connect to TWS on startup",
    help: "On, the app connects to Trader Workstation as soon as it opens and runs a full sync. Off, you connect by hand from the header.",
    kind: "toggle",
    sensitive: false,
    group: "broker",
  },
  {
    key: "refreshIntervalMinutes",
    label: "Background refresh",
    help: "How often the app re-reads prices and positions while it is open. When TWS is closed the same timer falls back to the IBKR web feed during market hours.",
    kind: "select",
    sensitive: false,
    options: REFRESH_INTERVALS,
    group: "broker",
  },
  {
    key: "plaidClientId",
    label: "Plaid client ID",
    help: "Identifies the app to Plaid, which reads Vanguard holdings once a day so the dashboard stays current between statements.",
    kind: "text",
    sensitive: false,
    group: "broker",
  },
  {
    key: "plaidSecret",
    label: "Plaid secret",
    help: "The private half of that Plaid client. It must be the secret for the environment chosen below — the sandbox and production secrets are different.",
    kind: "secret",
    sensitive: true,
    group: "broker",
  },
  {
    key: "plaidEnv",
    label: "Plaid environment",
    help: "Which Plaid world to connect to. Sandbox returns made-up test accounts; production reads your real Vanguard accounts. Changing this invalidates the existing connection, so you have to link again.",
    kind: "select",
    sensitive: false,
    options: PLAID_ENVIRONMENTS,
    group: "broker",
  },
  {
    key: "plaidRedirectUri",
    label: "Plaid redirect URI",
    help: "Where Vanguard sends you back to after you sign in during linking. It has to match the URI registered in your Plaid dashboard exactly, or linking fails at the last step.",
    kind: "text",
    sensitive: false,
    group: "broker",
  },

  // ── Data, imports & cloud backup ─────────────────────────────────────────
  {
    key: "r2BucketName",
    label: "R2 bucket name",
    help: "The Cloudflare R2 bucket imported statement PDFs are archived into, so the originals survive a disk loss.",
    kind: "text",
    sensitive: false,
    group: "data",
  },
  {
    key: "r2AccessKeyId",
    label: "R2 access key ID",
    help: "The user half of the credentials for that bucket. Archiving is skipped while it is blank; imports themselves still work.",
    kind: "secret",
    sensitive: true,
    group: "data",
  },
  {
    key: "r2SecretAccessKey",
    label: "R2 secret access key",
    help: "The secret half of those bucket credentials. Treat it like a password: it can read and overwrite the whole archive.",
    kind: "secret",
    sensitive: true,
    group: "data",
  },
  {
    key: "workerMarkerUrl",
    label: "Worker marker URL",
    help: "The cloud fallback's address. Before sending an email the Mac asks it whether the cloud already sent that one, which is what stops you getting the same briefing twice.",
    kind: "text",
    sensitive: false,
    group: "data",
  },

  // ── Notifications ────────────────────────────────────────────────────────
  {
    key: "pushoverAppToken",
    label: "Pushover app token",
    help: "Identifies this app to Pushover, the service that delivers push notifications to your phone for fired price levels and earnings prints.",
    kind: "secret",
    sensitive: true,
    group: "notifications",
  },
  {
    key: "pushoverUserKey",
    label: "Pushover user key",
    help: "Which Pushover account the notifications are delivered to — your phone. Both this and the app token must be set before any push is sent.",
    kind: "secret",
    sensitive: true,
    group: "notifications",
  },
  {
    key: "pushoverLinkBase",
    label: "Notification link base",
    help: "The address the \"open in dashboard\" link inside a notification points at. Leave it blank and a tap from your phone lands on a dead \"Safari can't connect\" page, because the link defaults to this Mac's own localhost.",
    kind: "text",
    sensitive: false,
    group: "notifications",
  },
];

/** The fields in one group, in table order. */
export function fieldsInGroup(group: SettingsGroupId): readonly SettingsField[] {
  return FILE_STORE_FIELDS.filter((f) => f.group === group);
}

/** `AppSettings` keys stored as numbers — coerced before the save. */
export const NUMERIC_FIELD_KEYS = ["twsPort", "refreshIntervalMinutes"] as const;

/** `AppSettings` keys stored as booleans — coerced before the save. */
export const BOOLEAN_FIELD_KEYS = ["autoConnectTws"] as const;
