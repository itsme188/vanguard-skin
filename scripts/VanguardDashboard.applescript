-- Vanguard Portfolio Dashboard Launcher
-- A stay-open application that manages the Next.js dev server
--
-- Double-click to start the server and open the browser.
-- Quit from the Dock (right-click > Quit, or Cmd+Q) to stop the server.
-- Click the Dock icon while running to re-open the browser.

property launchScript : "/Users/Yitzi/code/vanguard-skin/scripts/launch-dashboard.sh"
property dashboardURL : "http://localhost:3099"
property serverState : "idle" -- idle | starting | running

on run
	if serverState is "running" then
		open location dashboardURL
		return
	end if

	-- Check if already running from a previous session
	try
		set statusResult to do shell script launchScript & " status"
		if statusResult is "RUNNING" then
			-- Check if it's actually ready to serve
			try
				do shell script launchScript & " ready"
				set serverState to "running"
				open location dashboardURL
				display notification "Dashboard is already running" with title "Vanguard Dashboard"
				return
			end try
			-- It's running but not ready yet — fall through to polling
			set serverState to "starting"
			display notification "Dashboard is starting up..." with title "Vanguard Dashboard"
			return
		end if
	end try

	-- Start the server (returns immediately, doesn't block)
	try
		do shell script launchScript & " start"
		set serverState to "starting"
		display notification "Starting portfolio dashboard..." with title "Vanguard Dashboard" subtitle "This may take a few seconds"
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
	if serverState is not "idle" then
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
	if serverState is "running" then
		open location dashboardURL
	end if
end reopen

on idle
	if serverState is "starting" then
		-- Poll for readiness every 2 seconds
		try
			set readyResult to do shell script launchScript & " ready"
			if readyResult is "READY" then
				set serverState to "running"
				open location dashboardURL
				display notification "Dashboard is ready!" with title "Vanguard Dashboard" subtitle dashboardURL
			end if
		on error
			-- Check if the process died during startup
			try
				do shell script launchScript & " status"
			on error
				-- Server process is gone — startup failed
				set serverState to "idle"
				display dialog "Dashboard failed to start. Check /tmp/vanguard-dashboard.log for details." buttons {"View Log", "OK"} default button "OK" with icon stop with title "Vanguard Dashboard"
				if button returned of result is "View Log" then
					try
						do shell script "open -a TextEdit /tmp/vanguard-dashboard.log"
					end try
				end if
				quit
			end try
		end try
		return 2
	else if serverState is "running" then
		-- Health check every 30 seconds
		try
			do shell script launchScript & " status"
		on error
			set serverState to "idle"
			display notification "Dashboard server stopped unexpectedly" with title "Vanguard Dashboard" subtitle "Relaunch the app to restart"
			quit
		end try
		return 30
	end if
	return 5
end idle
