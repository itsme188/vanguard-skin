/**
 * Web-search-verified GICS sector sweep — the repair + standing resolution
 * tool for Bloomberg-taxonomy sector corruption. Dry-run by default; every
 * verified row (changed OR confirmed) is stamped sector_source='gics_verified'
 * + sector_verified_at, which is what the Data Health drift panel suppresses
 * on. Options are derived rows: sector copied from the verified underlying
 * (issuerSiblings-aware), never stamped.
 * Spec: docs/superpowers/specs/2026-07-28-sector-tag-verification-design.md
 */
import type Database from "better-sqlite3";
import type Anthropic from "@anthropic-ai/sdk";
import { GICS_SECTORS } from "@/lib/securities/normalize-sector";
import { issuerSiblings } from "@/lib/securities/issuer-family";
import { extractJsonArray } from "@/lib/ai/extract-json";
import { isGarbageSymbol } from "@/lib/import/validate";
import { getRawAnthropicClient } from "@/lib/ai/provider";
import { resolveFeatureModel } from "@/lib/ai/models";

export const SWEEP_BATCH_SIZE = 10;

export interface SweepCandidate {
  id: number; symbol: string; name: string | null; industry: string | null;
  fund_category: string | null; sector: string | null;
}
export interface SectorVerdict { symbol: string; sector: string; rationale: string; }
export interface SweepRowResult {
  symbol: string; oldSector: string | null; newSector: string | null;
  changed: boolean; written: boolean; rationale: string;
}
export interface SweepResult {
  rows: SweepRowResult[]; unresolved: { symbol: string; reason: string }[];
  optionRowsUpdated: number; applied: boolean;
}

const GICS_SET = new Set<string>(GICS_SECTORS);

/**
 * Stocks eligible for the verification sweep. Default scope is unverified
 * rows only (`sector_verified_at IS NULL`); `opts.all` includes already-
 * verified rows too. `opts.symbols` (case-insensitive exact match) is
 * applied LAST and overrides the verified-skip — re-verifying a named
 * symbol is the whole point of passing it explicitly.
 */
export function getSweepCandidates(
  db: Database.Database,
  opts?: { all?: boolean; symbols?: string[] },
): SweepCandidate[] {
  const includeVerified = (opts?.all ?? false) || (opts?.symbols?.length ?? 0) > 0;
  const sql = `SELECT id, symbol, name, industry, fund_category, sector
                 FROM securities
                WHERE LOWER(security_type) IN ('stock', 'common stock')
                ${includeVerified ? "" : "AND sector_verified_at IS NULL"}`;
  const rows = db.prepare(sql).all() as SweepCandidate[];
  let candidates = rows.filter((r) => !isGarbageSymbol(r.symbol));

  if (opts?.symbols && opts.symbols.length > 0) {
    const wanted = new Set(opts.symbols.map((s) => s.toUpperCase()));
    candidates = candidates.filter((c) => wanted.has(c.symbol.toUpperCase()));
  }

  return candidates;
}

/**
 * Parse a model's response into an array of verdicts. Isolates the JSON
 * array via extractJsonArray (survives prose preambles + code fences) then
 * JSON.parse — throws on anything that isn't a JSON array or on parse
 * failure so the caller can record the whole batch as failed rather than
 * silently dropping it.
 */
