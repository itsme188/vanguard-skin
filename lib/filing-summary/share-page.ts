/**
 * The shareable page (spec §10, Hardening 6, 7, 8, 14, R15): one
 * self-contained HTML document built from a stored run, for the owner to send
 * to one or two people.
 *
 * Contract:
 *   - Every text that reaches the page goes through `escapeHtml`, once, at the
 *     point it is written into markup. Filing text and model output are data.
 *   - No `<script>`, no app links: the only links are sec.gov archive links
 *     rebuilt here from the filing's stored CIK, accession and file name
 *     through `secArchiveUrl` / `textFragmentUrl`.
 *   - Inline `<style>` with light and dark themes (`prefers-color-scheme`);
 *     readable at phone width (no fixed widths, long words wrap).
 *   - Privacy (R15): built only from a `FullView`, which carries filing text,
 *     checked claims, the bogey snapshot's public fields and dates. No
 *     portfolio field exists on that input.
 */
import type { Footnote } from "./types";
import { bogeyValueText, comparisonLine, countsText, modelQuoteLine, reasonText, sectionErrorSentence, statusLabel, statusSeverity } from "./labels";
import { secArchiveUrl, textFragmentUrl } from "./locate";
import type { FullRun, FullSection, FullView, PublicBogey, ViewClaim } from "./view";

// ---------------------------------------------------------------- escaping

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** The one escaper: every text and attribute value on the page goes through it. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

// ---------------------------------------------------------------- words
// Status, count, reason and failure words come from `./labels` (the one copy
// shared with the full page and the panel).

/** "META · Q3 filing summary · Opus 5.5 high · 12 claims · 9 checked · …" */
export function shareHeaderLine(view: FullView, run: FullRun): string {
  const who = view.event.symbol ?? "Filing";
  const title = run.quarterLabel ? `${run.quarterLabel} filing summary` : "filing summary";
  return `${who} · ${title} · ${run.modelLabel} ${run.effort} · ${countsText(run.counts)}`;
}


// ---------------------------------------------------------------- links

/** sec.gov link from the section's stored identity only (Hardening 8); null when any part is invalid. */
function footnoteUrl(section: FullSection, f: Footnote): string | null {
  try {
    const base = secArchiveUrl(section.cik, section.accession, f.document);
    return f.status === "found" && f.sentence ? textFragmentUrl(base, f.sentence) : base;
  } catch {
    return null;
  }
}

function link(url: string | null, text: string): string {
  if (!url) return escapeHtml(text);
  return `<a href="${escapeHtml(url)}" rel="noreferrer">${escapeHtml(text)}</a>`;
}

// ---------------------------------------------------------------- blocks

const STYLE = `
:root{color-scheme:light dark;--bg:#ffffff;--fg:#1a1a1a;--dim:#4a4a4a;--edge:#d6d6d6;--panel:#f5f5f2;
--danger:#a3141d;--warn:#7a4b00;--muted:#4d4d4d;--ok:#1d6b35;--link:#0b4fa8;--banner:#fff3d6}
@media (prefers-color-scheme:dark){:root{--bg:#121212;--fg:#ececec;--dim:#b8b8b8;--edge:#3a3a3a;--panel:#1d1d1d;
--danger:#ff8a8a;--warn:#f2c46b;--muted:#bdbdbd;--ok:#7fd69a;--link:#8fbfff;--banner:#3a2d0f}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
main{max-width:52rem;margin:0 auto;padding:16px}
h1{font-size:1.25rem;line-height:1.3;margin:0 0 4px}
h2{font-size:1.1rem;margin:28px 0 8px;border-bottom:1px solid var(--edge);padding-bottom:4px}
h3{font-size:1rem;margin:16px 0 6px}
p,li,td,th{overflow-wrap:anywhere}
.sub{color:var(--dim);margin:0 0 12px}
.banner{background:var(--banner);border:1px solid var(--edge);padding:8px 12px;border-radius:6px;margin:12px 0}
.claims{list-style:none;padding:0;margin:0}
.claim{border:1px solid var(--edge);border-radius:6px;padding:10px 12px;margin:8px 0;background:var(--panel)}
.status{font-weight:600;font-size:0.9rem}
.s-danger{color:var(--danger)}.s-warning{color:var(--warn)}.s-muted{color:var(--muted)}.s-ok{color:var(--ok)}
.reasons{margin:4px 0 0;padding-left:20px;color:var(--dim);font-size:0.95rem}
.fn{font-size:0.85rem;vertical-align:super}
.notes{font-size:0.95rem;color:var(--dim)}
a{color:var(--link)}
table{border-collapse:collapse;width:100%;font-size:0.95rem}
th,td{text-align:left;border-bottom:1px solid var(--edge);padding:6px 4px;vertical-align:top}
footer{margin-top:32px;color:var(--dim);font-size:0.9rem}
`;

