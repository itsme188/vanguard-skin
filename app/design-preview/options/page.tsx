import Link from "next/link";

interface Palette {
  id: "glacier" | "sage" | "seaglass";
  name: string;
  tagline: string;
  inspiredBy: string;
  pageBg: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  ink: string;
  inkDim: string;
  brand: string;
  up: string;
  upTint: string;
  down: string;
  downTint: string;
  accent: string;
  tint1: string;
  tint2: string;
  tint3: string;
}

const PALETTES: Palette[] = [
  {
    id: "glacier",
    name: "Glacier + Slate Navy",
    tagline: "Cool, institutional. The 'modern brokerage tool' option.",
    inspiredBy: "Glacier National Park · Navy · Dark Astronaut",
    pageBg: "#f5f7f9",
    surface: "#ffffff",
    surfaceAlt: "#fafbfc",
    border: "#dee2e6",
    ink: "#1c2733",
    inkDim: "#5d6b7a",
    brand: "#243447",
    up: "#4a7780",
    upTint: "#dbe4e4",
    down: "#8b4f5d",
    downTint: "#efe0e3",
    accent: "#5d8a93",
    tint1: "#e8edf2",
    tint2: "#dbe4e4",
    tint3: "#ece8e1",
  },
  {
    id: "sage",
    name: "Sage & Linen",
    tagline: "Warmer, residential — like a study or a library.",
    inspiredBy: "Burned Sage Leaves · Nice Neutrals · 18th Century Green",
    pageBg: "#f7f4ed",
    surface: "#fffefa",
    surfaceAlt: "#f3efe5",
    border: "#e2dfd4",
    ink: "#2a2c26",
    inkDim: "#6b6e62",
    brand: "#3a4a3f",
    up: "#5a7a5c",
    upTint: "#e1e9dc",
    down: "#a05a4f",
    downTint: "#efdfd9",
    accent: "#8a9a7c",
    tint1: "#e8eee2",
    tint2: "#f0ebe1",
    tint3: "#ece4d3",
  },
  {
    id: "seaglass",
    name: "Sea Glass + Deep Water",
    tagline: "Cooler than Sage, calmer than Glacier.",
    inspiredBy: "Sea Foam Algae · Glacier National Park",
    pageBg: "#f1f5f3",
    surface: "#ffffff",
    surfaceAlt: "#f5f8f6",
    border: "#d8e0db",
    ink: "#1d2a2c",
    inkDim: "#5a6c6e",
    brand: "#1e3d3a",
    up: "#4d8a7a",
    upTint: "#dceae3",
    down: "#b56b5e",
    downTint: "#f0dad4",
    accent: "#7eaaa0",
    tint1: "#e0ece8",
    tint2: "#d8e3df",
    tint3: "#ebe7dd",
  },
];

const HOLDINGS_DEMO = [
  { sym: "AAPL", name: "Apple Inc.", value: "$43,074", pct: "+1.21%", up: true },
  { sym: "MSFT", name: "Microsoft Corp.", value: "$38,569", pct: "+0.81%", up: true },
  { sym: "NVDA", name: "NVIDIA Corp.", value: "$24,987", pct: "+1.42%", up: true },
  { sym: "GOOG", name: "Alphabet Inc.", value: "$29,403", pct: "−0.25%", up: false },
];

const TYPOGRAPHY: Array<{
  id: string;
  name: string;
  tagline: string;
  bodyVar: string;
  monoVar?: string;
  headerVar?: string;
  hint: string;
}> = [
  {
    id: "inter",
    name: "Inter + Geist Mono",
    tagline: "Stripe / Linear / Carta. Most common professional choice.",
    bodyVar: "var(--font-inter)",
    monoVar: "var(--font-geist-mono)",
    hint: "Slight institutional gravitas over Geist. Same weight range, more neutral.",
  },
  {
    id: "geist-disciplined",
    name: "Geist (disciplined)",
    tagline: "Same fonts as today, but tighter scale + heavier weights.",
    bodyVar: "var(--font-geist-sans)",
    monoVar: "var(--font-geist-mono)",
    hint: "32px hero (not 56), weight 700 (not 600), tighter letter-spacing. Less work, less risk.",
  },
  {
    id: "source-inter",
    name: "Source Serif + Inter",
    tagline: "Serif for section titles only. Editorial-pro, like a Carta annual report.",
    bodyVar: "var(--font-inter)",
    monoVar: "var(--font-geist-mono)",
    headerVar: "var(--font-source-serif)",
    hint: "More restrained than Instrument Serif (which you didn't like). WSJ vibe.",
  },
  {
    id: "plex",
    name: "IBM Plex Sans + Plex Mono",
    tagline: "IBM's open-source data type system.",
    bodyVar: "var(--font-plex-sans)",
    monoVar: "var(--font-plex-mono)",
    hint: "More mechanical than Geist, more neutral than Inter. Used by data tools.",
  },
];

