#!/usr/bin/env bash
# verify-smoke.sh — Browser smoke verification for the #52 verification loop.
#
# Usage:
#   VERIFY_SMOKE_PASSWORD=... npm run verify:smoke
#
# Detects a healthy server (dev :3000 first, packaged app :3099 fallback);
# NEVER starts one. Verifies app identity before any credential entry.
# Four flows: login surface, dashboard landing, import preview (never
# commits), Cmd+K no-match empty state. Evidence (screenshots + summary.md)
# goes to qa/verify-evidence/<timestamp>/ (gitignored). Privacy mode is
# enabled before authenticated screenshots. The password is read from
# VERIFY_SMOKE_PASSWORD and passed to the browser via `eval --stdin` only.
#
# Optional env hooks (ADDITIVE — every default below reproduces the behavior
# described above; scripts/coord/smoke.sh sets them for a task sandbox):
#   VERIFY_SMOKE_BASE_URL      skip port detection and target this server. The
#                              /login identity check still runs first, before
#                              any credential or cookie is used, and the host
#                              must be localhost or 127.0.0.1.
#   VERIFY_SMOKE_SESSION_ENV   path to a session.env (VGS_SESSION/VGS_CSRF, as
#                              minted by scripts/mint-qa-session.ts). When set,
#                              authenticate by setting those cookies instead of
#                              typing a password — VERIFY_SMOKE_PASSWORD is then
#                              not required and never read.
#   VERIFY_SMOKE_SESSION       agent-browser session name (default verify-smoke-$$).
#   VERIFY_SMOKE_EVIDENCE_DIR  evidence directory (default qa/verify-evidence/<stamp>).
#   VERIFY_SMOKE_NO_GLOBAL_CLEANUP=1
#                              skip the shared agent-browser cleanup, whose EXIT
#                              trap runs `agent-browser close --all` and would
#                              close OTHER agents' sessions (2026-09-06
#                              contention). This script's own `ab close` still runs.
set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"
export PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH"

# --- Preconditions -----------------------------------------------------------
command -v agent-browser >/dev/null 2>&1 || { echo "FAIL: agent-browser CLI not on PATH"; exit 1; }
# Authentication: a wrapper-supplied session file (sandbox mode) OR the password
# (the default, unchanged). Sourcing happens here so a bad file fails before any
# browser work; the cookies are only USED after the /login identity check.
SESSION_ENV_FILE="${VERIFY_SMOKE_SESSION_ENV:-}"
if [ -n "$SESSION_ENV_FILE" ]; then
  if [ ! -r "$SESSION_ENV_FILE" ]; then
    echo "FAIL: VERIFY_SMOKE_SESSION_ENV is set but not readable: $SESSION_ENV_FILE"
    exit 1
  fi
  # shellcheck source=/dev/null
  . "$SESSION_ENV_FILE"
  if [ -z "${VGS_SESSION:-}" ] || [ -z "${VGS_CSRF:-}" ]; then
    echo "FAIL: $SESSION_ENV_FILE must define VGS_SESSION and VGS_CSRF"
    exit 1
  fi
elif [ -z "${VERIFY_SMOKE_PASSWORD:-}" ]; then
  echo "FAIL: VERIFY_SMOKE_PASSWORD is not set."
  echo "Export the app password (the one the login page accepts) and re-run:"
  echo "  VERIFY_SMOKE_PASSWORD=... npm run verify:smoke"
  exit 1
fi

echo "NOTE: if you changed server-side code, restart the dev server before trusting this smoke."

# --- Server detection + identity check (before ANY credential use) ----------
BASE_URL=""
if [ -n "${VERIFY_SMOKE_BASE_URL:-}" ]; then
  # Explicit target (task sandbox). Loopback only, and the identity marker is
  # still required BEFORE any credential or cookie use — fail closed.
  CANDIDATE="${VERIFY_SMOKE_BASE_URL%/}"
  CANDIDATE_HOST=$(printf '%s' "$CANDIDATE" | sed -e 's#^[a-zA-Z][a-zA-Z0-9+.-]*://##' -e 's#/.*$##' -e 's#@.*$##' -e 's#:[0-9]*$##')
  case "$CANDIDATE_HOST" in
    localhost|127.0.0.1) ;;
    *) echo "FAIL: VERIFY_SMOKE_BASE_URL host '$CANDIDATE_HOST' is not loopback — refusing."; exit 1 ;;
  esac
  html=$(curl -sf --max-time 5 "${CANDIDATE}/login" 2>/dev/null || true)
  if printf '%s' "$html" | grep -q "Portfolio Desk"; then
    BASE_URL="$CANDIDATE"
  else
    echo "FAIL: $CANDIDATE is not a healthy Portfolio Desk server (no identity marker on /login)."
    echo "No credentials were sent."
    exit 1
  fi
