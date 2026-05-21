#!/bin/bash
# Shared ET-clock gating for launchd-driven cron wrappers.
#
# macOS launchd `StartCalendarInterval` fires at the system's local time and
# has no per-job timezone override. When the Mac travels to a non-ET zone
# (e.g. Israel), Hour:8 means 8:00 IDT, not 8:00 ET — emails arrive at the
# wrong moment. The fix is to switch the plist to `StartInterval=300` (every
# 5 min) and gate the script on ET wall-clock here.
#
# Source this file near the top of any wrapper, then call:
#
#   in_et_window "1,2,3,4,5" 8 45 || exit 0   # Mon-Fri at 8:45 ET (10 min window)
#   in_et_window "7" 15 0 || exit 0           # Sunday at 15:00 ET
#
# Multiple windows in one script (e.g. weekday + Friday-early):
#
#   in_et_window "1,2,3,4" 19 0 || in_et_window "5" 17 30 || exit 0
#
# Arguments:
#   $1  dow_set     comma-separated %u digits (1=Mon..7=Sun), e.g. "1,2,3,4,5"
#   $2  target_hr   target ET hour 0-23
#   $3  target_min  target ET minute 0-59
#   $4  window      window width in minutes (default 10) — be tolerant of
#                   launchd tick drift; with StartInterval=300 expect 1-2
#                   ticks inside a 10-min window. API marker dedup handles
#                   duplicates.
#
# Caches the ET clock once at source time so a script with multiple
# in_et_window calls doesn't shell out to `date` repeatedly.

ET_DOW=$(TZ=America/New_York date +%u)
read -r ET_H ET_M < <(TZ=America/New_York date '+%H %M')
# 10# forces base 10 — bash treats "08" / "09" as invalid octal otherwise.
ET_MIN_OF_DAY=$((10#$ET_H * 60 + 10#$ET_M))

in_et_window() {
  local dow_set="$1" target_h="$2" target_m="$3" window="${4:-10}"
  [[ ",$dow_set," == *",$ET_DOW,"* ]] || return 1
  local target_min=$(( target_h * 60 + target_m ))
  [ "$ET_MIN_OF_DAY" -ge "$target_min" ] && [ "$ET_MIN_OF_DAY" -lt "$((target_min + window))" ]
}
