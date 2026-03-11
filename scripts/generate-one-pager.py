#!/usr/bin/env python3
"""Generate a polished one-pager PDF for Vanguard Skin v2."""

from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib.colors import HexColor, Color
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph
from reportlab.lib.styles import ParagraphStyle
import os

# Brand colors — light/printable palette
BG = HexColor("#FFFFFF")
SURFACE = HexColor("#F5F5F0")
PANEL = HexColor("#F0F0EC")
GOLD = HexColor("#9A7B1F")
GOLD_LIGHT = HexColor("#B8963E")
EMERALD = HexColor("#15825C")
BLUE = HexColor("#2E6ABF")
INK = HexColor("#1A1A1A")
INK_DIM = HexColor("#4A4A4A")
INK_FAINT = HexColor("#777777")
EDGE = HexColor("#CCCCCC")

OUTPUT_PATH = os.path.join(os.path.dirname(__file__), "..", "docs", "vanguard-skin-overview.pdf")

# Layout constants
W, H = letter  # 612 x 792
MARGIN = 40
CONTENT_W = W - 2 * MARGIN


def rounded_rect(c, x, y, w, h, r, fill=None, stroke=None):
    """Draw a rounded rectangle. (x, y) is bottom-left corner."""
    p = c.beginPath()
    p.roundRect(x, y, w, h, r)
    p.close()
    if fill:
        c.setFillColor(fill)
    if stroke:
        c.setStrokeColor(stroke)
        c.setLineWidth(0.5)
    c.drawPath(p, fill=1 if fill else 0, stroke=1 if stroke else 0)


def wrap_paragraph(text, style, max_w, max_h=200):
    """Create and measure a Paragraph, returning (para, width, height)."""
    para = Paragraph(text, style)
    pw, ph = para.wrap(max_w, max_h)
    return para, pw, ph


def draw_paragraph(c, text, style, x, y_top, max_w):
    """Draw a paragraph with its TOP at y_top. Returns the y of the bottom."""
    para, pw, ph = wrap_paragraph(text, style, max_w)
    para.drawOn(c, x, y_top - ph)
    return y_top - ph


def hline(c, y, color=EDGE):
    """Draw a full-width horizontal rule."""
    c.setStrokeColor(color)
    c.setLineWidth(0.5)
    c.line(MARGIN, y, W - MARGIN, y)


# Reusable styles
STYLE_BODY = ParagraphStyle('Body', fontName='Helvetica', fontSize=7.5, leading=10.5, textColor=INK_DIM)
STYLE_SMALL = ParagraphStyle('Small', fontName='Helvetica', fontSize=7, leading=9.5, textColor=INK_FAINT)
STYLE_TOOL = ParagraphStyle('Tool', fontName='Helvetica', fontSize=6.8, leading=9, textColor=INK_DIM)


