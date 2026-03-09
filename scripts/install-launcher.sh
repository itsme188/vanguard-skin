#!/bin/bash
#
# install-launcher.sh -- Build and install the Vanguard Dashboard.app
#
# Run this once (or after editing VanguardDashboard.applescript) to
# compile the AppleScript into a .app on the Desktop.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="Vanguard Dashboard"
APPLESCRIPT_SOURCE="${SCRIPT_DIR}/VanguardDashboard.applescript"
APP_DESTINATION="${HOME}/Desktop/${APP_NAME}.app"

echo "Building ${APP_NAME}.app..."

# Make the launch script executable
chmod +x "${SCRIPT_DIR}/launch-dashboard.sh"

# Remove existing app if present (osacompile won't overwrite cleanly)
if [ -d "$APP_DESTINATION" ]; then
    echo "Removing existing ${APP_NAME}.app..."
    rm -rf "$APP_DESTINATION"
fi

# Compile the AppleScript into a stay-open .app bundle
osacompile -s -o "$APP_DESTINATION" "$APPLESCRIPT_SOURCE"

echo ""
echo "Installed: ${APP_DESTINATION}"
echo ""
echo "To launch: Double-click '${APP_NAME}' on your Desktop"
echo "To stop:   Quit the app from the Dock (right-click > Quit, or Cmd+Q)"
echo ""
