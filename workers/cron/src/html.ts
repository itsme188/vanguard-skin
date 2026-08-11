/**
 * Markdown → styled HTML for cloud-fallback emails.
 *
 * Mirrors Mac's lib/calendar/briefing-html.ts (locked 2026-05-03 light Amber
 * theme). Identical visual output so recipients can't tell a fallback email
 * apart from a primary email by eye. Footer note slot is the only difference
 * when populated.
 *
 * Quote handling: font-family names with spaces use SINGLE quotes inside the
 * double-quoted style attribute. Mixing double quotes silently drops every
 * style property after the inner quote — the bug that ate ~30 minutes on
 * 2026-05-03. Never reintroduce.
 */

const COLORS = {
  canvas: "#fafaf3",
  edge: "#e5e3d8",
  ink: "#0a0a0a",
  inkDim: "#2a2a26",
  inkFaint: "#54574c",
  gold: "#b8860b",
  goldGlow: "#fff4d6",
};

const TABLE_COLORS = {
  headerBg: "#f4efe0",
  headerText: "#3a2e0f",
  bodyBg: "#ffffff",
  bodyText: "#1a1a1a",
  border: "#777777",
  labelText: "#1a1a1a",
};

const FONT_BODY =
  "'IBM Plex Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const FONT_MONO =
  "'IBM Plex Mono', 'SF Mono', Menlo, Consolas, 'Courier New', monospace";