def page1(c):
    """Page 1: Overview with hero + feature cards."""
    # White background
    c.setFillColor(BG)
    c.rect(0, 0, W, H, fill=1, stroke=0)

    # Gold accent bar at top
    c.setFillColor(GOLD)
    c.rect(0, H - 3, W, 3, fill=1, stroke=0)

    # ── Header ──
    y = H - 38

    c.setFillColor(GOLD)
    c.setFont("Helvetica-Bold", 12)
    c.drawString(MARGIN, y, "VANGUARD SKIN")

    c.setFillColor(INK_FAINT)
    c.setFont("Helvetica", 8)
    c.drawString(MARGIN + 118, y + 1, "v2")

    c.setFillColor(INK_DIM)
    c.setFont("Helvetica", 8)
    c.drawRightString(W - MARGIN, y + 1, "Local-First Portfolio Intelligence")

    y -= 10
    hline(c, y)

    # ── Hero headline ──
    y -= 32

    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 24)
    c.drawString(MARGIN, y, "Your portfolio, fully understood.")

    # ── Hero description ──
    y -= 8
    hero_style = ParagraphStyle('Hero', fontName='Helvetica', fontSize=10, leading=14.5, textColor=INK_DIM)
    hero_text = (
        "Unify your Vanguard and Interactive Brokers accounts into a single analytical surface. "
        "AI-powered document parsing, institutional-grade performance metrics, FIFO tax lot tracking, "
        "and a conversational portfolio analyst \u2014 all running locally on your machine."
    )
    y = draw_paragraph(c, hero_text, hero_style, MARGIN, y, CONTENT_W * 0.78)

    # ── Stats bar ──
    y -= 14
    bar_h = 48
    rounded_rect(c, MARGIN, y - bar_h, CONTENT_W, bar_h, 6, fill=SURFACE, stroke=EDGE)

    stats = [
        ("Formats", "6", GOLD),
        ("AI Tools", "14", BLUE),
        ("Analysis Axes", "9", EMERALD),
        ("Engines", "4", GOLD_LIGHT),
        ("Tests", "340+", EMERALD),
        ("External APIs", "4", BLUE),
    ]
    stat_w = CONTENT_W / len(stats)
    for i, (label, value, color) in enumerate(stats):
        sx = MARGIN + stat_w * i + 14
        # Label
        c.setFillColor(INK_FAINT)
        c.setFont("Helvetica", 6.5)
        c.drawString(sx, y - 16, label.upper())
        # Value
        c.setFillColor(color)
        c.setFont("Helvetica-Bold", 14)
        c.drawString(sx, y - 33, value)

    y -= bar_h

    # ── Feature cards (3×3) ──
    y -= 14
    gap = 8
    card_w = (CONTENT_W - 2 * gap) / 3
    card_h = 88

    features = [
        ("\u2193", "Smart Document Import",
         "Drop Vanguard PDFs or IBKR CSVs. AI extracts every holding, transaction, and price. "
         "Auto-detect, preview, confirm, undo. Re-import is idempotent.",
         GOLD),
        ("\u2261", "Unified Dashboard",
         "Total portfolio value, month-over-month change, per-account cards, and equity curves. "
         "Drill into any account for holdings, transactions, and snapshots.",
         BLUE),
        ("\u03A3", "FIFO Tax Lot Tracking",
         "Automatic cost basis matching. Open lots with unrealized gains, closed sales with "
         "long/short-term classification. Year and account filtering.",
         EMERALD),
        ("\u2737", "AI Portfolio Analyst",
         "Streaming chat with Claude and 14 tools. Queries your actual data: holdings, "
         "allocations, tax lots, performance, FRED data, SEC filings, insider trades.",
         GOLD),
        ("\u25CE", "Factor Analysis",
         "Break down your portfolio across 9 dimensions: sector, geography, market cap, "
         "style, asset class, and more. Concentration metrics with HHI scoring.",
         BLUE),
        ("\u2206", "Performance Metrics",
         "Time-weighted return (TWR) via chain-linked Modified Dietz. "
         "Per-account breakdown. YTD, 1Y, and full-history periods.",
         EMERALD),
        ("\u270E", "Investment Journal",
         "Journal entries, earnings notes, and trade theses linked to holdings. "
         "Sentiment tags, full-text search, and earnings transcript timeline.",
         GOLD),
        ("\u21C4", "Live Market Data",
         "Connect to IBKR Trader Workstation for real-time prices and security "
         "enrichment. Built-in rate limiter. TWS prices are authoritative.",
         BLUE),
        ("\u2713", "Reconciliation",
         "Compare broker statement values against computed values. Flag discrepancies. "
         "Data quality annotations for staleness, missing data, maturity.",
         EMERALD),
    ]

    for i, (icon, title, desc, color) in enumerate(features):
        col = i % 3
        row = i // 3
        cx = MARGIN + col * (card_w + gap)
        cy = y - (row + 1) * (card_h + gap) + gap  # +gap so first row is flush

        # Card background
        rounded_rect(c, cx, cy, card_w, card_h, 5, fill=SURFACE, stroke=EDGE)

        # Accent bar at top of card
        c.setFillColor(color)
        c.rect(cx + 8, cy + card_h - 2.5, card_w - 16, 2.5, fill=1, stroke=0)

        # Icon
        icon_cx = cx + 18
        icon_cy = cy + card_h - 22
        c.setFillColor(Color(color.red, color.green, color.blue, 0.12))
        c.circle(icon_cx, icon_cy, 10, fill=1, stroke=0)
        c.setFillColor(color)
        c.setFont("Helvetica-Bold", 11)
        c.drawCentredString(icon_cx, icon_cy - 4, icon)

        # Title
        c.setFillColor(INK)
        c.setFont("Helvetica-Bold", 9)
        c.drawString(cx + 33, cy + card_h - 26, title)

        # Description
        desc_style = ParagraphStyle('CardDesc', fontName='Helvetica', fontSize=7.2, leading=10, textColor=INK_DIM)
        para, pw, ph = wrap_paragraph(desc, desc_style, card_w - 18)
        para.drawOn(c, cx + 9, cy + 4)

    # ── Footer ──
    footer_y = 30
    hline(c, footer_y + 12)

    c.setFillColor(INK_FAINT)
    c.setFont("Helvetica", 6.5)
    c.drawString(MARGIN, footer_y, "Next.js 16  \u00b7  React 19  \u00b7  TypeScript 5  \u00b7  SQLite  \u00b7  Tailwind CSS 4  \u00b7  Recharts  \u00b7  Claude API  \u00b7  Vitest")
    c.drawRightString(W - MARGIN, footer_y, "100% Local  \u00b7  Zero Cloud Dependencies  \u00b7  Your Data, Your Machine")


