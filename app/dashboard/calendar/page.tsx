import { db } from "@/lib/db";
import { getUpcomingEvents } from "@/lib/queries/calendar";
import { getLatestBriefing, getBriefingByWeek } from "@/lib/queries/calendar";
import { CalendarView } from "../components/CalendarView";

interface PageProps {
  searchParams: Promise<{ weekOf?: string }>;
}

export default async function CalendarPage({ searchParams }: PageProps) {
  const params = await searchParams;

  // Default to current week's Monday
  const weekOf = params.weekOf || getCurrentMonday();

  // Load events for the selected week
  const endDate = addDays(weekOf, 6);
  let events, briefing;
  try {
    events = getUpcomingEvents(db, { startDate: weekOf, endDate });
    briefing = getBriefingByWeek(db, weekOf) ?? getLatestBriefing(db);
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

function getCurrentMonday(): string {
  const now = new Date();
  const day = now.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + diff);
  return monday.toISOString().slice(0, 10);
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