export function briefingToHtml(
  markdown: string,
  title: string,
  footerNote?: string,
): string {
  const bodyHtml = convertMarkdown(markdown);
  const footerNoteHtml = footerNote
    ? `<p style="margin:10px 0 0; font-family:${FONT_BODY}; font-size:13px; line-height:1.5; color:${COLORS.inkFaint}; font-style:italic;">${escapeHtml(footerNote)}</p>`
    : "";

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0; padding:0; background-color:${COLORS.canvas}; font-family:${FONT_BODY}; -webkit-font-smoothing:antialiased; -moz-osx-font-smoothing:grayscale;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${COLORS.canvas};">
    <tr>
      <td align="center" style="padding:48px 20px 56px;">
        <table role="presentation" width="680" cellpadding="0" cellspacing="0" border="0" style="max-width:680px; width:100%;">
          <tr>
            <td style="padding:0 0 32px;">
              <p style="margin:0; font-family:${FONT_BODY}; font-size:11px; font-weight:600; color:${COLORS.gold}; letter-spacing:0.16em; text-transform:uppercase;">Portfolio Desk</p>
            </td>
          </tr>
          <tr>
            <td style="font-family:${FONT_BODY}; font-size:18px; line-height:1.7; color:${COLORS.inkDim};">
              ${bodyHtml}
            </td>
          </tr>
          <tr>
            <td style="padding:64px 0 0;">
              <div style="border-top:1px solid ${COLORS.edge}; padding-top:28px;">
                <p style="margin:0; font-family:${FONT_BODY}; font-size:12px; color:${COLORS.inkFaint}; line-height:1.6;">
                  Portfolio Desk &middot; Generated ${formatDate(new Date())}
                </p>
                ${footerNoteHtml}
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    timeZone: "America/New_York", // Worker runs in UTC — render the ET market day
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const tableRowRe = /^\|(.+)\|\s*$/;
const tableSeparatorRe = /^\|(\s*:?-+:?\s*\|)+\s*$/;

function parseTableRow(line: string): string[] {
  return line
    .trim()
    .slice(1, -1)
    .split(/(?<!\\)\|/)
    .map((s) => s.trim().replace(/\\\|/g, "|"));
}

function isFillableCell(text: string): boolean {
  const t = text.trim();
  return t === "" || t === "—" || t === "-" || t === "–";
}

function renderTable(headers: string[], rows: string[][]): string {
  const headerCells = headers
    .map(
      (h) =>
        `<th style="border:1px solid ${TABLE_COLORS.border}; padding:8px 10px; background-color:${TABLE_COLORS.headerBg}; color:${TABLE_COLORS.headerText}; font-family:${FONT_BODY}; font-size:11px; font-weight:600; text-align:left; text-transform:uppercase; letter-spacing:0.06em; white-space:nowrap;">${inlineFormat(h)}</th>`,
    )
    .join("");

  const bodyRows = rows
    .map((row) => {
      const cells = row
        .map((c, idx) => {
          const fillable = isFillableCell(c);
          const isLabel = idx === 0;
          const content = fillable && !isLabel ? "&nbsp;" : inlineFormat(c) || "&nbsp;";
          const padding = !isLabel && fillable ? "14px 10px" : "8px 10px";
          const align = !isLabel ? "text-align:right;" : "";
          const numAlign = !isLabel
            ? `font-variant-numeric:tabular-nums; font-family:${FONT_MONO};`
            : `font-family:${FONT_BODY};`;
          const cellColor = isLabel ? TABLE_COLORS.labelText : TABLE_COLORS.bodyText;
          const fontWeight = isLabel ? "font-weight:500;" : "";
          return `<td style="border:1px solid ${TABLE_COLORS.border}; padding:${padding}; background-color:${TABLE_COLORS.bodyBg}; color:${cellColor}; font-size:13px; ${fontWeight} ${align} ${numAlign}">${content}</td>`;
        })
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse; margin:20px 0; width:100%; border:1px solid ${TABLE_COLORS.border}; background-color:${TABLE_COLORS.bodyBg};">
<thead><tr>${headerCells}</tr></thead>
<tbody>${bodyRows}</tbody>
</table>`;
}

/**
 * Consume a table body starting at `j` (first line after the separator),
 * absorbing model-emitted MULTI-LINE logical rows
 * (qa:email-html--multiline-table-row-spills-raw-markdown-pipes): an
 * unterminated `| a | b` start accumulates physical lines until its closing
 * pipe, and a bare fragment line BETWEEN pipe rows glues onto the previous
 * row's last cell. A fragment with no further pipe line before the next blank
 * ends the table instead (trailing prose stays prose). Pre-fix, the first
 * non-pipe line closed the parser and every later |-line spilled as a literal
 * pipe paragraph in the delivered email.
 */
function consumeTableBody(
  lines: string[],
  startIdx: number,
): { dataRows: string[][]; nextIndex: number } {
  const dataRows: string[][] = [];
  let pending = "";
  let j = startIdx;
  while (j < lines.length) {
    const t = lines[j].trim();
    if (t === "") break;
    if (pending !== "") {
      pending = `${pending} ${t}`;
      if (tableRowRe.test(pending)) {
        if (!tableSeparatorRe.test(pending)) dataRows.push(parseTableRow(pending));
        pending = "";
      }
      j++;
      continue;
    }
    if (tableRowRe.test(t)) {
      if (!tableSeparatorRe.test(t)) dataRows.push(parseTableRow(t));
      j++;
      continue;
    }
    if (t.startsWith("|")) {
      pending = t;
      j++;
      continue;
    }
    // Bare fragment: only table content when another pipe line follows before
    // the next blank — otherwise it is ordinary prose after the table.
    let continues = false;
    for (let k = j + 1; k < lines.length; k++) {
      const u = lines[k].trim();
      if (u === "") break;
      if (u.startsWith("|")) { continues = true; break; }
    }
    if (!continues || dataRows.length === 0) break;
    const last = dataRows[dataRows.length - 1];
    last[last.length - 1] = `${last[last.length - 1]} ${t}`.trim();
    j++;
  }
  if (pending !== "") {
    // Dangling partial row at table end — close it best-effort rather than
    // spilling raw pipes.
    const closed = pending.endsWith("|") ? pending : `${pending} |`;
    if (tableRowRe.test(closed) && !tableSeparatorRe.test(closed)) {
      dataRows.push(parseTableRow(closed));
    }
  }
  return { dataRows, nextIndex: j };
}

function convertMarkdown(md: string): string {
  const lines = md.split("\n");
  const output: string[] = [];
  let inList = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (
      tableRowRe.test(line.trim()) &&
      i + 1 < lines.length &&
      tableSeparatorRe.test(lines[i + 1].trim())
    ) {
      if (inList) { output.push("</ul>"); inList = false; }
      const headerCells = parseTableRow(line);
      const { dataRows, nextIndex } = consumeTableBody(lines, i + 2);
      output.push(renderTable(headerCells, dataRows));
      i = nextIndex - 1;
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      if (inList) { output.push("</ul>"); inList = false; }
      output.push(
        `<hr style="border:none; border-top:1px solid ${COLORS.edge}; margin:44px 0;">`,
      );
      continue;
    }

    if (line.startsWith("### ")) {
      if (inList) { output.push("</ul>"); inList = false; }
      const text = inlineFormat(line.slice(4));
      output.push(
        `<h3 style="margin:36px 0 14px; font-family:${FONT_BODY}; font-size:18px; font-weight:600; color:${COLORS.ink}; line-height:1.4;">${text}</h3>`,
      );
      continue;
    }
    if (line.startsWith("## ")) {
      if (inList) { output.push("</ul>"); inList = false; }
      const text = inlineFormat(line.slice(3));
      output.push(
        `<h2 style="margin:52px 0 18px; padding-bottom:12px; font-family:${FONT_BODY}; font-size:22px; font-weight:600; color:${COLORS.ink}; border-bottom:1px solid ${COLORS.edge}; line-height:1.3; letter-spacing:-0.005em;">${text}</h2>`,
      );
      continue;
    }
    if (line.startsWith("# ")) {
      if (inList) { output.push("</ul>"); inList = false; }
      const text = inlineFormat(line.slice(2));
      output.push(
        `<h1 style="margin:0 0 22px; font-family:${FONT_BODY}; font-size:28px; font-weight:600; color:${COLORS.gold}; letter-spacing:-0.01em;">${text}</h1>`,
      );
      continue;
    }

    if (line.startsWith("> ")) {
      if (inList) { output.push("</ul>"); inList = false; }
      const text = inlineFormat(line.slice(2));
      output.push(
        `<blockquote style="margin:28px 0; padding:16px 22px; border-left:3px solid ${COLORS.gold}; background-color:${COLORS.goldGlow}; color:${COLORS.inkDim}; font-family:${FONT_BODY}; font-size:17px; line-height:1.7; font-style:italic;">${text}</blockquote>`,
      );
      continue;
    }

    const bulletMatch = line.match(/^(\s*)[-*]\s+(.+)/);
    const numberedMatch = line.match(/^(\s*)\d+\.\s+(.+)/);
    if (bulletMatch || numberedMatch) {
      const match = bulletMatch ?? numberedMatch!;
      const indent = match[1].length;
      const text = inlineFormat(match[2]);
      if (!inList) {
        output.push(`<ul style="margin:18px 0; padding-left:28px; list-style-type:disc;">`);
        inList = true;
      }
      const marginLeft = indent > 2 ? "margin-left:20px;" : "";
      output.push(
        `<li style="margin:14px 0; color:${COLORS.inkDim}; font-family:${FONT_BODY}; font-size:18px; line-height:1.7; ${marginLeft}">${text}</li>`,
      );
      continue;
    }

    if (inList && line.trim() === "") {
      output.push("</ul>");
      inList = false;
      continue;
    }
    if (inList && line.trim() !== "") {
      output.push("</ul>");
      inList = false;
    }

    if (line.trim() === "") continue;

    output.push(
      `<p style="margin:22px 0; font-family:${FONT_BODY}; font-size:18px; line-height:1.7; color:${COLORS.inkDim};">${inlineFormat(line)}</p>`,
    );
  }

  if (inList) output.push("</ul>");
  return output.join("\n");
}

function inlineFormat(text: string): string {
  // Links first — must run before bold/italic so [**foo**](url) works. The
  // URL is swapped for a NUL-delimited (\u0000) index placeholder while the
  // emphasis passes run: real-world hrefs (Stratechery ?access_token=<JWT>,
  // beehiiv link-redirect JWTs) contain _ and *, and running `_(.+?)_` over
  // the generated href injected <em> INSIDE the attribute — mail clients
  // rejected the mangled anchor and leaked the raw token as visible text
  // (2026-07-20 digest). A NUL byte cannot appear in email markdown, so the
  // placeholder can never collide or be emphasized. Mirror of
  // lib/calendar/briefing-html.ts — change BOTH sides together.
  const urls: string[] = [];
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) => {
    const i = urls.push(url) - 1;
    return `<a href="\u0000${i}\u0000" style="color:${COLORS.gold}; text-decoration:underline; text-underline-offset:2px;">${label}</a>`;
  });
  text = text.replace(/\*\*(.+?)\*\*/g, `<strong style="color:${COLORS.ink};">$1</strong>`);
  text = text.replace(/__(.+?)__/g, `<strong style="color:${COLORS.ink};">$1</strong>`);
  text = text.replace(/\*(.+?)\*/g, "<em>$1</em>");
  text = text.replace(/_(.+?)_/g, "<em>$1</em>");
  text = text.replace(
    /`(.+?)`/g,
    `<code style="background:${COLORS.goldGlow}; color:${COLORS.inkDim}; padding:1px 6px; border-radius:3px; font-family:${FONT_MONO}; font-size:15px;">$1</code>`,
  );
  text = text.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => urls[Number(i)]);
  return text;
}
