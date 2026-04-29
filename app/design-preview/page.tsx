import Link from "next/link";
import { directionMeta } from "./shared/fixtures";

export default function DesignPreviewIndex() {
  return (
    <>
      <style>{`
        body { background: #efece5; color: #1a1a1a; font-family: var(--font-geist-sans); }
      `}</style>
      <main
        style={{
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "64px 24px",
          fontFamily: "var(--font-geist-sans)",
        }}
      >
        <div style={{ maxWidth: 880, width: "100%" }}>
          <p
            style={{
              fontFamily: "var(--font-geist-mono)",
              fontSize: 11,
              letterSpacing: "0.22em",
              textTransform: "uppercase",
              color: "#6a6155",
              marginBottom: 12,
            }}
          >
            Vanguard Skin · Design Preview
          </p>
          <h1
            style={{
              fontFamily: "var(--font-instrument-serif)",
              fontSize: "clamp(40px, 6vw, 64px)",
              lineHeight: 1.05,
              letterSpacing: "-0.01em",
              margin: 0,
              marginBottom: 16,
            }}
          >
            Three directions for the holistic redesign.
          </h1>
          <p
            style={{
              fontSize: 17,
              lineHeight: 1.55,
              color: "#3a3a3a",
              maxWidth: 640,
              margin: 0,
              marginBottom: 48,
            }}
          >
            Each link is a long-scrolling page with five views — Today, Overview, Security
            Detail, Holdings, Calendar — rendered with identical fixture data so you can
            scroll-compare visual treatment. Open all three in side-by-side tabs and use the
            sticky in-page nav to jump to the same section across directions.
          </p>

          <div style={{ display: "grid", gap: 16 }}>
            {(["light-paper", "terminal", "modern-brokerage"] as const).map((slug) => {
              const meta = directionMeta[slug];
              return (
                <Link
                  key={slug}
                  href={`/design-preview/${slug}`}
                  style={{
                    display: "block",
                    padding: "24px 28px",
                    background: "#fffefb",
                    border: "1px solid #d8d2c3",
                    borderRadius: 4,
                    textDecoration: "none",
                    color: "inherit",
                    transition: "transform 0.15s ease, border-color 0.15s ease",
                  }}
                  className="dp-card"
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      justifyContent: "space-between",
                      gap: 16,
                      marginBottom: 8,
                      flexWrap: "wrap",
                    }}
                  >
                    <h2
                      style={{
                        fontFamily: "var(--font-instrument-serif)",
                        fontSize: 28,
                        margin: 0,
                        lineHeight: 1.1,
                      }}
                    >
                      {meta.name}
                    </h2>
                    <span
                      style={{
                        fontFamily: "var(--font-geist-mono)",
                        fontSize: 11,
                        letterSpacing: "0.18em",
                        textTransform: "uppercase",
                        color: "#7d6e58",
                      }}
                    >
                      /design-preview/{slug} →
                    </span>
                  </div>
                  <p style={{ fontSize: 15, color: "#3a3a3a", margin: 0, marginBottom: 6 }}>
                    {meta.tagline}
                  </p>
                  <p
                    style={{
                      fontFamily: "var(--font-instrument-serif)",
                      fontStyle: "italic",
                      fontSize: 15,
                      color: "#7d6e58",
                      margin: 0,
                    }}
                  >
                    {meta.mood}
                  </p>
                </Link>
              );
            })}
          </div>

          <p
            style={{
              marginTop: 56,
              fontSize: 13,
              color: "#6a6155",
              borderTop: "1px solid #d8d2c3",
              paddingTop: 24,
            }}
          >
            All views render the same fixture data: $1.24M portfolio across 5 accounts,
            8 positions including options + bonds, 3 alerts (one triggered today),
            this week of macro + held-name earnings events. The dashboard at{" "}
            <Link
              href="/dashboard"
              style={{ color: "#3a3a3a", textDecoration: "underline" }}
            >
              /dashboard
            </Link>{" "}
            is unchanged.
          </p>
        </div>

        <style>{`
          .dp-card:hover { transform: translateY(-1px); border-color: #b8a572 !important; }
        `}</style>
      </main>
    </>
  );
}