export function parseVerdicts(text: string): SectorVerdict[] {
  const json = extractJsonArray(text);
  const parsed = JSON.parse(json);
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected a JSON array of verdicts, got ${typeof parsed}`);
  }
  return parsed
    .filter(
      (v): v is { symbol: unknown; sector: unknown; rationale?: unknown } =>
        !!v && typeof v === "object" && typeof v.symbol === "string" && typeof v.sector === "string",
    )
    .map((v) => ({
      symbol: v.symbol as string,
      sector: v.sector as string,
      rationale: typeof v.rationale === "string" ? v.rationale : "",
    }));
}

/**
 * Apply verdicts to candidates. Every resolved candidate (changed OR
 * confirmed-unchanged) is written + stamped sector_source='gics_verified' +
 * sector_verified_at — the stamp itself is the deliverable, suppressing the
 * Data Health drift panel. Candidates with no verdict, or a verdict sector
 * outside GICS_SECTORS (this excludes "Unknown" too), land in `unresolved`
 * and are never written.
 */
export function applyVerdicts(
  db: Database.Database,
  candidates: SweepCandidate[],
  verdicts: SectorVerdict[],
  opts: { apply: boolean },
): { rows: SweepRowResult[]; unresolved: { symbol: string; reason: string }[] } {
  const verdictBySymbol = new Map<string, SectorVerdict>();
  for (const v of verdicts) verdictBySymbol.set(v.symbol.toUpperCase(), v);

  const update = db.prepare(
    `UPDATE securities SET sector = ?, sector_source = 'gics_verified', sector_verified_at = datetime('now') WHERE id = ?`,
  );

  const rows: SweepRowResult[] = [];
  const unresolved: { symbol: string; reason: string }[] = [];

  for (const candidate of candidates) {
    const verdict = verdictBySymbol.get(candidate.symbol.toUpperCase());
    if (!verdict) {
      unresolved.push({ symbol: candidate.symbol, reason: "no verdict returned" });
      continue;
    }
    if (!GICS_SET.has(verdict.sector)) {
      unresolved.push({ symbol: candidate.symbol, reason: verdict.sector });
      continue;
    }
    const changed = candidate.sector !== verdict.sector;
    if (opts.apply) update.run(verdict.sector, candidate.id);
    rows.push({
      symbol: candidate.symbol,
      oldSector: candidate.sector,
      newSector: verdict.sector,
      changed,
      written: opts.apply,
      rationale: verdict.rationale,
    });
  }

  return { rows, unresolved };
}

/**
 * Cascade verified stock sectors onto their option rows. Options are
 * derived — never stamped with sector_source/sector_verified_at — the
 * sector is simply kept in sync with the underlying's verified value.
 * Underlying resolution is issuerSiblings-aware: an option's
 * underlying_symbol may not have its own securities row (e.g. "GOOGL" when
 * only "GOOG" is held), so membership is checked across the whole family.
 * Every option resolved to a verified underlying is (re-)synced to that
 * underlying's sector — an idempotent no-op write when already in sync, so
 * a re-run harmlessly keeps every cascaded option current as the underlying
 * gets re-verified over time. Returns the count of option rows resolved +
 * synced (or that would be, on dry-run) — unresolved options (no verified
 * underlying in the family) are not counted.
 */
export function cascadeOptionSectors(
  db: Database.Database,
  opts: { apply: boolean },
): number {
  const options = db
    .prepare(
      `SELECT id, symbol, sector, underlying_symbol
         FROM securities
        WHERE LOWER(security_type) = 'option' AND underlying_symbol IS NOT NULL`,
    )
    .all() as { id: number; symbol: string; sector: string | null; underlying_symbol: string }[];

  const verifiedStocks = db
    .prepare(
      `SELECT symbol, sector FROM securities WHERE sector_verified_at IS NOT NULL`,
    )
    .all() as { symbol: string; sector: string | null }[];

  const verifiedBySymbol = new Map<string, string | null>();
  for (const s of verifiedStocks) verifiedBySymbol.set(s.symbol.toUpperCase(), s.sector);

  const update = db.prepare(`UPDATE securities SET sector = ? WHERE id = ?`);

  let updated = 0;
  for (const option of options) {
    const family = issuerSiblings(option.underlying_symbol).map((s) => s.toUpperCase());
    const matchedSymbol = family.find((sym) => verifiedBySymbol.has(sym));
    if (!matchedSymbol) continue;
    const resolvedSector = verifiedBySymbol.get(matchedSymbol) ?? null;
    if (resolvedSector === null) continue; // verified underlying has no sector value to copy
    if (opts.apply) update.run(resolvedSector, option.id);
    updated += 1;
  }

  return updated;
}

function stripCodeFences(text: string): string {
  return text.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "").trim();
}

const VERIFICATION_PROMPT_HEADER = `You are verifying GICS sector classifications. For EACH security below, determine its current official GICS-11 sector. Use web_search to verify any name you are not completely certain of — especially recent GICS reclassifications, small caps, and foreign listings. The candidate context lines are hints, not truth: the "current sector" may be wrong (that is why you are verifying).

GICS-11 sectors (exact spellings): Energy, Materials, Industrials, Consumer Discretionary, Consumer Staples, Healthcare, Financials, Technology, Communication Services, Utilities, Real Estate.

Return ONLY a JSON array: [{"symbol": "...", "sector": "<GICS-11 or Unknown>", "rationale": "<one line>"}]. Use "Unknown" when you cannot determine the sector confidently — never guess.`;

/**
 * Default Claude + web_search fetcher for a batch of candidates. Mirrors
 * lib/etf/sector-weights.ts::fetchEtfSectorWeights — same client
 * acquisition, same native web_search tool block, same model-id derivation
 * via resolveFeatureModel(featureKey). Never called in tests (they always
 * inject fetchVerdicts).
 */
export async function defaultFetchVerdicts(batch: SweepCandidate[]): Promise<string> {
  const featureKey = "sectorVerification";
  const { provider, modelId } = resolveFeatureModel(featureKey);
  if (provider !== "anthropic") {
    throw new Error(
      `Sector verification requires the Anthropic provider for native web_search; FEATURE_MODELS["${featureKey}"] resolves to ${provider}/${modelId}. Update lib/ai/models.ts.`,
    );
  }
  const client = getRawAnthropicClient(featureKey);
  const lines = batch.map(
    (c) =>
      `${c.symbol} | ${c.name ?? "unknown name"} | industry: ${c.industry ?? "unknown"} | fund_category: ${c.fund_category ?? "unknown"} | current sector: ${c.sector ?? "unknown"}`,
  );
  const prompt = `${VERIFICATION_PROMPT_HEADER}\n\n${lines.join("\n")}`;

  const response = await client.messages.create({
    model: modelId,
    max_tokens: 4096,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
    messages: [{ role: "user", content: prompt }],
  });
  const textBlocks = response.content.filter(
    (b): b is Anthropic.TextBlock => b.type === "text",
  );
  return stripCodeFences(textBlocks.map((b) => b.text).join("\n"));
}

/**
 * Orchestrate the full sweep: candidates → batched fetch → parse+apply per
 * batch (a thrown batch adds all its candidates to unresolved with the
 * error message and continues) → one final options cascade. On a dry-run
 * nothing gets stamped, so the verified-stock set the cascade reads is
 * empty and optionRowsUpdated is naturally 0 — no special-casing needed.
 */
export async function runSectorVerification(
  db: Database.Database,
  opts: {
    apply: boolean;
    all?: boolean;
    symbols?: string[];
    fetchVerdicts?: (batch: SweepCandidate[]) => Promise<string>;
  },
): Promise<SweepResult> {
  const fetcher = opts.fetchVerdicts ?? defaultFetchVerdicts;
  const candidates = getSweepCandidates(db, { all: opts.all, symbols: opts.symbols });

  const rows: SweepRowResult[] = [];
  const unresolved: { symbol: string; reason: string }[] = [];
  const totalBatches = Math.ceil(candidates.length / SWEEP_BATCH_SIZE);

  for (let i = 0; i < candidates.length; i += SWEEP_BATCH_SIZE) {
    const batch = candidates.slice(i, i + SWEEP_BATCH_SIZE);
    const batchNum = i / SWEEP_BATCH_SIZE + 1;
    console.log(
      `[verify-sector-tags] batch ${batchNum}/${totalBatches} (${batch.length} symbols)...`,
    );
    let verdicts: SectorVerdict[];
    try {
      const text = await fetcher(batch);
      verdicts = parseVerdicts(text);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      for (const c of batch) unresolved.push({ symbol: c.symbol, reason });
      continue;
    }
    const applied = applyVerdicts(db, batch, verdicts, { apply: opts.apply });
    rows.push(...applied.rows);
    unresolved.push(...applied.unresolved);
  }

  const optionRowsUpdated = cascadeOptionSectors(db, { apply: opts.apply });

  return { rows, unresolved, optionRowsUpdated, applied: opts.apply };
}
