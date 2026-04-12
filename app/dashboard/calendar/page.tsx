import { db } from "@/lib/db";
import { getUpcomingEvents } from "@/lib/queries/calendar";
import { getBriefingByWeek } from "@/lib/queries/calendar";
import { getCurrentMonday, addDays } from "@/lib/calendar/date-utils";
import { CalendarView } from "../components/CalendarView";

interface PageProps {
  searchParams: Promise<{ weekOf?: string }>;
}

export default async function CalendarPage({ searchParams }: PageProps) {
  const params = await searchParams;

  // Default to current week's Monday (next week on weekends)
  const weekOf = params.weekOf || getCurrentMonday();

  // Load events for the selected week
  const endDate = addDays(weekOf, 6);
  let events, briefing;
  try {
    events = getUpcomingEvents(db, { startDate: weekOf, endDate });
    // Only show briefing for the viewed week — no fallback to latest
    briefing = getBriefingByWeek(db, weekOf);
  } catch {
    throw new Error("Failed to load calendar data. The database may be unavailable.");
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium text-ink">Calendar</h2>
        <p className="text-sm text-ink-faint mt-0.5">
          Earnings, macro events, and weekly research briefings
        </p>
      </div>

      <CalendarView
        initialEvents={events}
        initialBriefing={briefing}
        initialWeekOf={weekOf}
      />
    </div>
  );
}
