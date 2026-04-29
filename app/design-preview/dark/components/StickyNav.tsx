import Link from "next/link";
import { DARK } from "../palette";

const items = [
  { href: "#today", label: "TODAY" },
  { href: "#overview", label: "OVRVW" },
  { href: "#security", label: "SECDX" },
  { href: "#holdings", label: "HLDG" },
  { href: "#calendar", label: "CAL" },
];

export function DarkStickyNav() {
  return (
    <nav
      style={{
        position: "sticky",
        top: 0,
        zIndex: 50,
        background: DARK.canvas,
        borderBottom: `1px solid ${DARK.border}`,
        padding: "10px 18px",
      }}
    >
      <div
        style={{
          maxWidth: 1280,
          margin: "0 auto",
          display: "flex",
          alignItems: "center",
          gap: 24,
          fontSize: 12,
          letterSpacing: "0.22em",
          textTransform: "uppercase",
        }}
      >
        <Link href="/design-preview" className="d-link" style={{ color: DARK.inkDim }}>
          ← INDEX
        </Link>
        <span style={{ color: DARK.amber }}>VANGUARD-SKIN/PRO</span>
        <span style={{ color: DARK.inkFaint }}>·</span>
        <span style={{ color: DARK.inkDim }}>16:42:08 ET</span>
        <div className="d-nav-links" style={{ marginLeft: "auto" }}>
          {items.map((item) => (
            <a key={item.href} href={item.href} className="d-link" style={{ color: DARK.inkBody }}>
              {item.label}
            </a>
          ))}
        </div>
      </div>
    </nav>
  );
}
