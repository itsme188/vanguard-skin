#!/usr/bin/env bash
# Vanguard Skin QA — Run and Summarize Failures
# Runs the QA suite and if there are failures, prints a summary
# and suggests a Claude Code command to auto-fix them.
#
# Usage: bash qa/fix-failures.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPORT="$SCRIPT_DIR/qa-report.txt"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${CYAN}${BOLD}Running Vanguard Skin QA suite...${NC}\n"

# Run the QA suite (don't exit on failure — we want to analyze)
bash "$SCRIPT_DIR/run-qa.sh"
QA_EXIT=$?

echo ""
echo -e "${CYAN}${BOLD}════════════════════════════════════════${NC}"
echo -e "${CYAN}${BOLD}        QA RESULTS SUMMARY${NC}"
echo -e "${CYAN}${BOLD}════════════════════════════════════════${NC}"
echo ""

if [ ! -f "$REPORT" ]; then
  echo -e "${RED}No report file found at $REPORT${NC}"
  exit 1
fi

# Count results
PASS_COUNT=$(grep -c '^\[.*\] PASS:' "$REPORT" || echo "0")
FAIL_COUNT=$(grep -c '^\[.*\] FAIL:' "$REPORT" || echo "0")
SKIP_COUNT=$(grep -c '^\[.*\] SKIP:' "$REPORT" || echo "0")

echo -e "  ${GREEN}PASS${NC}: $PASS_COUNT"
echo -e "  ${RED}FAIL${NC}: $FAIL_COUNT"
echo -e "  ${YELLOW}SKIP${NC}: $SKIP_COUNT"
echo ""

# Show failures in detail
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo -e "${RED}${BOLD}Failures:${NC}"
  grep "FAIL:" "$REPORT" | while IFS= read -r line; do
    echo -e "  ${RED}${line}${NC}"
  done
  echo ""

  echo -e "${YELLOW}${BOLD}To auto-fix with Claude Code:${NC}"
  echo ""
  echo "  claude -p \"Read qa/qa-report.txt and qa/screenshots/. For each FAIL entry:"
  echo "    1. Identify the likely cause by reading the relevant source file"
  echo "    2. Attempt a fix (2 attempts max per issue)"
  echo "    3. If unfixable, note why in qa/qa-report.txt"
  echo "    Work from the project root: $(dirname "$SCRIPT_DIR")\""
  echo ""
fi

# Show skips (unfilled expected values)
if [ "$SKIP_COUNT" -gt 0 ]; then
  echo -e "${YELLOW}${BOLD}Skipped checks (fill in qa/expected-values.json):${NC}"
  grep "SKIP:" "$REPORT" | while IFS= read -r line; do
    echo -e "  ${YELLOW}${line}${NC}"
  done
  echo ""
fi

if [ "$FAIL_COUNT" -eq 0 ]; then
  echo -e "${GREEN}${BOLD}All checks passed!${NC}"
fi

exit $QA_EXIT
