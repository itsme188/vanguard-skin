#!/usr/bin/env bash
# Vanguard Skin QA Runner
# Uses agent-browser to navigate the dashboard, extract values, and compare against expected.
# Assumes the dev server is already running on localhost:3099.
#
# Usage: bash qa/run-qa.sh
# Output: qa/qa-report.txt + qa/screenshots/*.png

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BASE_URL="http://localhost:3099"
SCREENSHOT_DIR="$SCRIPT_DIR/screenshots"
REPORT="$SCRIPT_DIR/qa-report.txt"
EXPECTED="$SCRIPT_DIR/expected-values.json"
SESSION="qa-$$"

# Colors for terminal output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

mkdir -p "$SCREENSHOT_DIR"

# --- Utilities ---

log() {
  local level="$1" check="$2" msg="$3"
  local ts
  ts="$(date '+%Y-%m-%d %H:%M:%S')"
  echo "[$ts] $level: $check — $msg" >> "$REPORT"
  case "$level" in
    PASS) echo -e "${GREEN}PASS${NC}: $check — $msg" ;;
    FAIL) echo -e "${RED}FAIL${NC}: $check — $msg" ;;
    SKIP) echo -e "${YELLOW}SKIP${NC}: $check — $msg" ;;
    INFO) echo -e "${CYAN}INFO${NC}: $check — $msg" ;;
  esac
}

# Read a JSON field from expected-values.json using python (available on macOS)
json_get() {
  python3 -c "
import json, sys
with open('$EXPECTED') as f:
    data = json.load(f)
keys = '$1'.split('.')
val = data
for k in keys:
    if isinstance(val, list):
        val = val[int(k)]
    else:
        val = val.get(k)
    if val is None:
        print('FILL_IN')
        sys.exit(0)
print(val)
"
}

# Parse a currency string like "$1,234,567" to a number
parse_currency() {
  echo "$1" | sed 's/[$,]//g' | sed 's/^[+-]//'
}

# Parse a percentage string like "+12.34%" to a number
parse_percent() {
  echo "$1" | sed 's/[+%]//g'
}

# Compare two numbers with a tolerance (as fraction, e.g., 0.02 = 2%).
# Empty/non-numeric input prints INVALID instead of crashing: a bare
# float('') ValueError exits python non-zero, and under `set -euo pipefail`
# the RESULT=$(...) substitution killed the ENTIRE run at the first bad
# extraction (2026-07-20 root cause — every tab after the first value check
# silently never ran). Callers treat any non-OK result as a FAIL for that
# one check and continue.
compare_with_tolerance() {
  local actual="$1" expected="$2" tolerance="$3"
  python3 -c "
try:
    a, e, t = float('$actual'), float('$expected'), float('$tolerance')
except ValueError:
    print('INVALID')
else:
    if e == 0:
        ok = abs(a) < 1.0
    else:
        ok = abs(a - e) / abs(e) <= t
    print('OK' if ok else 'MISMATCH')
"
}

# Compare two numbers with absolute tolerance (e.g., 0.5 percentage points)
compare_absolute() {
  local actual="$1" expected="$2" tolerance="$3"
  python3 -c "
try:
    a, e, t = float('$actual'), float('$expected'), float('$tolerance')
except ValueError:
    print('INVALID')
else:
    print('OK' if abs(a - e) <= t else 'MISMATCH')
"
}

