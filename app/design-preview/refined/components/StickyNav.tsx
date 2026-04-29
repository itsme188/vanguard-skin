import Link from "next/link";
import { SAGE } from "../palette";

const items = [
  { href: "#today", label: "Today" },
  { href: "#overview", label: "Overview" },
  { href: "#security", label: "Detail" },
  { href: "#holdings", label: "Holdings" },
  { href: "#calendar", label: "Calendar" },
];

export function RefinedStickyNav() {
  return (
    <nav
      style={{
        position: "sticky",
        top: 0,
        zIndex: 50,
        background: "rgba(247, 244, 237, 0.92)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        borderBottom: `1px solid ${SAGE.border}`,
        padding: "12px 20px",
      }}
    >
      <div
        style={{
          maxWidth: 1180,
          margin: "0 auto",
          display: "flex",
          alignItems: "center",
          gap: 18,
        }}
      >
        <Link
          href="/design-preview"
          className="rf-link"
          style={{ fontSize: 15, fontWeight: 500, color: SAGE.inkDim }}
        >
          ← Index
        </Link>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            fontSize: 15,
            fontWeight: 600,
            color: SAGE.ink,
          }}
        >
          <span
            style={{
              width: 22,
              height: 22,
              borderRadius: 6,
              background: `linear-gradient(135deg, ${SAGE.brand}, ${SAGE.accent})`,
              display: "inline-block",
            }}
          />
          Vanguard Skin
        </span>
        <div
          className="rf-nav-links"
          style={{ marginLeft: "auto", fontSize: 14, fontWeight: 500 }}
        >
          {items.map((item) => (
            <a key={item.href} href={item.href} className="rf-link">
              {item.label}
            </a>
          ))}
        </div>
      </div>
    </nav>
  );
}
