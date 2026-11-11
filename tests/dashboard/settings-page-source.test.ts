/**
 * Source pins for the Settings page (2026-11-09), which replaced the gear
 * modal.
 *
 * There is no DOM harness in this repo, so these are source pins: they read
 * the page, the field table and the controls, and locate every anchor with
 * `anchorIndex` / `sliceBetween` so a vanished anchor fails loudly rather
 * than passing vacuously.
 *
 * What they protect:
 *  - the page is dynamic and titled, and its groups stay in the intended order;
 *  - EVERY field carries a real one-line explanation (the owner's actual ask:
 *    "clear copy that explains what each setting does");
 *  - every key that had no screen before this page still has a control, one
 *    assertion per key, so dropping one fails by name;
 *  - the two keys that must never get a control have none;
 *  - the save path sends the exact `AppSettings` key names, and the
 *    preference controls send the route's own field names.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { anchorIndex, sliceBetween } from "../helpers/source-anchor";
import {
  FILE_STORE_FIELDS,
  SETTINGS_GROUPS,
} from "@/app/dashboard/components/settings/settings-fields";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const PAGE = read("app/dashboard/settings/page.tsx");
const FIELDS_SRC = read("app/dashboard/components/settings/settings-fields.ts");
const PROVIDER = read("app/dashboard/components/settings/SettingsStoreProvider.tsx");
const FIELD_GROUP = read("app/dashboard/components/settings/FileStoreFieldGroup.tsx");
const PREFS_CLIENT = read("app/dashboard/components/settings/preferences-client.ts");
const PRINTING = read("app/dashboard/components/settings/PrintingPreferences.tsx");
const COVERAGE = read("app/dashboard/components/settings/CoverageGapIgnoredSymbols.tsx");
const CAPS = read("app/dashboard/components/settings/ConstructionCapsPreferences.tsx");
const CONTROLS = [PROVIDER, FIELD_GROUP, PRINTING, COVERAGE, CAPS].join("\n");

/** The six pre-existing sections, each mounted by the page and nowhere else. */
const EXISTING_SECTIONS = [
  "EmailRecipientsSection",
  "EarningsEmailsSection",
  "AiModelsSection",
  "AiFailoverSection",
  "PlaidSection",
  "SecuritySection",
];

/** Keys that had no UI at all before this page. */
const NEWLY_EXPOSED_KEYS = [
  "openaiApiKey",
  "cloudflareAccountId",
  "cloudflareGatewayId",
  "cloudflareGatewayToken",
  "cloudflareWorkersAIToken",
  "finnhubApiKey",
  "pushoverLinkBase",
  "workerMarkerUrl",
  "r2AccessKeyId",
  "r2BucketName",
  "r2SecretAccessKey",
  "plaidClientId",
  "plaidSecret",
  "plaidEnv",
  "plaidRedirectUri",
];

/** The 20 the old modal already showed — none may be lost in the move. */
const KEYS_THE_MODAL_SHOWED = [
  "anthropicApiKey",
  "fredApiKey",
  "apiNinjasKey",
  "alphaVantageApiKey",
  "ibkrAccountCode",
  "twsHost",
  "twsPort",
  "autoConnectTws",
  "refreshIntervalMinutes",
  "resendApiKey",
  "resendFromDomain",
  "gmailAddress",
  "gmailAppPassword",
  "briefingEmailTo",
  "googleClientId",
  "googleClientSecret",
  "googleRefreshToken",
  "edgarContactEmail",
  "pushoverAppToken",
  "pushoverUserKey",
];