function claimBlock(section: FullSection, claim: ViewClaim, fnNumbers: Map<string, number>): string {
  const severity = statusSeverity(claim.status);
  const markers = claim.footnotes
    .map((f) => {
      const n = fnNumbers.get(`${claim.claimId}:${f.citationId}`);
      return n === undefined ? "" : `<span class="fn">${link(footnoteUrl(section, f), `[${n}]`)}</span>`;
    })
    .join("");
  const reasons: string[] = [];
  const seen = new Set<string>();
  const addReason = (code: string) => {
    if (seen.has(code)) return;
    seen.add(code);
    reasons.push(`<li>${escapeHtml(reasonText(code))}</li>`);
  };
  for (const r of claim.reasons) addReason(r.code);
  for (const fc of claim.figureChecks) for (const r of fc.reasons) addReason(r.code);
  for (const cc of claim.comparisonChecks) for (const r of cc.reasons) addReason(r.code);
  const shown = claim.comparisonChecks.map(
    (cc) =>
      `<li${cc.verdict === "contradicted" ? ' class="s-danger"' : ""}>${escapeHtml(comparisonLine(cc))}</li>`,
  );
  const corrected = claim.correctedBy
    ? `<p class="notes">${escapeHtml(
        `Corrected by ${claim.correctedBy.form}${claim.correctedBy.acceptedAtEt ? `, ${claim.correctedBy.acceptedAtEt}` : ""}`,
      )}</p>`
    : "";
  const list = [...shown, ...reasons];
  return `<li class="claim"><div class="status s-${severity}">${escapeHtml(
    `${statusLabel(claim.status)}${claim.top ? " · Top" : ""}`,
  )}</div><p>${escapeHtml(claim.renderedText)}${markers}</p>${corrected}${
    list.length ? `<ul class="reasons">${list.join("")}</ul>` : ""
  }</li>`;
}

function sectionBlock(section: FullSection): string {
  const when = section.acceptedAtEt
    ? `accepted ${section.acceptedAtEt} ET${section.acceptedOnEt ? `, ${section.acceptedOnEt}` : ""}`
    : "acceptance time unconfirmed";
  const head = `<h2>${escapeHtml(`${section.form} · ${when}`)}</h2><p class="sub">${escapeHtml(
    `Accession ${section.accession}`,
  )}</p>`;
  if (section.status !== "done") {
    const state =
      section.status === "waiting_retry"
        ? "Waiting for Retry: this filing arrived after the run failed."
        : section.status === "failed"
          ? sectionErrorSentence(section.errorClass, section.errorText)
          : "Still being read.";
    return `${head}<p class="banner">${escapeHtml(state)}</p>`;
  }

  // Footnotes numbered in claim order within the section.
  const fnNumbers = new Map<string, number>();
  const footnotes: string[] = [];
  for (const c of section.claims) {
    for (const f of c.footnotes) {
      const key = `${c.claimId}:${f.citationId}`;
      if (fnNumbers.has(key)) continue;
      const n = footnotes.length + 1;
      fnNumbers.set(key, n);
      const where =
        f.status !== "found"
          ? f.status === "ambiguous"
            ? "quote matches more than once"
            : "quote not found"
          : f.page !== null && f.para !== null
            ? `page ${f.page}, paragraph ${f.para}`
            : f.para !== null
              ? `paragraph ${f.para}`
              : "";
      footnotes.push(
        `<li>${escapeHtml(`${f.document}${where ? ` · ${where}` : ""}`)}${
          f.sentence ? ` — “${escapeHtml(f.sentence)}”` : ""
        }${f.status !== "found" && f.modelQuote ? ` — ${escapeHtml(modelQuoteLine(f.modelQuote))}` : ""} ${link(footnoteUrl(section, f), "open on sec.gov")}</li>`,
      );
    }
  }
  const claims = section.claims.map((c) => claimBlock(section, c, fnNumbers)).join("");
  const coverage = section.coverage
    .map(
      (e) =>
        `<li>${escapeHtml(`${e.fileName} (${e.docType}): ${e.status}${e.reason ? ` — ${e.reason}` : ""}`)}</li>`,
    )
    .join("");
  return `${head}${
    section.incomplete
      ? `<p class="banner">${escapeHtml("Incomplete: part of this filing was skipped or could not be read (see coverage).")}</p>`
      : ""
  }${section.headline ? `<h3>${escapeHtml(section.headline)}</h3>` : ""}<p class="sub">${escapeHtml(
    countsText(section.counts ?? { claims: 0, checked: 0, contradicted: 0, warning: 0, unconfirmed: 0, qualitative: 0 }),
  )}</p><ul class="claims">${claims}</ul>${
    footnotes.length ? `<h3>Footnotes</h3><ol class="notes">${footnotes.join("")}</ol>` : ""
  }${coverage ? `<h3>Coverage</h3><ul class="notes">${coverage}</ul>` : ""}`;
}