# Update a value in expected-values.json (auto-update on PASS).
# Usage: update_expected "overview.portfolioValue" '$1,800,000'
update_expected() {
  local key_path="$1" new_value="$2"
  python3 -c "
import json
with open('$EXPECTED', 'r') as f:
    data = json.load(f)
keys = '$key_path'.split('.')
obj = data
for k in keys[:-1]:
    obj = obj[k]
val = '''$new_value'''
# Store numbers as numbers, strings as strings
try:
    val = int(val)
except ValueError:
    try:
        val = float(val)
    except ValueError:
        pass
obj[keys[-1]] = val
with open('$EXPECTED', 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
"
}

# Run agent-browser eval with stdin to avoid shell quoting issues.
# Strips outer JSON quotes from output (agent-browser wraps results in "...").
ab_eval() {
  agent-browser --session "$SESSION" eval --stdin 2>/dev/null | sed 's/^"//;s/"$//'
}

# --- Pre-flight ---

echo -e "\n${CYAN}=== Vanguard Skin QA Runner ===${NC}"
echo -e "${CYAN}$(date '+%Y-%m-%d %H:%M:%S')${NC}\n"

# Clear previous report
echo "# Vanguard Skin QA Report — $(date '+%Y-%m-%d %H:%M:%S')" > "$REPORT"
echo "" >> "$REPORT"

# Check server is running
if ! curl -sf "$BASE_URL" > /dev/null 2>&1; then
  log "FAIL" "pre-flight" "Dev server not responding at $BASE_URL"
  echo -e "\n${RED}Server not running. Start with: npm run dev${NC}"
  exit 1
fi
log "PASS" "pre-flight" "Dev server responding at $BASE_URL"

# --- Helper: check page for errors ---

check_page_errors() {
  local page_name="$1"

  # Check for Next.js error boundary
  local error_text
  error_text=$(agent-browser --session "$SESSION" eval 'document.querySelector("h2")?.textContent || ""' 2>/dev/null || echo "")
  if echo "$error_text" | grep -qi "something went wrong"; then
    log "FAIL" "$page_name/error-boundary" "Error boundary triggered: Something went wrong"
    return 1
  fi

  # Check for lingering skeleton loaders (page didn't finish loading)
  local skeletons
  skeletons=$(agent-browser --session "$SESSION" eval 'document.querySelectorAll(".animate-pulse").length' 2>/dev/null || echo "0")
  if [ "$skeletons" -gt 5 ] 2>/dev/null; then
    log "FAIL" "$page_name/loading" "Page still loading ($skeletons skeleton elements)"
    return 1
  fi

  log "PASS" "$page_name/no-errors" "Page loaded without errors"
  return 0
}

# --- Helper: navigate to a tab and take screenshot ---

navigate_and_screenshot() {
  local tab_name="$1" path="$2"

  echo -e "\n${CYAN}--- $tab_name ---${NC}"

  agent-browser --session "$SESSION" open "${BASE_URL}${path}" 2>/dev/null
  agent-browser --session "$SESSION" wait --load networkidle 2>/dev/null
  # Extra wait for client-side hydration
  agent-browser --session "$SESSION" wait 2000 2>/dev/null

  agent-browser --session "$SESSION" screenshot --annotate "$SCREENSHOT_DIR/${tab_name}.png" 2>/dev/null
  log "INFO" "$tab_name/screenshot" "Saved to screenshots/${tab_name}.png"
}

# ============================================================
# TAB 1: TODAY (default landing since the 2026-04-29 IA collapse;
# /dashboard redirects here. Rewritten 2026-07-20 against the 6-tab IA.)
#
# innerText gotcha (live-verified 2026-07-20): innerText returns RENDERED
# text, so CSS text-transform:uppercase labels ("Week ahead" eyebrow,
# "Max drawdown" KPI) read as all-caps at runtime. Every text check below
# lowercases document.body.innerText before matching.
# ============================================================

navigate_and_screenshot "today" "/dashboard/today"
check_page_errors "today" || true

# Extract portfolio value from /api/summary (the Electron-tray endpoint).
# NOT scraped from the DOM: the API contract is redesign-proof and checks
# the same invariant — portfolio total vs expected drift.
PORTFOLIO_VALUE=$(curl -sf --max-time 10 "$BASE_URL/api/summary" \
  | python3 -c "import json,sys; v=json.load(sys.stdin).get('totalValue'); print('' if v is None else v)" 2>/dev/null || echo "")
log "INFO" "today/portfolio-value" "Extracted: $PORTFOLIO_VALUE"

EXPECTED_PV=$(json_get "today.portfolioValue")
if [ "$EXPECTED_PV" = "FILL_IN" ]; then
  log "SKIP" "today/portfolio-value" "Expected not set (actual: $PORTFOLIO_VALUE)"
else
  ACTUAL_NUM=$(parse_currency "$PORTFOLIO_VALUE")
  EXPECTED_NUM=$(parse_currency "$EXPECTED_PV")
  TOLERANCE=$(json_get "today.portfolioValueTolerance")
  RESULT=$(compare_with_tolerance "$ACTUAL_NUM" "$EXPECTED_NUM" "$TOLERANCE")
  if [ "$RESULT" = "OK" ]; then
    log "PASS" "today/portfolio-value" "Actual $PORTFOLIO_VALUE within ${TOLERANCE} of expected $EXPECTED_PV"
    update_expected "today.portfolioValue" "$PORTFOLIO_VALUE"
  else
    log "FAIL" "today/portfolio-value" "Actual $PORTFOLIO_VALUE outside ${TOLERANCE} tolerance of expected $EXPECTED_PV"
  fi
fi

# Account count from the Today portfolio hero strip ("N accounts · as of …").
# The old per-account value cards live on Accounts now; this text carries
# the same invariant (count should not change without an account change).
ACCOUNT_COUNT=$(ab_eval <<'EVALEOF'
(document.body.innerText.match(/(\d+) accounts/) || [,'0'])[1]
EVALEOF
)
log "INFO" "today/account-count" "Extracted: $ACCOUNT_COUNT"

EXPECTED_AC=$(json_get "today.accountCount")
if [ "$EXPECTED_AC" = "FILL_IN" ]; then
  log "SKIP" "today/account-count" "Expected not set (actual: $ACCOUNT_COUNT)"
elif [ "$ACCOUNT_COUNT" = "$EXPECTED_AC" ]; then
  log "PASS" "today/account-count" "Account count matches: $ACCOUNT_COUNT"
  update_expected "today.accountCount" "$ACCOUNT_COUNT"
else
  log "FAIL" "today/account-count" "Expected $EXPECTED_AC accounts, got $ACCOUNT_COUNT"
fi

# Data confidence indicator: now a <button> with a popover (replaced the old
# a[href*="data-health"] anchor — that link only exists INSIDE the popover).
# The button gets its title after the /api/data-confidence fetch resolves.
FRESHNESS_TITLE=$(ab_eval <<'EVALEOF'
(document.querySelector('button[title^="Data confidence"]')?.getAttribute('title') || 'NOT_FOUND')
EVALEOF
)
if [ "$FRESHNESS_TITLE" != "NOT_FOUND" ]; then
  log "PASS" "today/data-confidence" "Indicator present: $FRESHNESS_TITLE"
else
  log "FAIL" "today/data-confidence" "Data confidence indicator not found"
fi

# IBKR holdings block (Today-specific content; replaces the old
# portfolio-chart check — Today renders no chart by design, charts are
# covered on the Charts tab).
IBKR_BLOCK=$(ab_eval <<'EVALEOF'
Array.from(document.querySelectorAll('h2')).some(h => h.textContent.trim() === 'IBKR today') ? 'true' : 'false'
EVALEOF
)
if [ "$IBKR_BLOCK" = "true" ]; then
  log "PASS" "today/ibkr-block" "IBKR today holdings block present"
else
  log "FAIL" "today/ibkr-block" "IBKR today holdings block not found"
fi

# ============================================================
# TAB 2: ACCOUNTS
# ============================================================

navigate_and_screenshot "accounts" "/dashboard/accounts"
check_page_errors "accounts" || true

# Extract account names and values from account selector
ACCOUNTS_JSON=$(ab_eval <<'EVALEOF'
JSON.stringify(
  Array.from(document.querySelectorAll('[role="tablist"][aria-label] button, [role="tab"]'))
    .map(b => b.textContent.trim())
    .filter(t => t.length > 0 && !['Overview','Accounts','Holdings','Analysis','Charts','Calendar','Research','Import'].includes(t))
)
EVALEOF
)
log "INFO" "accounts/tabs" "Account tabs: $ACCOUNTS_JSON"

# ============================================================
# TAB 3: CROSS-ACCOUNT HOLDINGS
# (Holdings tab was absorbed into Accounts at the IA collapse;
# /dashboard/holdings is a redirect stub to this URL — navigate the
# real destination directly.)
# ============================================================

navigate_and_screenshot "holdings" "/dashboard/accounts?id=all#holdings"
check_page_errors "holdings" || true

# Extract position count
POSITION_TEXT=$(ab_eval <<'EVALEOF'
(() => {
  const ps = document.querySelectorAll('p');
  for (const p of ps) {
    if (p.textContent.includes('positions across')) return p.textContent.trim();
  }
  return 'NOT_FOUND'
})()
EVALEOF
)
POSITION_COUNT=$(echo "$POSITION_TEXT" | grep -oE '^[0-9]+' || echo "0")
log "INFO" "holdings/position-count" "Extracted: $POSITION_COUNT (from: $POSITION_TEXT)"

EXPECTED_PC=$(json_get "holdings.positionCount")
POSITION_COUNT_TOL=$(json_get "holdings.positionCountTolerance")
if [ "$EXPECTED_PC" = "FILL_IN" ]; then
  log "SKIP" "holdings/position-count" "Expected not set (actual: $POSITION_COUNT)"
else
  RESULT=$(compare_with_tolerance "$POSITION_COUNT" "$EXPECTED_PC" "$POSITION_COUNT_TOL")
  if [ "$RESULT" = "OK" ]; then
    log "PASS" "holdings/position-count" "Actual $POSITION_COUNT within ${POSITION_COUNT_TOL} of expected $EXPECTED_PC"
    update_expected "holdings.positionCount" "$POSITION_COUNT"
  else
    log "FAIL" "holdings/position-count" "Actual $POSITION_COUNT outside ${POSITION_COUNT_TOL} tolerance of expected $EXPECTED_PC"
  fi
fi

# Extract total value from table footer
HOLDINGS_TOTAL=$(ab_eval <<'EVALEOF'
(() => {
  const footer = document.querySelector('tfoot');
  if (!footer) return 'NOT_FOUND';
  const cells = footer.querySelectorAll('td');
  for (const td of cells) {
    const text = td.textContent.trim();
    if (text.startsWith('$') && !text.includes('positions')) return text;
  }
  return 'NOT_FOUND'
})()
EVALEOF
)
log "INFO" "holdings/total-value" "Extracted footer total: $HOLDINGS_TOTAL"

EXPECTED_HV=$(json_get "holdings.totalValue")
if [ "$EXPECTED_HV" = "FILL_IN" ]; then
  log "SKIP" "holdings/total-value" "Expected not set (actual: $HOLDINGS_TOTAL)"
elif [ "$HOLDINGS_TOTAL" = "NOT_FOUND" ]; then
  log "FAIL" "holdings/total-value" "Holdings total not found in table footer"
else
  ACTUAL_NUM=$(parse_currency "$HOLDINGS_TOTAL")
  EXPECTED_NUM=$(parse_currency "$EXPECTED_HV")
  TOLERANCE=$(json_get "holdings.totalValueTolerance")
  RESULT=$(compare_with_tolerance "$ACTUAL_NUM" "$EXPECTED_NUM" "$TOLERANCE")
  if [ "$RESULT" = "OK" ]; then
    log "PASS" "holdings/total-value" "Actual $HOLDINGS_TOTAL within tolerance of expected $EXPECTED_HV"
    update_expected "holdings.totalValue" "$HOLDINGS_TOTAL"
  else
    log "FAIL" "holdings/total-value" "Actual $HOLDINGS_TOTAL outside tolerance of expected $EXPECTED_HV"
  fi
fi

# Check holdings table has rows
ROW_COUNT=$(ab_eval <<'EVALEOF'
document.querySelectorAll('tbody tr').length
EVALEOF
)
if [ "$ROW_COUNT" -gt 0 ] 2>/dev/null; then
  log "PASS" "holdings/table-rows" "Holdings table has $ROW_COUNT rows"
else
  log "FAIL" "holdings/table-rows" "Holdings table is empty"
fi

# ============================================================
# TAB 4: ANALYSIS (post-redesign sub-views — the old single-page
# sections now live under ?view=. Risk metrics are on the Performance
# view; factor + scenario cards are on the Diagnostics view. Checks
# lowercase innerText because KPI eyebrow labels render CSS-uppercased.)
# ============================================================

# --- 4a: Performance view (server-rendered: TWR/XIRR/drawdown/Sharpe) ---

navigate_and_screenshot "analysis-performance" "/dashboard/analysis?view=performance"
check_page_errors "analysis-performance" || true

RISK_PRESENT=$(ab_eval <<'EVALEOF'
(() => {
  const t = document.body.innerText.toLowerCase();
  return (t.includes('drawdown') && t.includes('sharpe')) ? 'true' : 'false';
})()
EVALEOF
)
if [ "$RISK_PRESENT" = "true" ]; then
  log "PASS" "analysis/riskMetrics" "Drawdown + Sharpe present on Performance view"
else
  log "FAIL" "analysis/riskMetrics" "Drawdown/Sharpe not found on Performance view"
fi

# TWR (relocated from the old Overview page — KPI strip on Performance)
TWR_YTD=$(ab_eval <<'EVALEOF'
(() => {
  const m = document.body.innerText.match(/TWR[^%]*?([+-]?\d+\.\d+%)/);
  return m ? m[1] : 'NOT_FOUND';
})()
EVALEOF
)
log "INFO" "analysis/twr" "Extracted: $TWR_YTD"

EXPECTED_TWR=$(json_get "performance.twrYtd")
if [ "$EXPECTED_TWR" = "FILL_IN" ]; then
  log "SKIP" "analysis/twr" "Expected not set (actual: $TWR_YTD)"
elif [ "$TWR_YTD" = "NOT_FOUND" ]; then
  log "FAIL" "analysis/twr" "TWR value not found on Performance view"
else
  ACTUAL_PCT=$(parse_percent "$TWR_YTD")
  EXPECTED_PCT=$(parse_percent "$EXPECTED_TWR")
  TWR_TOL=$(json_get "performance.twrYtdTolerance")
  RESULT=$(compare_absolute "$ACTUAL_PCT" "$EXPECTED_PCT" "$TWR_TOL")
  if [ "$RESULT" = "OK" ]; then
    log "PASS" "analysis/twr" "Actual $TWR_YTD within ${TWR_TOL}pp of expected $EXPECTED_TWR"
    update_expected "performance.twrYtd" "$TWR_YTD"
  else
    log "FAIL" "analysis/twr" "Actual $TWR_YTD outside ${TWR_TOL}pp tolerance of expected $EXPECTED_TWR"
  fi
fi

# XIRR presence (informational — needs cash-flow data)
XIRR_PRESENT=$(ab_eval <<'EVALEOF'
document.body.innerText.toLowerCase().includes('xirr') ? 'true' : 'false'
EVALEOF
)
if [ "$XIRR_PRESENT" = "true" ]; then
  log "PASS" "analysis/xirr-present" "XIRR metric is displayed"
else
  log "INFO" "analysis/xirr-present" "XIRR metric not shown (may require cash-flow data)"
fi

# --- 4b: Diagnostics view (factor + scenario cards; client components
# whose section HEADINGS render immediately post-hydration even while
# their fetches are loading — stable smoke targets) ---

navigate_and_screenshot "analysis-diagnostics" "/dashboard/analysis?view=diagnostics"
check_page_errors "analysis-diagnostics" || true

DIAG_SECTIONS=$(ab_eval <<'EVALEOF'
(() => {
  const t = document.body.innerText.toLowerCase();
  return JSON.stringify({
    factorAnalysis: t.includes('quantitative factor analysis'),
    scenarioModeling: t.includes('scenario modeling')
  });
})()
EVALEOF
)
log "INFO" "analysis/sections" "Found: $DIAG_SECTIONS"

for section in factorAnalysis scenarioModeling; do
  PRESENT=$(python3 -c "
import json, sys
try:
    data = json.loads('''$DIAG_SECTIONS''')
    print(data.get('$section', False))
except:
    print('False')
")
  if [ "$PRESENT" = "True" ]; then
    log "PASS" "analysis/$section" "Section present"
  else
    log "FAIL" "analysis/$section" "Section not found"
  fi
done

# ============================================================
# TAB 5: CHARTS
# ============================================================

navigate_and_screenshot "charts" "/dashboard/charts"
check_page_errors "charts" || true

# LightweightCharts renders to a canvas or div container
CHART_FOUND=$(ab_eval <<'EVALEOF'
(document.querySelector('canvas') !== null || document.querySelector('table') !== null) ? 'true' : 'false'
EVALEOF
)
if [ "$CHART_FOUND" = "true" ]; then
  log "PASS" "charts/chart-rendered" "Chart or data element found"
else
  log "FAIL" "charts/chart-rendered" "No chart canvas found"
fi

# ============================================================
# TAB 6: WEEK AHEAD (the Calendar tab was absorbed into Today at the
# IA collapse; /dashboard/calendar is a redirect stub to this URL —
# navigate the real destination directly.)
# ============================================================

navigate_and_screenshot "week-ahead" "/dashboard/today?view=week-ahead"
check_page_errors "week-ahead" || true

# WeekAheadView renders a "Week ahead" eyebrow (CSS-uppercased — match
# lowercase) + an h1 with the week's date range ("Jul 20 – Jul 26, 2026").
# The FIRST h1 on the page is the header wordmark, so scan all h1s.
WEEK_AHEAD=$(ab_eval <<'EVALEOF'
(() => {
  const hasEyebrow = document.body.innerText.toLowerCase().includes('week ahead');
  const hasRange = Array.from(document.querySelectorAll('h1')).some(h => /[A-Z][a-z]{2} \d+/.test(h.textContent));
  return (hasEyebrow || hasRange) ? 'true' : 'false';
})()
EVALEOF
)
if [ "$WEEK_AHEAD" = "true" ]; then
  log "PASS" "week-ahead/rendered" "Week-ahead view rendered with date range"
else
  log "FAIL" "week-ahead/rendered" "Week-ahead view not found"
fi

# ============================================================
# TAB 7: RESEARCH
# ============================================================

navigate_and_screenshot "research" "/dashboard/research"
check_page_errors "research" || true

# Check for view toggle (Notes / Trade Reviews / Feeds)
RESEARCH_TOGGLE=$(ab_eval <<'EVALEOF'
(() => {
  const text = document.body.innerText;
  const hasNotes = text.includes('Notes');
  const hasReviews = text.includes('Trade Reviews') || text.includes('Reviews');
  const hasFeeds = text.includes('Feeds');
  return (hasNotes || hasReviews || hasFeeds) ? 'true' : 'false';
})()
EVALEOF
)
if [ "$RESEARCH_TOGGLE" = "true" ]; then
  log "PASS" "research/view-toggle" "View toggle present"
else
  log "FAIL" "research/view-toggle" "View toggle not found"
fi

# ============================================================
# TAB 8: IMPORT
# ============================================================

navigate_and_screenshot "import" "/dashboard/import"
check_page_errors "import" || true

# Check for drop zone / file upload
IMPORT_ZONE=$(ab_eval <<'EVALEOF'
(() => {
  const text = document.body.innerText;
  return (text.includes('Drop') || text.includes('drop') || text.includes('Import') || text.includes('upload') || document.querySelector('input[type="file"]') !== null) ? 'true' : 'false';
})()
EVALEOF
)
if [ "$IMPORT_ZONE" = "true" ]; then
  log "PASS" "import/drop-zone" "File upload area present"
else
  log "FAIL" "import/drop-zone" "File upload area not found"
fi

# ============================================================
# CLEANUP
# ============================================================

echo "" >> "$REPORT"
echo "# Summary" >> "$REPORT"

# grep -c prints the count itself even on zero matches (exiting 1), so use
# `|| true` — an `|| echo "0"` here appends a SECOND zero ("FAIL: 00").
PASS_COUNT=$(grep -c '^\[.*\] PASS:' "$REPORT" 2>/dev/null || true)
FAIL_COUNT=$(grep -c '^\[.*\] FAIL:' "$REPORT" 2>/dev/null || true)
SKIP_COUNT=$(grep -c '^\[.*\] SKIP:' "$REPORT" 2>/dev/null || true)
# Trim whitespace/newlines (grep -c can include trailing newline on some systems)
PASS_COUNT="${PASS_COUNT//[^0-9]/}"
FAIL_COUNT="${FAIL_COUNT//[^0-9]/}"
SKIP_COUNT="${SKIP_COUNT//[^0-9]/}"

echo "PASS: $PASS_COUNT | FAIL: $FAIL_COUNT | SKIP: $SKIP_COUNT" >> "$REPORT"

# Close browser session
agent-browser --session "$SESSION" close 2>/dev/null || true

echo ""
echo -e "${CYAN}=== QA Complete ===${NC}"
echo -e "  ${GREEN}PASS${NC}: $PASS_COUNT"
echo -e "  ${RED}FAIL${NC}: $FAIL_COUNT"
echo -e "  ${YELLOW}SKIP${NC}: $SKIP_COUNT"
echo -e "\nReport: $REPORT"
echo -e "Screenshots: $SCREENSHOT_DIR/"

# Exit with failure code if any FAILs
if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
exit 0
