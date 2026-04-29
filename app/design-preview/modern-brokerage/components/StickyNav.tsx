import Link from "next/link";

const items = [
  { href: "#today", label: "Today" },
  { href: "#overview", label: "Overview" },
  { href: "#security", label: "Detail" },
  { href: "#holdings", label: "Holdings" },
  { href: "#calendar", label: "Calendar" },
];

export function ModernBrokerageStickyNav() {
  return (
    <nav
      style={{
        position: "sticky",
        top: 0,
        zIndex: 50,
        background: "rgba(254, 254, 254, 0.92)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        borderBottom: "1px solid #f4f4f5",
        padding: "14px 24px",
      }}
    >
      <div
        style={{
          maxWidth: 1200,
          margin: "0 auto",
          display: "flex",
          alignItems: "center",
          gap: 20,
        }}
      >
        <Link
          href="/design-preview"
          className="mb-link"
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: "#71717a",
          }}
        >
          ← Index
        </Link>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            fontSize: 16,
            fontWeight: 600,
            color: "#0a0a0a",
          }}
        >
          <span
            style={{
              width: 22,
              height: 22,
              borderRadius: 7,
              background: "linear-gradient(135deg, #f59e0b, #fbbf24)",
              display: "inline-block",
            }}
          />
          Vanguard Skin
        </span>
        <div className="mb-nav-links" style={{ marginLeft: "auto", fontSize: 14, fontWeight: 500 }}>
          {items.map((item) => (
            <a key={item.href} href={item.href} className="mb-link">
              {item.label}
            </a>
          ))}
        </div>
      </div>
    </nav>
  );
}
