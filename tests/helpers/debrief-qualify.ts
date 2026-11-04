import type Database from "better-sqlite3";

/**
 * Makes every calendar_events row inserted afterwards clear the debrief's quality bar
 * (2026-11-04): a measured post-print reaction and a bogey sheet with content. For test files
 * whose fixtures predate the bar and are about something else (claims, replacement, twins).
 */
export function installDebriefQualifier(db: Database.Database): void {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS test_debrief_qualify AFTER INSERT ON calendar_events
    BEGIN
      UPDATE calendar_events
         SET reaction_snapshot = printf(
           '{"t0_utc":"%sT20:30:00.000Z","window_min":120,"captured_at":"%sT23:59:00.000Z","symbol":{"t_pre":100,"t_post":102,"delta_pct":2}}',
           NEW.event_date, NEW.event_date)
       WHERE id = NEW.id AND reaction_snapshot IS NULL;
      INSERT INTO earnings_bogeys (event_id, source, source_label, eps_consensus, uploaded_at)
        VALUES (NEW.id, 'manual', 'Desk sheet', 1.02, '2026-01-01 12:00:00');
    END;
  `);
}
