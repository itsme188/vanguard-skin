#!/bin/bash
#
# launch-dashboard.sh -- lifecycle manager for the Vanguard Portfolio dev server
#
# Usage:
#   ./scripts/launch-dashboard.sh start   # Start server (if not already running)
#   ./scripts/launch-dashboard.sh stop    # Stop server gracefully
#   ./scripts/launch-dashboard.sh status  # Check if running (exit 0 = yes, 1 = no)
#   ./scripts/launch-dashboard.sh url     # Print the URL the server is listening on
#

set -euo pipefail

# === Configuration ===
PROJECT_DIR="/Users/Yitzi/code/vanguard-skin"
PORT=3099
PID_FILE="/tmp/vanguard-dashboard.pid"
LOG_FILE="/tmp/vanguard-dashboard.log"
NPM="/opt/homebrew/bin/npm"

# === Helper Functions ===

is_running() {
    if [ -f "$PID_FILE" ]; then
        local pid
        pid=$(cat "$PID_FILE")
        if kill -0 "$pid" 2>/dev/null; then
            return 0
        else
            # Stale PID file
            rm -f "$PID_FILE"
            return 1
        fi
    fi
    return 1
}

wait_for_server() {
    local max_attempts=60
    local attempt=0
    while [ $attempt -lt $max_attempts ]; do
        if curl -s -o /dev/null -w "%{http_code}" "http://localhost:${PORT}" 2>/dev/null | grep -qE "200|301|302|304|307|308"; then
            return 0
        fi
        sleep 1
        attempt=$((attempt + 1))
    done
    return 1
}

# === Commands ===

cmd_start() {
    if is_running; then
        echo "ALREADY_RUNNING"
        exit 0
    fi

    # Check if something else is using our port
    if lsof -i ":${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
        echo "PORT_BUSY"
        exit 2
    fi

    cd "$PROJECT_DIR"

    # Start Next.js dev server, fully detached from this script's FDs
    PORT=$PORT $NPM run dev </dev/null >"$LOG_FILE" 2>&1 &
    local server_pid=$!
    echo "$server_pid" > "$PID_FILE"
    disown "$server_pid" 2>/dev/null || true

    echo "STARTING"
    exit 0
}

cmd_ready() {
    # Quick one-shot readiness check (non-blocking)
    if ! is_running; then
        echo "NOT_RUNNING"
        exit 1
    fi
    if curl -s -o /dev/null -w "%{http_code}" "http://localhost:${PORT}" 2>/dev/null | grep -qE "200|301|302|304|307|308"; then
        echo "READY"
        exit 0
    else
        echo "NOT_READY"
        exit 2
    fi
}

cmd_stop() {
    if ! is_running; then
        echo "NOT_RUNNING"
        exit 0
    fi

    local pid
    pid=$(cat "$PID_FILE")

    # Send SIGTERM to the process group (kills node + child processes)
    kill -- -"$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true

    # Wait up to 5 seconds for graceful shutdown
    local attempts=0
    while [ $attempts -lt 10 ]; do
        if ! kill -0 "$pid" 2>/dev/null; then
            break
        fi
        sleep 0.5
        attempts=$((attempts + 1))
    done

    # Force kill if still running
    if kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null || true
    fi

    # Clean up any remaining processes on our port
    lsof -ti ":${PORT}" -sTCP:LISTEN 2>/dev/null | xargs kill -9 2>/dev/null || true

    rm -f "$PID_FILE"
    echo "STOPPED"
}

cmd_status() {
    if is_running; then
        echo "RUNNING"
        exit 0
    else
        echo "NOT_RUNNING"
        exit 1
    fi
}

cmd_url() {
    echo "http://localhost:${PORT}"
}

# === Main Dispatch ===

case "${1:-}" in
    start)  cmd_start ;;
    stop)   cmd_stop ;;
    status) cmd_status ;;
    ready)  cmd_ready ;;
    url)    cmd_url ;;
    *)
        echo "Usage: $0 {start|stop|status|ready|url}" >&2
        exit 1
        ;;
esac
