import Link from "next/link";

const items = [
  { href: "#today", label: "Today" },
  { href: "#overview", label: "Overview" },
  { href: "#security", label: "Security" },
  { href: "#holdings", label: "Holdings" },
  { href: "#calendar", label: "Calendar" },
];

export function LightPaperStickyNav() {
  return (
    <nav
      style={{
        position: "sticky",
        top: 0,
        zIndex: 50,
        background: "rgba(247, 245, 240, 0.92)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        borderBottom: "1px solid #d8d2c3",
        padding: "12px 24px",
      }}
    >
      <div style={{ maxWidth: 1200, margin: "0 auto", display: "flex", alignItems: "center", gap: 24 }}>
        <Link
          href="/design-preview"
          style={{
            fontFamily: "var(--font-geist-mono)",
            fontSize: 11,
            letterSpacing: "0.22em",
            textTransform: "uppercase",
            color: "#7d6e58",
            textDecoration: "none",
          }}
        >
          ← Direction Index
        </Link>
        <span
          style={{
            fontFamily: "var(--font-instrument-serif)",
            fontSize: 18,
            color: "#1a1a1a",
          }}
        >
          Light Paper
        </span>
        <div className="lp-nav-links" style={{ marginLeft: "auto" }}>
          {items.map((item) => (
            <a key={item.href} href={item.href} className="lp-link" style={{ padding: "4px 0" }}>
              {item.label}
            </a>
          ))}
        </div>
      </div>
    </nav>
  );
}