function bogeyBlock(bogeys: PublicBogey[]): string {
  if (bogeys.length === 0) return "";
  const rows = bogeys
    .map(
      (b) =>
        `<tr><td>${escapeHtml(b.label)}</td><td>${escapeHtml(bogeyValueText(b))}</td><td>${escapeHtml(
          b.provenance,
        )}</td><td>${escapeHtml(b.asOf)}</td></tr>`,
    )
    .join("");
  return `<h2>Bogeys before the print</h2><table><thead><tr><th>Figure</th><th>Value</th><th>Source</th><th>As of</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function filingsBlock(view: FullView, run: FullRun): string {
  const inRun = new Set(run.sections.map((s) => s.filingId));
  const rows = view.filings
    .filter((f) => inRun.has(f.filingId))
    .map((f) => {
      const when = f.acceptedAtEt ? `${f.acceptedAtEt} ET${f.acceptedOnEt ? `, ${f.acceptedOnEt}` : ""}` : "time unconfirmed";
      return `<li>${escapeHtml(`${f.form} · accepted ${when} · accession ${f.accession}`)} ${link(
        f.indexUrl,
        "filing on sec.gov",
      )}</li>`;
    })
    .join("");
  return rows ? `<h2>Filings</h2><ul class="notes">${rows}</ul>` : "";
}

// ---------------------------------------------------------------- page

/** The run's shareable page. Throws when the run is not in the view. */
export function renderSharePage(view: FullView, runId: number): string {
  const run = view.runs.find((r) => r.runId === runId);
  if (!run) throw new Error("run not found");
  const header = shareHeaderLine(view, run);
  const sub = [
    view.event.companyName,
    `print of ${view.event.eventDate}`,
    `run ${run.runNo}`,
    run.createdAtEt ? `started ${run.createdAtEt} ET${run.createdOnEt ? `, ${run.createdOnEt}` : ""}` : null,
  ]
    .filter((x): x is string => !!x)
    .join(" · ");
  const banners: string[] = [];
  if (run.incomplete) {
    banners.push("Incomplete: at least one filing was only partly read. The coverage lists say what was skipped and why.");
  }
  if (run.status === "failed") banners.push("This run did not finish every filing.");
  if (run.status === "waiting_retry") banners.push("A later filing waits for a Retry and is not included.");
  if (run.fallbackNote) banners.push(run.fallbackNote);
  if (run.excludesAfterEt) banners.push(`Does not include filings found after ${run.excludesAfterEt} ET.`);
  const contradictedTop = run.sections.flatMap((s) => s.claims).filter((c) => c.top && c.status === "contradicted");
  if (contradictedTop.length > 0) {
    banners.push(
      `${contradictedTop.length} Top ${contradictedTop.length === 1 ? "claim is" : "claims are"} contradicted by the filing's own figures.`,
    );
  }
  const title = `${view.event.symbol ?? "Filing"} filing summary — run ${run.runNo}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>${escapeHtml(header)}</h1>
<p class="sub">${escapeHtml(sub)}</p>
${banners.map((b) => `<p class="banner">${escapeHtml(b)}</p>`).join("\n")}
${run.sections.map(sectionBlock).join("\n")}
${bogeyBlock(run.bogeys)}
${filingsBlock(view, run)}
<footer>${escapeHtml(
    `Summary written by ${run.modelLabel} at ${run.effort} effort. Every figure was checked by the app against the filing text; statuses say what could and could not be confirmed. Bogeys are pre-print estimates with their sources.`,
  )}</footer>
</main>
</body>
</html>
`;
}

/** `<SYMBOL>-<date>-filing-summary-run<N>.html`, with only safe file-name characters. */
export function shareFileName(view: FullView, runNo: number): string {
  const symbol = (view.event.symbol ?? "filing").replace(/[^A-Za-z0-9.-]/g, "") || "filing";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(view.event.eventDate) ? view.event.eventDate : "undated";
  return `${symbol}-${date}-filing-summary-run${runNo}.html`;
}
