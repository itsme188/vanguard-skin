// Lenient reader and exact writer for figures typed on the desk (the bogey edit
// box). Pure and import-free: a client component imports it.
//
// Scale is applied by shifting the decimal exponent in text, never by float
// multiplication, so "3.35B" is exactly 3.35e9 and the writer can promise
// readDeskFigure(formatDeskFigure(x, k), k).value === x.

export type DeskFigureKind = "usd" | "per_share" | "pct" | "count";

export interface DeskFigureResult {
  value: number | null;
  error: string | null;
  /** True when an approximator (~, c., about...) or a trailing + was present. */
  approximate: boolean;
}

const HINTS: Record<DeskFigureKind, string> = {
  usd: "a dollar figure like 3.35B or $3,350M",
  per_share: "a per-share figure like 1.07",
  pct: "a percent like 28 or 28%",
  count: "a number like 1200",
};

const SCALE_EXP: Record<string, number> = {
  k: 3, thousand: 3,
  m: 6, mm: 6, mn: 6, mil: 6, mln: 6, million: 6, millions: 6,
  b: 9, bn: 9, bln: 9, billion: 9, billions: 9,
  t: 12, tn: 12, trillion: 12, trillions: 12,
};

const PCT_SUFFIXES = new Set(["", "%", "pct", "percent"]);
const APPROXIMATOR = /^(?:~|≈|circa\b|approx\.?|ca\.|c\.|about\b|around\b)\s*/i;

function nothing(): DeskFigureResult {
  return { value: null, error: null, approximate: false };
}

function fail(error: string, approximate = false): DeskFigureResult {
  return { value: null, error, approximate };
}

function unreadable(raw: string, kind: DeskFigureKind, approximate: boolean): DeskFigureResult {
  return fail(`Couldn't read “${raw.trim()}” as ${HINTS[kind]}.`, approximate);
}

export function readDeskFigure(raw: string, kind: DeskFigureKind): DeskFigureResult {
  const original = typeof raw === "string" ? raw : "";
  let s = original.trim();
  if (s === "") return nothing();

  let approximate = false;
  for (;;) {
    const m = APPROXIMATOR.exec(s);
    if (!m) break;
    approximate = true;
    s = s.slice(m[0].length).trimStart();
  }
  if (s.endsWith("+")) {
    approximate = true;
    s = s.slice(0, -1).trimEnd();
  }

  // Currency markers, before or after (dollar kinds only).
  const hadCurrency = /\$|\busd\b/i.test(s);
  if (hadCurrency) {
    if (kind !== "usd" && kind !== "per_share") return unreadable(original, kind, approximate);
    s = s.replace(/us\s*\$|\$|\busd\b/gi, " ").replace(/\s+/g, " ").trim();
  }

  // Sign forms: parentheses, plus-minus (pct only), leading plus (pct only).
  let negative = false;
  const paren = /^\(\s*(.*?)\s*\)$/.exec(s);
  if (paren) {
    negative = true;
    s = paren[1];
  }
  if (kind === "pct") {
    const stripped = s.replace(/^(?:±|\+\s*\/\s*-|\+)\s*/, "");
    if (stripped !== s && /^[-+]/.test(stripped)) return unreadable(original, kind, approximate);
    s = stripped;
  }

  // A range is never turned into one number.
  const range =
    /^([\d.,]+)\s*([a-z%]*)\s*(?:-|–|—|\bto\b)\s*([\d.,]+)\s*([a-z%]*)$/i.exec(s);
  if (range) {
    const sfx = range[4] || range[2];
    const lo = `${range[1]}${range[2] || sfx}`;
    const hi = `${range[3]}${sfx}`;
    return fail(`That looks like a range (${lo} to ${hi}). Enter one number.`, approximate);
  }

  const m = /^(-)?\s*([\d.,]*)\s*([a-z%]*(?:\s+[a-z]+)?)$/i.exec(s);
  if (!m) return unreadable(original, kind, approximate);
  // A sign inside parentheses is a doubled sign: "(-0.12)" could mean either
  // direction, so it is refused rather than read as positive (review w1 #1).
  if (m[1] && negative) return unreadable(original, kind, approximate);
  if (m[1]) negative = true;
  // Commas must group thousands ("3,350" or "1,234,567.5"). A comma that does
  // not ("3,35B", a decimal comma) would silently scale the figure 100x, so it
  // is refused (review w1 #2; this reader is new, so parseLargeUSD's looser
  // comma rule is not carried over).
  if (m[2].includes(",") && !/^\d{1,3}(?:,\d{3})+(?:\.\d*)?$/.test(m[2])) {
    return unreadable(original, kind, approximate);
  }
  const mantissa = m[2].replace(/,/g, "");
  if (!/^(?:\d+\.?\d*|\.\d+)$/.test(mantissa)) return unreadable(original, kind, approximate);
  const suffix = m[3].toLowerCase().replace(/\s+/g, " ").trim();

  if (suffix === "bps" || suffix === "bp" || suffix === "basis points") {
    return fail("Basis points aren't supported. Enter the figure in percent, like 0.28.", approximate);
  }

  let exp = 0;
  if (kind === "usd" || kind === "count") {
    if (suffix !== "") {
      const e = SCALE_EXP[suffix];
      if (e === undefined) return unreadable(original, kind, approximate);
      exp = e;
    }
  } else if (kind === "pct") {
    if (!PCT_SUFFIXES.has(suffix)) {
      return SCALE_EXP[suffix] !== undefined
        ? fail("A scale word doesn't fit a percent. Enter a plain number like 28 or 28%.", approximate)
        : unreadable(original, kind, approximate);
    }
  } else if (suffix !== "") {
    return SCALE_EXP[suffix] !== undefined
      ? fail("A scale word doesn't fit a per-share figure. Enter a plain number like 1.07.", approximate)
      : unreadable(original, kind, approximate);
  }

  const n = Number(`${mantissa}e${exp}`);
  if (!Number.isFinite(n)) return unreadable(original, kind, approximate);
  const value = negative ? -n : n;
  return { value: value === 0 ? 0 : value, error: null, approximate };
}

/** Plain decimal text for a finite number, never exponent notation. */
function plainText(x: number): string {
  const s = String(x);
  const m = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
  if (!m) return s;
  const [, sign, int, frac = "", expStr] = m;
  const digits = int + frac;
  const point = int.length + Number(expStr);
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

const SCALES: Array<[number, string]> = [
  [12, "T"],
  [9, "B"],
  [6, "M"],
  [3, "K"],
];

/** Shortest text that reads back to exactly the same number. */
export function formatDeskFigure(value: number, kind: DeskFigureKind): string {
  if (!Number.isFinite(value)) return "";
  const plain = plainText(value === 0 ? 0 : value);
  if (kind !== "usd") return plain;
  const abs = Math.abs(value);
  let best = plain;
  for (const [exp, letter] of SCALES) {
    if (abs < 10 ** exp) continue;
    const text = `${plainText(Number((value / 10 ** exp).toPrecision(15)))}${letter}`;
    if (text.length <= best.length && readDeskFigure(text, "usd").value === value) {
      best = text;
      break;
    }
  }
  return best;
}
