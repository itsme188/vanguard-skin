-- Vanguard Portfolio Dashboard Launcher
-- A stay-open application that manages the Next.js dev server
--
-- Double-click to start the server and open the browser.
-- Quit from the Dock (right-click > Quit, or Cmd+Q) to stop the server.
-- Click the Dock icon while running to re-open the browser.

property launchScript : "/Users/Yitzi/code/vanguard-skin/scripts/launch-dashboard.sh"
property dashboardURL : "http://localhost:3099"
property serverStarted : false

on run
	-- Check if already running
	try
		set statusResult to do shell script launchScript & " status"
		if statusResult is "RUNNING" then
			set serverStarted to true
			open location dashboardURL
			display notification "Dashboard is already running" with title "Vanguard Dashboard"
			return
		end if
	end try

	-- Show starting notification
	display notification "Starting portfolio dashboard..." with title "Vanguard Dashboard" subtitle "This may take a few seconds"

	-- Start the server
	try
		set startResult to do shell script launchScript & " start"

		if startResult is "STARTED" or startResult is "ALREADY_RUNNING" then
			set serverStarted to true
			open location dashboardURL
			display notification "Dashboard is ready!" with title "Vanguard Dashboard" subtitle dashboardURL
		else if startResult is "PORT_BUSY" then
			display dialog "Port 3099 is already in use by another application. Please close it and try again." buttons {"OK"} default button "OK" with icon stop with title "Vanguard Dashboard"
			quit
		else
			display dialog "Failed to start the dashboard server. Check /tmp/vanguard-dashboard.log for details." buttons {"View Log", "OK"} default button "OK" with icon stop with title "Vanguard Dashboard"
			if button returned of result is "View Log" then
				do shell script "open -a TextEdit /tmp/vanguard-dashboard.log"
			end if
			quit
		end if
	on error errMsg
		display dialog "Error starting dashboard: " & errMsg buttons {"View Log", "OK"} default button "OK" with icon stop with title "Vanguard Dashboard"
		if button returned of result is "View Log" then
			try
				do shell script "open -a TextEdit /tmp/vanguard-dashboard.log"
			end try
		end if
		quit
	end try
end run

on quit
	-- Clean shutdown of the dev server
	if serverStarted then
		try
			do shell script launchScript & " stop"
			display notification "Dashboard server stopped" with title "Vanguard Dashboard"
		on error errMsg
			-- Force kill anything on our port as last resort
			try
				do shell script "lsof -ti :3099 -sTCP:LISTEN | xargs kill -9 2>/dev/null || true"
			end try
		end try
	end if
	continue quit
end quit

on reopen
	-- User clicked the Dock icon again -- reopen the browser
	if serverStarted then
		open location dashboardURL
	end if
end reopen

on idle
	-- Keep the app running (stay-open applet)
	-- Check every 30 seconds if server is still alive
	if serverStarted then
		try
			do shell script launchScript & " status"
		on error
			-- Server died unexpectedly
			set serverStarted to false
			display notification "Dashboard server stopped unexpectedly" with title "Vanguard Dashboard" subtitle "Relaunch the app to restart"
			quit
		end try
	end if
	return 30
end idle