function PaletteCard({ p }: { p: Palette }) {
  return (
    <div
      style={{
        background: p.pageBg,
        borderRadius: 16,
        padding: 24,
        border: "1px solid rgba(0,0,0,0.06)",
        boxShadow: "0 1px 3px rgba(0,0,0,0.05), 0 6px 18px rgba(0,0,0,0.06)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4, color: p.ink }}>
        <h3 style={{ fontSize: 20, fontWeight: 600, margin: 0, letterSpacing: "-0.01em" }}>{p.name}</h3>
        <span
          style={{
            fontFamily: "var(--font-geist-mono)",
            fontSize: 11,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: p.inkDim,
          }}
        >
          {p.id}
        </span>
      </div>
      <p style={{ fontSize: 13, color: p.inkDim, margin: 0, marginBottom: 4 }}>{p.tagline}</p>
      <p style={{ fontSize: 12, color: p.inkDim, margin: 0, marginBottom: 18, fontStyle: "italic", opacity: 0.7 }}>
        Inspired by {p.inspiredBy}
      </p>

      {/* Color row */}
      <div style={{ display: "flex", gap: 6, marginBottom: 20, flexWrap: "wrap" }}>
        {[
          { c: p.brand, label: "Brand" },
          { c: p.up, label: "Up" },
          { c: p.down, label: "Down" },
          { c: p.accent, label: "Accent" },
          { c: p.tint1, label: "Tint A" },
          { c: p.tint2, label: "Tint B" },
          { c: p.tint3, label: "Tint C" },
          { c: p.surface, label: "Surface" },
          { c: p.border, label: "Border" },
        ].map((sw) => (
          <div key={sw.label} style={{ flex: "1 1 60px", minWidth: 60 }}>
            <div
              style={{
                width: "100%",
                height: 36,
                background: sw.c,
                borderRadius: 6,
                border: "1px solid rgba(0,0,0,0.06)",
              }}
            />
            <div style={{ fontFamily: "var(--font-geist-mono)", fontSize: 9, color: p.inkDim, marginTop: 3, letterSpacing: "0.04em" }}>
              {sw.label}
            </div>
            <div style={{ fontFamily: "var(--font-geist-mono)", fontSize: 9, color: p.ink, opacity: 0.5 }}>
              {sw.c}
            </div>
          </div>
        ))}
      </div>

      {/* Mini Today card */}
      <div
        style={{
          background: p.surface,
          borderRadius: 12,
          padding: 20,
          border: `1px solid ${p.border}`,
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 500,
            color: p.inkDim,
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            marginBottom: 6,
          }}
        >
          Tuesday · April 28
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
          <span
            style={{
              fontSize: 36,
              fontWeight: 600,
              letterSpacing: "-0.02em",
              color: p.ink,
              lineHeight: 1,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            $1,247,392
          </span>
          <span
            style={{
              padding: "3px 10px",
              borderRadius: 999,
              fontSize: 12,
              fontWeight: 500,
              background: p.upTint,
              color: p.up,
            }}
          >
            ▲ +0.79% today
          </span>
        </div>
        <div style={{ fontSize: 12, color: p.inkDim, marginTop: 6 }}>5 accounts · 47 positions</div>

        {/* Holdings rows */}
        <div style={{ marginTop: 18, borderTop: `1px solid ${p.border}` }}>
          {HOLDINGS_DEMO.map((h) => (
            <div
              key={h.sym}
              style={{
                display: "grid",
                gridTemplateColumns: "60px 1fr auto auto",
                gap: 12,
                padding: "10px 0",
                borderBottom: `1px solid ${p.border}`,
                alignItems: "center",
              }}
            >
              <span style={{ fontFamily: "var(--font-geist-mono)", fontSize: 13, fontWeight: 600, color: p.ink }}>
                {h.sym}
              </span>
              <span style={{ fontSize: 13, color: p.inkDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {h.name}
              </span>
              <span style={{ fontFamily: "var(--font-geist-mono)", fontSize: 13, color: p.ink, fontVariantNumeric: "tabular-nums" }}>
                {h.value}
              </span>
              <span
                style={{
                  fontFamily: "var(--font-geist-mono)",
                  fontSize: 12,
                  fontWeight: 500,
                  color: h.up ? p.up : p.down,
                  fontVariantNumeric: "tabular-nums",
                  minWidth: 56,
                  textAlign: "right",
                }}
              >
                {h.pct}
              </span>
            </div>
          ))}
        </div>

        {/* Alert chip row */}
        <div style={{ marginTop: 16, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span
            style={{
              fontSize: 11,
              padding: "3px 10px",
              background: p.brand,
              color: p.surface,
              borderRadius: 999,
              fontWeight: 500,
            }}
          >
            ★ Alert
          </span>
          <span
            style={{
              fontSize: 11,
              padding: "3px 10px",
              background: p.upTint,
              color: p.up,
              borderRadius: 999,
              fontWeight: 500,
            }}
          >
            GLW · Support reclaim
          </span>
          <span
            style={{
              fontSize: 11,
              padding: "3px 10px",
              background: p.tint3,
              color: p.inkDim,
              borderRadius: 999,
            }}
          >
            Vital Knowledge
          </span>
        </div>
      </div>
    </div>
  );
}

function TypographyCard({ t }: { t: (typeof TYPOGRAPHY)[number] }) {
  // Use Glacier palette as neutral background for typography comparison
  const p = PALETTES[0];
  const headerFont = t.headerVar ?? t.bodyVar;

  return (
    <div
      style={{
        background: p.surface,
        borderRadius: 16,
        padding: 24,
        border: `1px solid ${p.border}`,
        boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
        <h3 style={{ fontSize: 18, fontWeight: 600, margin: 0, color: p.ink, letterSpacing: "-0.01em" }}>
          {t.name}
        </h3>
        <span
          style={{
            fontFamily: "var(--font-geist-mono)",
            fontSize: 10,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: p.inkDim,
          }}
        >
          {t.id}
        </span>
      </div>
      <p style={{ fontSize: 13, color: p.inkDim, margin: 0, marginBottom: 4 }}>{t.tagline}</p>
      <p style={{ fontSize: 12, color: p.inkDim, margin: 0, marginBottom: 20, opacity: 0.75 }}>{t.hint}</p>

      <div
        style={{
          background: p.surfaceAlt,
          borderRadius: 10,
          padding: 18,
          fontFamily: t.bodyVar,
          color: p.ink,
        }}
      >
        <div
          style={{
            fontFamily: t.monoVar ?? t.bodyVar,
            fontSize: 11,
            fontWeight: 500,
            color: p.inkDim,
            textTransform: "uppercase",
            letterSpacing: "0.12em",
            marginBottom: 6,
          }}
        >
          Portfolio · Today
        </div>
        <div
          style={{
            fontFamily: headerFont,
            fontSize: 32,
            fontWeight: t.id === "geist-disciplined" ? 700 : 600,
            letterSpacing: "-0.02em",
            lineHeight: 1.05,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          $1,247,392
        </div>
        <div style={{ fontSize: 13, color: p.inkDim, marginTop: 4 }}>
          5 accounts · 47 positions · YTD <strong style={{ color: p.up }}>+12.4%</strong>
        </div>

        <div
          style={{
            marginTop: 16,
            paddingTop: 14,
            borderTop: `1px solid ${p.border}`,
            fontSize: 13,
            lineHeight: 1.55,
          }}
        >
          The 21-day moving average reclaim on{" "}
          <span style={{ fontFamily: t.monoVar, fontWeight: 600 }}>MSFT</span> coincided with a
          breakout above declared resistance at{" "}
          <span style={{ fontFamily: t.monoVar, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
            $425.00
          </span>
          .
        </div>

        <div
          style={{
            marginTop: 14,
            display: "grid",
            gridTemplateColumns: "1fr 80px 80px",
            gap: 12,
            paddingTop: 12,
            borderTop: `1px solid ${p.border}`,
            fontSize: 13,
            alignItems: "baseline",
            fontFamily: t.monoVar,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          <span style={{ fontFamily: t.bodyVar }}>NVDA · NVIDIA</span>
          <span style={{ textAlign: "right" }}>$24,987</span>
          <span style={{ textAlign: "right", color: p.up, fontWeight: 600 }}>+1.42%</span>
        </div>
      </div>
    </div>
  );
}

export default function OptionsPage() {
  return (
    <main style={{ maxWidth: 1180, margin: "0 auto", padding: "32px 20px 96px", minHeight: "100vh" }}>
      <header style={{ marginBottom: 36 }}>
        <Link
          href="/design-preview"
          style={{
            fontFamily: "var(--font-geist-mono)",
            fontSize: 11,
            letterSpacing: "0.22em",
            textTransform: "uppercase",
            color: "#5a5750",
            textDecoration: "none",
          }}
        >
          ← Direction Index
        </Link>
        <h1
          style={{
            fontSize: "clamp(36px, 5vw, 52px)",
            fontWeight: 600,
            letterSpacing: "-0.025em",
            lineHeight: 1.05,
            margin: 0,
            marginTop: 14,
            marginBottom: 12,
            color: "#1c1c1c",
          }}
        >
          Pick a palette and a typography.
        </h1>
        <p style={{ fontSize: 16, color: "#5a5750", margin: 0, maxWidth: 680, lineHeight: 1.55 }}>
          Each palette is rendered on the same content (mini Today view) so you&rsquo;re comparing
          color, not data. Each typography option is rendered on the Glacier palette (neutral) so
          you&rsquo;re comparing fonts, not background. Tell me your pick of each — I&rsquo;ll
          synthesize the two into the v2 mockup.
        </p>
      </header>

      {/* Palettes section */}
      <section style={{ marginBottom: 56 }}>
        <header style={{ marginBottom: 20, paddingBottom: 12, borderBottom: "1px solid #cdc8bc" }}>
          <p
            style={{
              fontFamily: "var(--font-geist-mono)",
              fontSize: 11,
              letterSpacing: "0.22em",
              textTransform: "uppercase",
              color: "#7d7768",
              margin: 0,
              marginBottom: 4,
            }}
          >
            Step 1 of 2
          </p>
          <h2 style={{ fontSize: 28, fontWeight: 600, margin: 0, letterSpacing: "-0.01em" }}>
            Palette
          </h2>
        </header>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(340px, 100%), 1fr))",
            gap: 20,
          }}
        >
          {PALETTES.map((p) => (
            <PaletteCard key={p.id} p={p} />
          ))}
        </div>
      </section>

      {/* Typography section */}
      <section>
        <header style={{ marginBottom: 20, paddingBottom: 12, borderBottom: "1px solid #cdc8bc" }}>
          <p
            style={{
              fontFamily: "var(--font-geist-mono)",
              fontSize: 11,
              letterSpacing: "0.22em",
              textTransform: "uppercase",
              color: "#7d7768",
              margin: 0,
              marginBottom: 4,
            }}
          >
            Step 2 of 2
          </p>
          <h2 style={{ fontSize: 28, fontWeight: 600, margin: 0, letterSpacing: "-0.01em" }}>
            Typography
          </h2>
          <p style={{ fontSize: 14, color: "#5a5750", margin: 0, marginTop: 8 }}>
            Same content, four fonts. Rendered on Glacier (neutral) so you can isolate the
            typography effect from the palette effect.
          </p>
        </header>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(340px, 100%), 1fr))",
            gap: 20,
          }}
        >
          {TYPOGRAPHY.map((t) => (
            <TypographyCard key={t.id} t={t} />
          ))}
        </div>
      </section>

      <footer
        style={{
          marginTop: 64,
          paddingTop: 24,
          borderTop: "1px solid #cdc8bc",
          fontSize: 13,
          color: "#7d7768",
        }}
      >
        Once you pick one of each, I&rsquo;ll build a refined v2 (Today + Overview + Security
        Detail + Holdings + Calendar) at <code>/design-preview/refined</code> with your chosen
        pair applied. The original three directions stay for reference.
      </footer>
    </main>
  );
}