def page2(c):
    """Page 2: Architecture & capabilities deep dive."""
    # White background
    c.setFillColor(BG)
    c.rect(0, 0, W, H, fill=1, stroke=0)

    # Gold accent bar
    c.setFillColor(GOLD)
    c.rect(0, H - 3, W, 3, fill=1, stroke=0)

    # ── Header ──
    y = H - 38

    c.setFillColor(GOLD)
    c.setFont("Helvetica-Bold", 12)
    c.drawString(MARGIN, y, "UNDER THE HOOD")

    c.setFillColor(INK_DIM)
    c.setFont("Helvetica", 8)
    c.drawRightString(W - MARGIN, y + 1, "Architecture & Capabilities")

    y -= 10
    hline(c, y)
    y -= 6

    # Two-column layout
    col_gap = 24
    col_w = (CONTENT_W - col_gap) / 2
    left_x = MARGIN
    right_x = MARGIN + col_w + col_gap

    # ═══════════════════════════════════════════
    # LEFT COLUMN
    # ═══════════════════════════════════════════
    ly = y  # left column cursor

    # ── Import Formats ──
    ly -= 6
    c.setFillColor(GOLD)
    c.setFont("Helvetica-Bold", 10)
    c.drawString(left_x, ly, "Import Formats")
    ly -= 14

    formats = [
        ("Vanguard PDF Statements", "Claude API extraction with retry. Stocks, bonds, ETFs, options, mutual funds."),
        ("IBKR Activity CSV", "Section-based parsing. Trades, dividends, interest, fees, options (OCC symbols)."),
        ("IBKR Holdings CSV", "Current positions with cost basis and market prices."),
        ("Vanguard Holdings CSV", "Point-in-time position snapshots."),
        ("Vanguard Cost Basis CSV", "Per-lot cost data with method (FIFO, specific ID)."),
        ("Monthly Values CSV", "Aggregate portfolio snapshots for performance tracking."),
    ]

    for title, desc in formats:
        # Bullet
        c.setFillColor(GOLD)
        c.circle(left_x + 3, ly + 3, 1.5, fill=1, stroke=0)
        # Title
        c.setFillColor(INK)
        c.setFont("Helvetica-Bold", 7.5)
        c.drawString(left_x + 10, ly, title)
        ly -= 10
        # Description
        para, pw, ph = wrap_paragraph(desc, STYLE_SMALL, col_w - 12)
        para.drawOn(c, left_x + 10, ly - ph)
        ly -= ph + 6

    # ── AI Chat Tools ──
    ly -= 10
    c.setFillColor(BLUE)
    c.setFont("Helvetica-Bold", 10)
    c.drawString(left_x, ly, "AI Chat Tools (14)")
    ly -= 16

    tool_groups = [
        ("Portfolio Data", "query_holdings, query_transactions, query_allocation, query_tax_lots, query_performance, query_income_summary, query_twr, query_price_history", BLUE),
        ("External Data", "query_fred (macro indicators), query_company_fundamentals (SEC EDGAR), query_insider_trades (Form 4)", EMERALD),
        ("Research", "query_earnings_transcript (EDGAR \u2192 Motley Fool \u2192 API Ninjas), query_notes, create_note", GOLD),
    ]

    for group_name, tools, color in tool_groups:
        c.setFillColor(color)
        c.setFont("Helvetica-Bold", 7.5)
        c.drawString(left_x + 4, ly, group_name)
        ly -= 10
        para, pw, ph = wrap_paragraph(tools, STYLE_TOOL, col_w - 10)
        para.drawOn(c, left_x + 4, ly - ph)
        ly -= ph + 8

    # ── Compute Engines ──
    ly -= 10
    c.setFillColor(EMERALD)
    c.setFont("Helvetica-Bold", 10)
    c.drawString(left_x, ly, "Compute Engines")
    ly -= 14

    engines = [
        ("FIFO Tax Lots", "Matches BUY/SELL transactions. Tracks holding periods, long/short-term, unrealized and realized gains."),
        ("TWR (Modified Dietz)", "Chain-linked monthly returns. Annualized. Measures portfolio performance independent of cash flows."),
        ("XIRR (Newton-Raphson)", "Money-weighted return. Accounts for timing and size of deposits/withdrawals."),
        ("Security Classification", "Static lookup + auto-classify. 9 dimensions: sector, geography, cap, style, asset class."),
    ]

    for title, desc in engines:
        c.setFillColor(EMERALD)
        c.circle(left_x + 3, ly + 3, 1.5, fill=1, stroke=0)
        c.setFillColor(INK)
        c.setFont("Helvetica-Bold", 7.5)
        c.drawString(left_x + 10, ly, title)
        ly -= 10
        para, pw, ph = wrap_paragraph(desc, STYLE_SMALL, col_w - 12)
        para.drawOn(c, left_x + 10, ly - ph)
        ly -= ph + 6

    # ═══════════════════════════════════════════
    # RIGHT COLUMN
    # ═══════════════════════════════════════════
    ry = y  # right column cursor

    # ── Data Flow ──
    ry -= 6
    c.setFillColor(GOLD)
    c.setFont("Helvetica-Bold", 10)
    c.drawString(right_x, ry, "Data Flow")
    ry -= 18

    flow_steps = [
        ("Drop Files", "PDF or CSV"),
        ("Auto-Detect", "6 formats"),
        ("Preview", "Before commit"),
        ("Import", "Atomic write"),
        ("Compute", "Tax lots, TWR"),
    ]
    step_w = col_w / len(flow_steps)
    box_h = 28
    for i, (step, sub) in enumerate(flow_steps):
        sx = right_x + step_w * i
        rounded_rect(c, sx + 1, ry - box_h, step_w - 4, box_h, 3, fill=SURFACE, stroke=EDGE)
        c.setFillColor(INK)
        c.setFont("Helvetica-Bold", 6.5)
        c.drawCentredString(sx + step_w / 2, ry - 11, step)
        c.setFillColor(INK_FAINT)
        c.setFont("Helvetica", 5.5)
        c.drawCentredString(sx + step_w / 2, ry - 20, sub)
        if i < len(flow_steps) - 1:
            c.setFillColor(GOLD)
            c.setFont("Helvetica", 9)
            c.drawCentredString(sx + step_w - 1, ry - 14, "\u203a")

    ry -= box_h + 16

    # ── Architecture ──
    c.setFillColor(GOLD)
    c.setFont("Helvetica-Bold", 10)
    c.drawString(right_x, ry, "Architecture")
    ry -= 12

    arch_items = [
        ("Framework", "Next.js 16 App Router \u2014 server components for data, client for interactivity"),
        ("Database", "SQLite (WAL mode, foreign keys) \u2014 single file, zero config, 9 migrations"),
        ("Styling", "Tailwind CSS 4 \u2014 dark theme with semantic design tokens"),
        ("AI", "Claude API \u2014 PDF parsing (Sonnet) + agentic chat with 14 tool-use tools"),
        ("Charts", "Recharts \u2014 equity curves, allocation pies, sparklines"),
        ("Testing", "Vitest \u2014 340+ tests, in-memory SQLite, real data fixtures (gitignored)"),
        ("Desktop", "AppleScript launcher \u2014 one-click start/stop, no terminal needed"),
    ]

    # Measure total height for the box
    arch_line_h = 14
    arch_box_h = len(arch_items) * arch_line_h + 12
    rounded_rect(c, right_x, ry - arch_box_h, col_w, arch_box_h, 5, fill=SURFACE, stroke=EDGE)

    ay = ry - 10
    arch_desc_style = ParagraphStyle('ArchDesc', fontName='Helvetica', fontSize=6.5, leading=8.5, textColor=INK_DIM)
    for label, desc in arch_items:
        c.setFillColor(GOLD_LIGHT)
        c.setFont("Helvetica-Bold", 6.8)
        c.drawString(right_x + 8, ay, label)
        # Description next to label
        c.setFillColor(INK_DIM)
        c.setFont("Helvetica", 6.5)
        # Truncate to fit on one line
        max_desc_w = col_w - 70
        desc_text = desc
        while c.stringWidth(desc_text, "Helvetica", 6.5) > max_desc_w and len(desc_text) > 10:
            desc_text = desc_text[:-4] + "\u2026"
        c.drawString(right_x + 62, ay, desc_text)
        ay -= arch_line_h

    ry -= arch_box_h + 16

    # ── What Makes It Different ──
    c.setFillColor(GOLD)
    c.setFont("Helvetica-Bold", 10)
    c.drawString(right_x, ry, "What Makes It Different")
    ry -= 14

    diff_items = [
        ("Truly Local", "Your financial data never leaves your machine. No cloud, no accounts, no third-party access."),
        ("Multi-Brokerage", "Unified view across Vanguard and IBKR with a single import flow."),
        ("AI-Native", "Deep, structured access to your data through 14 specialized query tools."),
        ("Tax-Aware", "FIFO cost basis with long/short-term classification and harvesting discovery."),
        ("Institutional Metrics", "TWR and XIRR computed the way endowments measure performance."),
        ("Idempotent Imports", "Re-import the same file 10 times \u2014 nothing changes. Deterministic keys."),
        ("Full Audit Trail", "Every import tracked as a batch with undo. Reconciliation verifies values."),
    ]

    diff_desc_style = ParagraphStyle('DiffDesc', fontName='Helvetica', fontSize=6.8, leading=9, textColor=INK_DIM)
    for title, desc in diff_items:
        c.setFillColor(GOLD)
        c.setFont("Helvetica-Bold", 7.5)
        c.drawString(right_x + 2, ry, "\u2022  " + title)
        ry -= 10
        para, pw, ph = wrap_paragraph(desc, diff_desc_style, col_w - 14)
        para.drawOn(c, right_x + 12, ry - ph)
        ry -= ph + 5

    # ── Tab bar at bottom ──
    tab_y = 60
    hline(c, tab_y + 18)

    c.setFillColor(INK_DIM)
    c.setFont("Helvetica-Bold", 8)
    c.drawString(MARGIN, tab_y + 4, "8 TABS:")

    tab_names = ["Overview", "Accounts", "Import", "Tax Lots", "Reconciliation", "Chat", "Analysis", "Notes"]
    tab_colors = [GOLD, BLUE, EMERALD, GOLD_LIGHT, INK_DIM, BLUE, EMERALD, GOLD]

    tx = MARGIN + 52
    for name, color in zip(tab_names, tab_colors):
        tw = c.stringWidth(name, "Helvetica-Bold", 7.5) + 14
        rounded_rect(c, tx, tab_y, tw, 16, 8, fill=Color(color.red, color.green, color.blue, 0.10))
        c.setFillColor(color)
        c.setFont("Helvetica-Bold", 7.5)
        c.drawString(tx + 7, tab_y + 4, name)
        tx += tw + 5

    # ── Footer ──
    footer_y = 30
    hline(c, footer_y + 12)
    c.setFillColor(INK_FAINT)
    c.setFont("Helvetica", 6.5)
    c.drawString(MARGIN, footer_y, "Built with Next.js 16  \u00b7  React 19  \u00b7  TypeScript 5  \u00b7  SQLite  \u00b7  Claude API  \u00b7  Tailwind CSS 4")
    c.drawRightString(W - MARGIN, footer_y, "github.com/itsme188/vanguard-skin")


def generate_pdf():
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    c = canvas.Canvas(OUTPUT_PATH, pagesize=letter)
    c.setTitle("Vanguard Skin v2 \u2014 Product Overview")
    c.setAuthor("Vanguard Skin")
    c.setSubject("Portfolio Intelligence Dashboard")

    page1(c)
    c.showPage()

    page2(c)
    c.showPage()

    c.save()
    print(f"PDF generated: {os.path.abspath(OUTPUT_PATH)}")


if __name__ == "__main__":
    generate_pdf()
