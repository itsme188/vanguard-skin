import EventKit
import Foundation

// Usage: read-calendar "<Calendar Name>" YYYY-MM-DD YYYY-MM-DD
// Prints JSON array of events to stdout.

let args = CommandLine.arguments
guard args.count >= 4 else {
    FileHandle.standardError.write(
        "Usage: read-calendar <calendarName> <startDate> <endDate>\n".data(using: .utf8)!
    )
    exit(2)
}

let calendarName = args[1]
let startStr = args[2]
let endStr = args[3]

let df = DateFormatter()
df.dateFormat = "yyyy-MM-dd"
df.timeZone = TimeZone.current

guard let start = df.date(from: startStr),
      let endDay = df.date(from: endStr) else {
    FileHandle.standardError.write("Invalid date format. Use YYYY-MM-DD.\n".data(using: .utf8)!)
    exit(2)
}

let end = Calendar.current.date(byAdding: .day, value: 1, to: endDay)!
    .addingTimeInterval(-1)

let store = EKEventStore()
let semaphore = DispatchSemaphore(value: 0)
var authorized = false
var authErr: Error?

if #available(macOS 14.0, *) {
    store.requestFullAccessToEvents { granted, error in
        authorized = granted
        authErr = error
        semaphore.signal()
    }
} else {
    store.requestAccess(to: .event) { granted, error in
        authorized = granted
        authErr = error
        semaphore.signal()
    }
}
semaphore.wait()

guard authorized else {
    let msg = authErr?.localizedDescription ?? "permission not granted"
    FileHandle.standardError.write("Calendar access denied: \(msg)\n".data(using: .utf8)!)
    exit(3)
}

let matching = store.calendars(for: .event).filter { $0.title == calendarName }

// Empty calendar (missing or no events) is a valid, non-error case — print [].
guard !matching.isEmpty else {
    print("[]")
    exit(0)
}

let predicate = store.predicateForEvents(
    withStart: start, end: end, calendars: matching
)
let events = store.events(matching: predicate)

struct OutEvent: Codable {
    let title: String
    let startDate: String
    let endDate: String
    let allDay: Bool
    let notes: String?
    let location: String?
    let calendar: String
}

let iso = ISO8601DateFormatter()
iso.formatOptions = [.withInternetDateTime]

let payload = events.map { e in
    OutEvent(
        title: e.title ?? "",
        startDate: iso.string(from: e.startDate),
        endDate: iso.string(from: e.endDate),
        allDay: e.isAllDay,
        notes: e.notes,
        location: e.location,
        calendar: e.calendar.title
    )
}

let encoder = JSONEncoder()
encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
let data = try encoder.encode(payload)
print(String(data: data, encoding: .utf8)!)