else
  for port in 3000 3099; do
    html=$(curl -sf --max-time 5 "http://localhost:${port}/login" 2>/dev/null || true)
    if printf '%s' "$html" | grep -q "Portfolio Desk"; then
      # localhost (not 127.0.0.1): login cookies default to Secure, and
      # Secure-over-http is reliably accepted only for the localhost hostname.
      BASE_URL="http://localhost:${port}"
      break
    elif [ -n "$html" ]; then
      echo "WARN: port ${port} responded but is NOT Portfolio Desk — skipping (no credentials sent)."
    fi
  done
  if [ -z "$BASE_URL" ]; then
    echo "FAIL: no healthy Portfolio Desk server on :3000 or :3099."
    echo "Start one first (never done by this script — Turbopack is single-writer):"
    echo "  npm run dev            # dev server on :3000 (needs APP_PASSWORD_HASH in its env)"
    echo "  open the packaged app  # serves :3099 with keychain-injected auth"
    exit 1
  fi
fi
echo "Target: $BASE_URL"

# --- Evidence dir + cleanup --------------------------------------------------
STAMP=$(TZ=America/New_York date '+%Y-%m-%d-%H%M')
EVIDENCE="${VERIFY_SMOKE_EVIDENCE_DIR:-$PROJECT_DIR/qa/verify-evidence/$STAMP}"
mkdir -p "$EVIDENCE"
SUMMARY="$EVIDENCE/summary.md"
SESSION="${VERIFY_SMOKE_SESSION:-verify-smoke-$$}"
if [ "${VERIFY_SMOKE_NO_GLOBAL_CLEANUP:-}" = "1" ]; then
  # A wrapper owns the browser lifecycle (scripts/coord/smoke.sh): the shared
  # cleanup's EXIT trap would `agent-browser close --all` and take out another
  # agent's session. The per-session `ab close` at the end still runs.
  echo "NOTE: global agent-browser cleanup skipped (VERIFY_SMOKE_NO_GLOBAL_CLEANUP=1)."
else
  source "$PROJECT_DIR/qa/lib/agent-browser-cleanup.sh"
  ab_cleanup_init
fi