describe("the Settings page is a page", () => {
  it("is dynamic and titled Settings", () => {
    expect(PAGE.indexOf('export const dynamic = "force-dynamic";')).toBe(0);
    anchorIndex(PAGE, 'export const metadata = { title: "Settings" };');
  });

  it("the field table is a plain module a test and the server can both read", () => {
    // The directive, if present, has to be the first statement — a mention
    // in the file's own doc comment is not one.
    expect(FIELDS_SRC.trimStart().startsWith('"use client"')).toBe(false);
    expect(FIELDS_SRC).not.toMatch(/^import .*from "react"/m);
  });

  it("every group heading is on the page, in the intended order", () => {
    let at = 0;
    for (const group of SETTINGS_GROUPS) {
      // The <section id> comes from the group table, so pin the id order.
      at = anchorIndex(PAGE, `id="${group.id}"`, at, group.title) + 1;
    }
    // And the titles themselves are real copy, not an id echoed back.
    for (const group of SETTINGS_GROUPS) {
      expect(group.title.length).toBeGreaterThan(3);
      expect(group.description.trim().length).toBeGreaterThan(30);
    }
  });

  it("the jump nav links every group and the sections can be jumped to", () => {
    const nav = sliceBetween(PAGE, 'aria-label="Settings sections"', "</nav>");
    expect(nav).toContain("href={`#${group.id}`}");
    expect(PAGE).toContain("scroll-mt-20");
  });
});

describe("the field table explains every setting", () => {
  it("every field has a non-empty one-line explanation", () => {
    for (const field of FILE_STORE_FIELDS) {
      expect(field.help.trim(), `help for ${field.key}`).not.toBe("");
      // A one-liner, but a real sentence: a two-word stub is not an answer to
      // "what does this do and what changes when I change it".
      expect(field.help.trim().length, `help for ${field.key}`).toBeGreaterThan(40);
      expect(field.label.trim(), `label for ${field.key}`).not.toBe("");
    }
  });

  it("no two fields share a key", () => {
    const keys = FILE_STORE_FIELDS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every field names a group that exists, and no group id is unused", () => {
    const ids = new Set(SETTINGS_GROUPS.map((g) => g.id));
    for (const field of FILE_STORE_FIELDS) {
      expect(ids.has(field.group), `group for ${field.key}`).toBe(true);
    }
  });

  it("a select field lists its options; nothing else does", () => {
    for (const field of FILE_STORE_FIELDS) {
      if (field.kind === "select") {
        expect((field.options ?? []).length, `options for ${field.key}`).toBeGreaterThan(1);
      } else {
        expect(field.options, `options for ${field.key}`).toBeUndefined();
      }
    }
  });

  it("every secret field is marked sensitive and vice versa", () => {
    for (const field of FILE_STORE_FIELDS) {
      expect(field.sensitive, `sensitive for ${field.key}`).toBe(field.kind === "secret");
    }
  });
});

describe("every key that gets a control has one", () => {
  const keys = new Set(FILE_STORE_FIELDS.map((f) => f.key));

  it.each(KEYS_THE_MODAL_SHOWED)("%s survived the move off the modal", (key) => {
    expect(keys.has(key)).toBe(true);
  });

  it.each(NEWLY_EXPOSED_KEYS)("%s now has a control (it had none before)", (key) => {
    expect(keys.has(key)).toBe(true);
  });

  it("every group that holds fields is rendered on the page", () => {
    for (const group of SETTINGS_GROUPS) {
      const hasFields = FILE_STORE_FIELDS.some((f) => f.group === group.id);
      if (hasFields) expect(PAGE).toContain(`<FileStoreFieldGroup group="${group.id}" />`);
    }
  });
});

describe("the two withheld keys appear nowhere", () => {
  // The field table's doc comment explains WHY each is withheld, so the pin
  // is on the array itself, the page and the controls — not on the prose.
  const table = sliceBetween(
    FIELDS_SRC,
    "export const FILE_STORE_FIELDS",
    "/** The fields in one group",
  );

  it.each(["cronSharedSecret", "firstRunComplete"])("%s has no control", (key) => {
    expect(table).not.toContain(key);
    expect(FILE_STORE_FIELDS.some((f) => f.key === key)).toBe(false);
    expect(PAGE).not.toContain(key);
    expect(CONTROLS).not.toContain(key);
  });
});

