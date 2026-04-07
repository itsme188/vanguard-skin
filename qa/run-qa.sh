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

# Compare two numbers with a tolerance (as fraction, e.g., 0.02 = 2%)
compare_with_tolerance() {
  local actual="$1" expected="$2" tolerance="$3"
  python3 -c "
a, e, t = float('$actual'), float('$expected'), float('$tolerance')
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
a, e, t = float('$actual'), float('$expected'), float('$tolerance')
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
# TAB 1: OVERVIEW
# ============================================================

navigate_and_screenshot "overview" "/dashboard"
check_page_errors "overview" || true

# Extract portfolio value
PORTFOLIO_VALUE=$(ab_eval <<'EVALEOF'
(document.querySelector('.text-4xl.font-semibold.font-mono')?.textContent || '').trim()
EVALEOF
)
log "INFO" "overview/portfolio-value" "Extracted: $PORTFOLIO_VALUE"

EXPECTED_PV=$(json_get "overview.portfolioValue")
if [ "$EXPECTED_PV" = "FILL_IN" ]; then
  log "SKIP" "overview/portfolio-value" "Expected not set (actual: $PORTFOLIO_VALUE)"
else
  ACTUAL_NUM=$(parse_currency "$PORTFOLIO_VALUE")
  EXPECTED_NUM=$(parse_currency "$EXPECTED_PV")
  TOLERANCE=$(json_get "overview.portfolioValueTolerance")
  RESULT=$(compare_with_tolerance "$ACTUAL_NUM" "$EXPECTED_NUM" "$TOLERANCE")
  if [ "$RESULT" = "OK" ]; then
    log "PASS" "overview/portfolio-value" "Actual $PORTFOLIO_VALUE within ${TOLERANCE} of expected $EXPECTED_PV"
    update_expected "overview.portfolioValue" "$PORTFOLIO_VALUE"
  else
    log "FAIL" "overview/portfolio-value" "Actual $PORTFOLIO_VALUE outside ${TOLERANCE} tolerance of expected $EXPECTED_PV"
  fi
fi

# Extract account card count
ACCOUNT_COUNT=$(ab_eval <<'EVALEOF'
document.querySelectorAll('.text-2xl.font-semibold.font-mono.tabular-nums').length
EVALEOF
)
log "INFO" "overview/account-count" "Extracted: $ACCOUNT_COUNT"

EXPECTED_AC=$(json_get "overview.accountCount")
if [ "$EXPECTED_AC" = "FILL_IN" ]; then
  log "SKIP" "overview/account-count" "Expected not set (actual: $ACCOUNT_COUNT)"
elif [ "$ACCOUNT_COUNT" = "$EXPECTED_AC" ]; then
  log "PASS" "overview/account-count" "Account count matches: $ACCOUNT_COUNT"
  update_expected "overview.accountCount" "$ACCOUNT_COUNT"
else
  log "FAIL" "overview/account-count" "Expected $EXPECTED_AC accounts, got $ACCOUNT_COUNT"
fi

# Extract TWR YTD (first period button should be YTD, default selected)
TWR_YTD=$(ab_eval <<'EVALEOF'
(() => {
  const labels = document.querySelectorAll('.text-\\[11px\\].text-ink-faint.uppercase');
  for (const el of labels) {
    if (el.textContent.trim() === 'TWR') {
      const val = el.parentElement?.querySelector('.text-lg.font-mono')
      return val?.textContent?.trim() || 'NOT_FOUND'
    }
  }
  return 'NOT_FOUND'
})()
EVALEOF
)
log "INFO" "overview/twr-ytd" "Extracted: $TWR_YTD"

EXPECTED_TWR=$(json_get "overview.twrYtd")
if [ "$EXPECTED_TWR" = "FILL_IN" ]; then
  log "SKIP" "overview/twr-ytd" "Expected not set (actual: $TWR_YTD)"
elif [ "$TWR_YTD" = "NOT_FOUND" ]; then
  log "FAIL" "overview/twr-ytd" "TWR YTD element not found on page"
else
  ACTUAL_PCT=$(parse_percent "$TWR_YTD")
  EXPECTED_PCT=$(parse_percent "$EXPECTED_TWR")
  TWR_TOL=$(json_get "overview.twrYtdTolerance")
  RESULT=$(compare_absolute "$ACTUAL_PCT" "$EXPECTED_PCT" "$TWR_TOL")
  if [ "$RESULT" = "OK" ]; then
    log "PASS" "overview/twr-ytd" "Actual $TWR_YTD within ${TWR_TOL}pp of expected $EXPECTED_TWR"
    update_expected "overview.twrYtd" "$TWR_YTD"
  else
    log "FAIL" "overview/twr-ytd" "Actual $TWR_YTD outside ${TWR_TOL}pp tolerance of expected $EXPECTED_TWR"
  fi
fi

# Check XIRR presence
XIRR_PRESENT=$(ab_eval <<'EVALEOF'
(() => {
  const labels = document.querySelectorAll('.text-\\[11px\\].text-ink-faint.uppercase');
  for (const el of labels) {
    if (el.textContent.trim() === 'XIRR') return 'true'
  }
  return 'false'
})()
EVALEOF
)
if [ "$XIRR_PRESENT" = "true" ]; then
  log "PASS" "overview/xirr-present" "XIRR metric is displayed"
else
  log "INFO" "overview/xirr-present" "XIRR metric not shown (may require cash-flow data)"
fi

# Check data freshness indicator
FRESHNESS_TITLE=$(ab_eval <<'EVALEOF'
(document.querySelector('a[href*="data-health"]')?.getAttribute('title') || 'NOT_FOUND')
EVALEOF
)
if [ "$FRESHNESS_TITLE" != "NOT_FOUND" ]; then
  log "PASS" "overview/data-freshness" "Indicator present: $FRESHNESS_TITLE"
else
  log "FAIL" "overview/data-freshness" "Data freshness indicator not found"
fi

# Check portfolio chart
CHART_PRESENT=$(ab_eval <<'EVALEOF'
(document.querySelector('.recharts-responsive-container') !== null) ? 'true' : 'false'
EVALEOF
)
if [ "$CHART_PRESENT" = "true" ]; then
  log "PASS" "overview/portfolio-chart" "Portfolio chart rendered"
else
  log "FAIL" "overview/portfolio-chart" "Portfolio chart not found"
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
# TAB 3: HOLDINGS
# ============================================================

navigate_and_screenshot "holdings" "/dashboard/holdings"
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
# TAB 4: ANALYSIS
# ============================================================

navigate_and_screenshot "analysis" "/dashboard/analysis"
check_page_errors "analysis" || true

# Check for key sections by looking for headings/cards
ANALYSIS_SECTIONS=$(ab_eval <<'EVALEOF'
JSON.stringify({
  riskMetrics: document.body.innerText.includes('Drawdown') || document.body.innerText.includes('Volatility') || document.body.innerText.includes('Sharpe'),
  factorAnalysis: document.body.innerText.includes('Factor') || document.body.innerText.includes('Beta') || document.body.innerText.includes('Alpha'),
  scenarioModeling: document.body.innerText.includes('Scenario') || document.body.innerText.includes('Stress'),
  fixedIncome: document.body.innerText.includes('Bond') || document.body.innerText.includes('Duration') || document.body.innerText.includes('Fixed Income'),
  allocationChart: document.querySelector('svg') !== null
})
EVALEOF
)
log "INFO" "analysis/sections" "Found: $ANALYSIS_SECTIONS"

# Parse individual checks
for section in riskMetrics factorAnalysis scenarioModeling; do
  PRESENT=$(python3 -c "
import json, sys
try:
    data = json.loads('''$ANALYSIS_SECTIONS''')
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
# TAB 6: CALENDAR
# ============================================================

navigate_and_screenshot "calendar" "/dashboard/calendar"
check_page_errors "calendar" || true

# Check for week navigation (uses ←/This Week/→ buttons and date range)
CALENDAR_NAV=$(ab_eval <<'EVALEOF'
(() => {
  const main = document.getElementById('main-content') || document.querySelector('main') || document.body;
  const text = main.innerText;
  return (text.includes('This Week') || text.includes('Week of') || (text.includes('←') && text.includes('→'))) ? 'true' : 'false';
})()
EVALEOF
)
if [ "$CALENDAR_NAV" = "true" ]; then
  log "PASS" "calendar/navigation" "Week navigation present"
else
  log "FAIL" "calendar/navigation" "Week navigation not found"
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

PASS_COUNT=$(grep -c '^\[.*\] PASS:' "$REPORT" 2>/dev/null || echo "0")
FAIL_COUNT=$(grep -c '^\[.*\] FAIL:' "$REPORT" 2>/dev/null || echo "0")
SKIP_COUNT=$(grep -c '^\[.*\] SKIP:' "$REPORT" 2>/dev/null || echo "0")
# Trim whitespace (grep -c can include trailing newline on some systems)
FAIL_COUNT="${FAIL_COUNT//[^0-9]/}"

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