PASS=0; FAIL=0
record() { # record <flow> <PASS|FAIL> <detail>
  echo "- **$1**: $2 — $3" >> "$SUMMARY"
  if [ "$2" = "PASS" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL[$1]: $3"; fi
}
# Every browser command is bounded at 30s (perl alarm — portable on macOS,
# bash-3.2 safe) so no flow can hang the smoke forever.
ab() { perl -e 'alarm shift; exec @ARGV' 30 agent-browser --session "$SESSION" "$@"; }
ab_eval() { ab eval --stdin 2>/dev/null | sed 's/^"//;s/"$//'; }

printf '%s\n' "# verify:smoke — $STAMP" "" "Target: $BASE_URL" "" "## Flows" "" > "$SUMMARY"

# --- Flow 1: login surface ---------------------------------------------------
ab open "$BASE_URL/login" >/dev/null 2>&1
ab wait --load networkidle >/dev/null 2>&1
h1=$(printf '%s' 'document.querySelector("h1")?.textContent || ""' | ab_eval)
ab screenshot "$EVIDENCE/1-login.png" >/dev/null 2>&1
if [ "$h1" = "Portfolio Desk" ]; then
  record "login-surface" PASS "h1 identity marker + screenshot 1-login.png"
else
  record "login-surface" FAIL "expected h1 'Portfolio Desk', got '$h1'"
fi

# Enable privacy mode BEFORE authenticating (same origin — persists post-login)
printf '%s' 'localStorage.setItem("vgs:privacyMode","1"); "ok"' | ab_eval >/dev/null

# --- Login (secret via stdin eval only; never argv, never echoed) -----------
# read -r -d '' (quoted heredoc, NO command substitution): apostrophes inside
# are safe on bash 3.2; $(cat <<EOF) is the documented crash shape — never use it.
if [ -n "$SESSION_ENV_FILE" ]; then
  # Sandbox mode: adopt the session minted into the sandbox DB copy. Same
  # origin as the identity check above, so the cookies land on the right host.
  read -r -d '' COOKIE_JS <<'EOF' || true
(() => {
  document.cookie = "vgs_session=" + __SESSION__ + "; path=/";
  document.cookie = "vgs_csrf=" + __CSRF__ + "; path=/";
  return "cookies-set";
})()
EOF
  SESSION_JSON=$(VGS_SESSION="$VGS_SESSION" python3 -c 'import json,os;print(json.dumps(os.environ["VGS_SESSION"]))')
  CSRF_JSON=$(VGS_CSRF="$VGS_CSRF" python3 -c 'import json,os;print(json.dumps(os.environ["VGS_CSRF"]))')
  COOKIE_JS="${COOKIE_JS/__SESSION__/$SESSION_JSON}"
  ab open "$BASE_URL/login" >/dev/null 2>&1
  printf '%s' "${COOKIE_JS/__CSRF__/$CSRF_JSON}" | ab_eval >/dev/null
  ab open "$BASE_URL/dashboard/today" >/dev/null 2>&1
else
  read -r -d '' LOGIN_JS <<'EOF' || true
(() => {
  const el = document.querySelector("#password");
  if (!el) return "no-input";
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(el, __PW__);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  setTimeout(() => document.querySelector('button[type="submit"]')?.click(), 50);
  return "submitted";
})()
EOF
  # Substitute the password as a JSON string literal (handles quotes/backslashes)
  PW_JSON=$(python3 -c 'import json,os;print(json.dumps(os.environ["VERIFY_SMOKE_PASSWORD"]))')
  printf '%s' "${LOGIN_JS/__PW__/$PW_JSON}" | ab_eval >/dev/null
fi
ab wait --load networkidle >/dev/null 2>&1
ab wait 2000 >/dev/null 2>&1

# --- Flow 2: dashboard landing ----------------------------------------------
loc=$(printf '%s' 'window.location.pathname' | ab_eval)
err=$(printf '%s' 'document.querySelector("[role=alert]")?.textContent || ""' | ab_eval)
nav=$(printf '%s' 'document.querySelector("nav") ? "yes" : "no"' | ab_eval)
boundary=$(printf '%s' 'document.body.innerText.includes("Application error") ? "yes" : "no"' | ab_eval)
ab screenshot "$EVIDENCE/2-dashboard.png" >/dev/null 2>&1
if [ "$loc" = "/dashboard/today" ] && [ "$nav" = "yes" ] && [ "$boundary" = "no" ]; then
  record "dashboard-landing" PASS "redirected to /dashboard/today, tab nav present, no error boundary (privacy mode on) — 2-dashboard.png"
else
  hint=""
  case "$err" in *unavailable*) hint=" (server likely missing APP_PASSWORD_HASH — dev servers need it exported)";; esac
  record "dashboard-landing" FAIL "loc='$loc' nav=$nav errorBoundary=$boundary alert='$err'$hint"
fi