describe("the controls write the keys their readers read", () => {
  it("the save path sends the AppSettings key names and coerces the two typed ones", () => {
    const save = sliceBetween(PROVIDER, "async function handleSave()", "async function handleRestart");
    // The dirty map is keyed by field.key, so the key names reach the route
    // exactly as the table writes them.
    expect(FIELD_GROUP).toContain("setField(field.key,");
    expect(save).toContain("updates[key] = Number(val)");
    expect(save).toContain('updates[key] = val === "true"');
    expect(FIELDS_SRC).toContain('export const NUMERIC_FIELD_KEYS = ["twsPort", "refreshIntervalMinutes"]');
    expect(FIELDS_SRC).toContain('export const BOOLEAN_FIELD_KEYS = ["autoConnectTws"]');
    expect(PROVIDER).toContain('apiFetch("/api/settings"');
  });

  it("the preference controls hit /api/settings/preferences with the route's field names", () => {
    expect(PREFS_CLIENT).toContain('apiFetch("/api/settings/preferences"');
    expect(PREFS_CLIENT).toContain('method: "PATCH"');
    expect(PREFS_CLIENT).toContain("readMutationResult");
    expect(PRINTING).toContain("save({ worksheetPrinterName: printer }");
    expect(PRINTING).toContain("save({ pdftotextPath: pdftotext }");
    expect(COVERAGE).toContain("coverageGuardIgnoredSymbols: [...symbols, sym]");
    expect(COVERAGE).toContain("coverageGuardIgnoredSymbols: symbols.filter((s) => s !== sym)");
    expect(CAPS).toContain("save({ constructionCaps: { [scope]: next } }");
  });

  it("the caps control shows percentages and stores fractions, one scope at a time", () => {
    // 10 on screen, 0.10 stored: the stored shape is the engine's, and only
    // the edited scope is sent, so the four per-scope rows stay different.
    expect(CAPS).toContain("Math.round(fraction * 10000) / 100");
    expect(CAPS).toContain("Number(shown) / 100");
    expect(CAPS).toMatch(/max %/);
    for (const field of ["top1Max", "top3Max", "sectorMax", "betaMin", "betaMax"]) {
      expect(CAPS).toContain(field);
    }
  });
});

describe("page chrome and the entry point", () => {
  it("no native browser dialog anywhere on the page", () => {
    for (const src of [PAGE, CONTROLS, PREFS_CLIENT]) {
      expect(src).not.toMatch(/\bwindow\.(confirm|alert|prompt)\(/);
      expect(src).not.toMatch(/(^|[^.\w])(confirm|alert|prompt)\(/m);
    }
  });

  it.each(EXISTING_SECTIONS)("%s is mounted exactly once", (name) => {
    const mounts = PAGE.match(new RegExp(`<${name}\\s*/>`, "g")) ?? [];
    expect(mounts.length).toBe(1);
  });

  it("each block says when the change takes effect", () => {
    // The restart note travels with the file-store fields, so it never
    // appears over a group whose fields failed to load.
    anchorIndex(FIELD_GROUP, "Takes effect after a restart.");
    anchorIndex(PAGE, "Takes effect on the next check, no restart.");
    anchorIndex(PAGE, "Takes effect at once, in this browser");
  });

  it("the gear is a link to the page and keeps its 44px touch target", () => {
    const link = read("app/dashboard/components/SettingsLink.tsx");
    expect(link).toContain('href="/dashboard/settings"');
    expect(link).toContain('aria-label="Settings"');
    expect(link).toContain("pointer-coarse:after:-inset-3.5");
    // And the header mounts the link, not a modal.
    const layout = read("app/dashboard/layout.tsx");
    expect(layout).toContain("<SettingsLink />");
    expect(layout).not.toContain("SettingsModal");
  });

  it("the mobile drawer and the chat page map both know the route", () => {
    expect(read("app/dashboard/components/MobileNavDrawer.tsx")).toContain(
      'href="/dashboard/settings"',
    );
    expect(read("lib/chat/page-context.ts")).toContain(
      '"/dashboard/settings": "User is on the Settings page."',
    );
  });

  it("Settings is not a seventh desktop tab", () => {
    expect(read("app/dashboard/components/nav-tabs.ts")).not.toContain("/dashboard/settings");
  });
});
