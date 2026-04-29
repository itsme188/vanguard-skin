import Link from "next/link";

const items = [
  { href: "#today", label: "TODAY" },
  { href: "#overview", label: "OVRVW" },
  { href: "#security", label: "SECDX" },
  { href: "#holdings", label: "HLDG" },
  { href: "#calendar", label: "CAL" },
];

export function TerminalStickyNav() {
  return (
    <nav
      style={{
        position: "sticky",
        top: 0,
        zIndex: 50,
        background: "#000",
        borderBottom: "1px solid #1f1f1f",
        padding: "8px 16px",
      }}
    >
      <div
        style={{
          maxWidth: 1280,
          margin: "0 auto",
          display: "flex",
          alignItems: "center",
          gap: 24,
          fontSize: 10,
          letterSpacing: "0.22em",
          textTransform: "uppercase",
        }}
      >
        <Link href="/design-preview" className="t-link" style={{ color: "#888" }}>
          ← INDEX
        </Link>
        <span style={{ color: "#ffb84d" }}>VANGUARD-SKIN/PUREDARK</span>
        <span style={{ color: "#444" }}>·</span>
        <span style={{ color: "#666" }}>16:42:08 ET</span>
        <div className="t-nav-links" style={{ marginLeft: "auto" }}>
          {items.map((item) => (
            <a key={item.href} href={item.href} className="t-link" style={{ color: "#d4d4d4" }}>
              {item.label}
            </a>
          ))}
        </div>
      </div>
    </nav>
  );
}