# --- Flow 3: import preview (NEVER commits) ----------------------------------
DB_PATH="${DATABASE_PATH:-$PROJECT_DIR/data/vanguard.db}"
# Fail CLOSED: the count must be numeric; a failed query must not compare
# "n/a" == "n/a" into a pass.
batches_count() {
  local n
  n=$(sqlite3 "file:$DB_PATH?mode=ro" "SELECT COUNT(*) FROM import_batches;" 2>/dev/null)
  case "$n" in ''|*[!0-9]*) echo "query-failed";; *) echo "$n";; esac
}
batches_before=$(batches_count)
ab open "$BASE_URL/dashboard/import" >/dev/null 2>&1
ab wait --load networkidle >/dev/null 2>&1
FIXTURE_JSON=$(python3 -c 'import json;print(json.dumps(open("tests/fixtures/vanguard-holdings-sample.csv").read()))')
read -r -d '' DROP_JS <<'EOF' || true
(() => {
  const zone = document.querySelector('[aria-label="File upload drop zone"]');
  if (!zone) return "no-zone";
  const dt = new DataTransfer();
  dt.items.add(new File([__CSV__], "vanguard-holdings-sample.csv", { type: "text/csv" }));
  zone.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  return "dropped";
})()
EOF
printf '%s' "${DROP_JS/__CSV__/$FIXTURE_JSON}" | ab_eval >/dev/null
ab wait --load networkidle >/dev/null 2>&1
ab wait 3000 >/dev/null 2>&1
preview=$(printf '%s' '[...document.querySelectorAll("h3")].some(h => h.textContent === "Import Preview") ? "yes" : "no"' | ab_eval)
btn=$(printf '%s' '[...document.querySelectorAll("button")].map(b => b.textContent.trim()).find(t => t.startsWith("Import ")) || ""' | ab_eval)
# Assert the six preview count cells against the fixture's known contents
# (label/value pairs from the preview grid; fixture = 4 holdings rows).
read -r -d '' COUNTS_JS <<'EOF' || true
(() => {
  const want = { Transactions: 0, Securities: 4, Holdings: 4, Prices: 4, Snapshots: 0 };
  const cells = [...document.querySelectorAll("div")].filter((d) => d.children.length === 0);
  const bad = [];
  for (const [label, n] of Object.entries(want)) {
    const labelEl = cells.find((c) => c.textContent.trim() === label);
    const valueEl = labelEl && labelEl.previousElementSibling;
    const got = valueEl ? valueEl.textContent.trim() : "missing";
    if (got !== String(n)) bad.push(label + "=" + got + " want " + n);
  }
  return bad.length === 0 ? "counts-ok" : bad.join("; ");
})()
EOF
counts=$(printf '%s' "$COUNTS_JS" | ab_eval)
ab screenshot "$EVIDENCE/3-import-preview.png" >/dev/null 2>&1
# leave preview WITHOUT committing
printf '%s' '[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Cancel")?.click(); "cancelled"' | ab_eval >/dev/null
batches_after=$(batches_count)
if [ "$preview" = "yes" ] && [ "$btn" = "Import 1 file" ] && [ "$counts" = "counts-ok" ] \
   && [ "$batches_before" != "query-failed" ] && [ "$batches_before" = "$batches_after" ]; then
  record "import-preview" PASS "preview counts match fixture (Sec/Hold/Prices=4, Txn/Snap=0), 'Import 1 file' present (not clicked), import_batches unchanged ($batches_before) — 3-import-preview.png"
else
  record "import-preview" FAIL "preview=$preview btn='$btn' counts='$counts' batches $batches_before->$batches_after"
fi

# --- Flow 4: Cmd+K no-match empty state --------------------------------------
ab open "$BASE_URL/dashboard/today" >/dev/null 2>&1
ab wait --load networkidle >/dev/null 2>&1
printf '%s' 'document.querySelector("button[aria-label=\"Open search\"]")?.click(); "opened"' | ab_eval >/dev/null
ab wait 500 >/dev/null 2>&1
read -r -d '' CMDK_JS <<'EOF' || true
(() => {
  const input = document.querySelector('input[placeholder^="Jump to ticker"]');
  if (!input) return "no-input";
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(input, "ZZZXQ99");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return "typed";
})()
EOF
printf '%s' "$CMDK_JS" | ab_eval >/dev/null
ab wait 1500 >/dev/null 2>&1
nomatch=$(printf '%s' 'document.body.innerText.includes("No ticker matches") ? "yes" : "no"' | ab_eval)
ab screenshot "$EVIDENCE/4-cmdk-empty.png" >/dev/null 2>&1
if [ "$nomatch" = "yes" ]; then
  record "cmdk-empty-state" PASS "deterministic no-match state rendered — 4-cmdk-empty.png"
else
  record "cmdk-empty-state" FAIL "no-match text not found"
fi

# --- Wrap up -----------------------------------------------------------------
ab close >/dev/null 2>&1 || true
printf '%s\n' "" "## Result" "" "- Passed: $PASS / 4" "- Evidence: $EVIDENCE" >> "$SUMMARY"
echo ""
echo "verify:smoke — $PASS/4 passed. Evidence: $EVIDENCE"
[ "$FAIL" -eq 0 ] || exit 1
