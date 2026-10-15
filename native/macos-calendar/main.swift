// Clawbot-Calendar: the WeChat bot's bridge to the macOS Calendar (EventKit).
//
// The plugin builds this file into Clawbot-Calendar.app and launches it through
// LaunchServices (`open -W -n -g -a … --args --request <file> --response <file>`),
// so macOS treats the app as its own "responsible process": the calendar
// permission prompt names this app, and the grant does not depend on whatever
// started DSH (a menu-bar app, a terminal). Each launch handles one request and
// exits.
//
// Request (JSON file): { "cmd": "...", "timeZone": "America/New_York", "deadline": <epoch ms>, ... }
// Response (JSON file): { "ok": true, ... } or { "ok": false, "error": "...", "code": "..." }
//
// Commands
//   status                     authorization state, no prompt
//   request                    ask for full access (shows the system prompt once)
//   calendars                  every event calendar with its account
//   events                     occurrences in [from, to), recurring ones expanded
//   ensureCalendar             the dedicated calendar: a known id, an adopted one, or a new one
//   add                        add one event (and report what it overlaps)
//   update / delete            change or remove one occurrence (or the series from it on)
//
// Times in: "2026-10-15T14:00" (local wall clock in timeZone), "2026-10-15"
// (a date), or ISO 8601 with an offset. Times out: ISO 8601 with offset.
//
// All-day events follow EventKit's own rule: the end is the LAST day, inclusive
// (EventKit stores 23:59:59 of that day). Passing the next midnight, the usual
// exclusive convention, makes a one-day event two days long.

import EventKit
import Foundation

// MARK: - I/O

struct Failure: Error {
  let code: String
  let message: String
}

func argument(_ name: String) -> String? {
  let args = CommandLine.arguments
  guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
  return args[i + 1]
}

let responseLock = NSLock()
var responded = false

/// Write the one response this launch gives, then never again (a watchdog may race the real answer).
func respond(_ object: [String: Any], to path: String) {
  responseLock.lock()
  defer { responseLock.unlock() }
  guard !responded else { return }
  responded = true
  let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]))
    ?? Data("{\"ok\":false,\"code\":\"error\",\"error\":\"unencodable response\"}".utf8)
  let url = URL(fileURLWithPath: path)
  try? data.write(to: url, options: .atomic)
  // Only the owner may read what the calendar said.
  try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
}

// MARK: - Time

var zone = TimeZone.current
var calendar: Calendar {
  var c = Calendar(identifier: .gregorian)
  c.timeZone = zone
  return c
}

/// Past this instant nothing is written: the caller has given up and told the model so.
var deadline: Date? = nil

func beforeDeadline() throws {
  if let d = deadline, Date() >= d {
    throw Failure(code: "deadline", message: "took too long; nothing was changed")
  }
}

func localFormatter(_ format: String) -> DateFormatter {
  let f = DateFormatter()
  f.locale = Locale(identifier: "en_US_POSIX")
  f.calendar = calendar
  f.timeZone = zone
  f.dateFormat = format
  f.isLenient = false
  return f
}

/// Reject 2026-09-31, 2026-02-30, 25:00 instead of rolling them over to another day.
func checkFields(_ text: String, field: String) throws {
  let pattern = #"^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?"#
  guard let re = try? NSRegularExpression(pattern: pattern),
        let m = re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) else { return }
  func int(_ i: Int) -> Int? {
    guard let r = Range(m.range(at: i), in: text) else { return nil }
    return Int(text[r])
  }
  var parts = DateComponents()
  parts.year = int(1)
  parts.month = int(2)
  parts.day = int(3)
  let hour = int(4) ?? 0, minute = int(5) ?? 0, second = int(6) ?? 0
  if !parts.isValidDate(in: Calendar(identifier: .gregorian)) || hour > 23 || minute > 59 || second > 59 {
    throw Failure(code: "bad_request", message: "\(field) is not a real date or time: \(text)")
  }
}

/// A parsed time, and whether it named only a date.
func parseTime(_ raw: Any?, field: String) throws -> (date: Date, dateOnly: Bool) {
  guard let text = (raw as? String)?.trimmingCharacters(in: .whitespaces), !text.isEmpty else {
    throw Failure(code: "bad_request", message: "\(field) is missing")
  }
  try checkFields(text, field: field)
  let iso = ISO8601DateFormatter()
  iso.formatOptions = [.withInternetDateTime]
  if let d = iso.date(from: text) { return (d, false) }
  iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  if let d = iso.date(from: text) { return (d, false) }
  let normalized = text.replacingOccurrences(of: " ", with: "T")
  for format in ["yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm"] {
    if let d = localFormatter(format).date(from: normalized) { return (d, false) }
  }
  if let d = localFormatter("yyyy-MM-dd").date(from: text) { return (d, true) }
  throw Failure(code: "bad_request", message: "\(field) is not a time: \(text)")
}

func isoString(_ date: Date) -> String {
  let f = ISO8601DateFormatter()
  f.formatOptions = [.withInternetDateTime]
  f.timeZone = zone
  return f.string(from: date)
}

/// `day` at the clock time of `clock` (both in the owner's zone).
func combine(day: Date, clock: Date) -> Date {
  let t = calendar.dateComponents([.hour, .minute, .second], from: clock)
  return calendar.date(bySettingHour: t.hour ?? 0, minute: t.minute ?? 0, second: t.second ?? 0, of: day) ?? day
}

// MARK: - EventKit helpers

let store = EKEventStore()

func authorization() -> String {
  switch EKEventStore.authorizationStatus(for: .event) {
  case .notDetermined: return "notDetermined"
  case .restricted: return "restricted"
  case .denied: return "denied"
  case .fullAccess: return "fullAccess"
  case .writeOnly: return "writeOnly"
  @unknown default: return "unknown"
  }
}

func requireFullAccess() throws {
  let state = authorization()
  guard state == "fullAccess" else {
    throw Failure(code: "not_authorized", message: state)
  }
}

/// Wait for an async EventKit callback without a UI run loop of our own.
func waitFor(seconds: TimeInterval, _ done: () -> Bool) -> Bool {
  let until = Date().addingTimeInterval(seconds)
  while !done() && Date() < until {
    RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
  }
  return done()
}

func sourceType(_ type: EKSourceType) -> String {
  switch type {
  case .local: return "local"
  case .exchange: return "exchange"
  case .calDAV: return "caldav"
  case .mobileMe: return "mobileme"
  case .subscribed: return "subscribed"
  case .birthdays: return "birthdays"
  @unknown default: return "other"
  }
}

func describe(_ calendar: EKCalendar) -> [String: Any] {
  [
    "id": calendar.calendarIdentifier,
    "title": calendar.title,
    "account": calendar.source?.title ?? "",
    "accountType": calendar.source.map { sourceType($0.sourceType) } ?? "",
    "writable": calendar.allowsContentModifications,
  ]
}

func eventCalendars() -> [EKCalendar] {
  store.calendars(for: .event)
}

func calendar(id: String) throws -> EKCalendar {
  guard let cal = store.calendar(withIdentifier: id) else {
    throw Failure(code: "no_calendar", message: "calendar \(id) not found")
  }
  return cal
}

func describe(_ event: EKEvent) -> [String: Any] {
  var out: [String: Any] = [
    "id": event.eventIdentifier ?? "",
    "calendarId": event.calendar?.calendarIdentifier ?? "",
    "calendar": event.calendar?.title ?? "",
    "account": event.calendar?.source?.title ?? "",
    "title": event.title ?? "",
    "start": isoString(event.startDate),
    "end": isoString(event.endDate),
    "allDay": event.isAllDay,
    "recurring": event.hasRecurrenceRules,
  ]
  if let location = event.location, !location.isEmpty { out["location"] = location }
  if let notes = event.notes, !notes.isEmpty { out["notes"] = notes }
  if let url = event.url { out["url"] = url.absoluteString }
  if let occurrence = event.occurrenceDate { out["occurrence"] = isoString(occurrence) }
  if let attendees = event.attendees, !attendees.isEmpty {
    out["attendees"] = attendees.count
    out["organizerIsMe"] = event.organizer?.isCurrentUser ?? false
  }
  if let alarms = event.alarms, !alarms.isEmpty {
    out["alertMinutes"] = alarms.compactMap { $0.absoluteDate == nil ? Int(-$0.relativeOffset / 60) : nil }
  }
  return out
}

/// One occurrence by its event id. Recurring occurrences share an id, so the
/// caller also gives the occurrence's ORIGINAL date (it never changes, even when
/// that occurrence was moved) and its current start; both are searched.
func occurrence(id: String, original raw: Any?, current rawCurrent: Any?) throws -> EKEvent {
  guard let master = store.event(withIdentifier: id) else {
    throw Failure(code: "no_event", message: "event not found (it may have been deleted)")
  }
  guard master.hasRecurrenceRules, raw != nil else { return master }
  let original = try parseTime(raw, field: "occurrence").date
  let current = rawCurrent == nil ? original : try parseTime(rawCurrent, field: "start").date
  let from = min(original, current).addingTimeInterval(-86_400)
  let to = max(original, current).addingTimeInterval(86_400)
  let predicate = store.predicateForEvents(withStart: from, end: to, calendars: [master.calendar])
  let match = store.events(matching: predicate).first {
    $0.eventIdentifier == id && abs(($0.occurrenceDate ?? $0.startDate).timeIntervalSince(original)) < 60
  }
  guard let found = match else {
    throw Failure(code: "no_event", message: "that occurrence is not in the calendar any more")
  }
  return found
}

/// Events in a window that overlap [start, end), apart from `except`.
func overlaps(_ start: Date, _ end: Date, except: String?) -> [[String: Any]] {
  let predicate = store.predicateForEvents(withStart: start, end: end, calendars: nil)
  return store.events(matching: predicate)
    .filter { !$0.isAllDay && $0.eventIdentifier != except && $0.startDate < end && $0.endDate > start }
    .prefix(10)
    .map { ["title": $0.title ?? "", "calendar": $0.calendar?.title ?? "", "start": isoString($0.startDate), "end": isoString($0.endDate)] }
}

/// Apply the requested fields. On update an event keeps being all-day or timed
/// unless `allDay` says otherwise, and a date-only start moves a timed event to
/// that day at its own time.
func applyFields(_ event: EKEvent, _ request: [String: Any], creating: Bool) throws {
  if let title = request["title"] as? String { event.title = title }
  if let location = request["location"] as? String { event.location = location.isEmpty ? nil : location }
  if let notes = request["notes"] as? String { event.notes = notes.isEmpty ? nil : notes }
  if let more = request["addNotes"] as? String, !more.isEmpty {
    let existing = event.notes ?? ""
    event.notes = existing.isEmpty ? more : "\(existing)\n\(more)"
  }
  if let url = request["url"] as? String { event.url = url.isEmpty ? nil : URL(string: url) }

  let allDayAsked = request["allDay"] as? Bool
  let hasStart = request["start"] != nil
  let hasEnd = request["end"] != nil
  if hasStart || hasEnd || allDayAsked != nil {
    let parsedStart = hasStart ? try parseTime(request["start"], field: "start") : nil
    let wholeDay: Bool = creating
      ? (allDayAsked ?? parsedStart?.dateOnly ?? false)
      : (allDayAsked ?? event.isAllDay)
    let parsedEnd = hasEnd ? try parseTime(request["end"], field: "end") : nil

    if wholeDay {
      // Days, inclusive: EventKit's rule for all-day events.
      let oldFirst = calendar.startOfDay(for: event.startDate ?? Date())
      let oldLast = calendar.startOfDay(for: event.endDate ?? Date())
      let first = parsedStart.map { calendar.startOfDay(for: $0.date) } ?? oldFirst
      var last: Date
      if let end = parsedEnd {
        // A date is the last day; a time is an exclusive end (so 10-16 00:00 means through 10-15).
        last = calendar.startOfDay(for: end.dateOnly ? end.date : end.date.addingTimeInterval(-1))
      } else if creating || !event.isAllDay {
        last = first
      } else {
        let days = calendar.dateComponents([.day], from: oldFirst, to: oldLast).day ?? 0
        last = calendar.date(byAdding: .day, value: days, to: first) ?? first
      }
      if last < first { throw Failure(code: "bad_request", message: "the last day is before the first") }
      event.isAllDay = true
      event.startDate = first
      event.endDate = last
    } else {
      var start: Date
      if let s = parsedStart {
        // A bare date on a timed event: that day, at the event's own time.
        start = s.dateOnly && !creating && !event.isAllDay ? combine(day: s.date, clock: event.startDate) : s.date
      } else {
        start = event.startDate
      }
      var end: Date
      if let e = parsedEnd {
        end = e.dateOnly && !creating && !event.isAllDay ? combine(day: e.date, clock: event.endDate) : e.date
      } else if creating || event.isAllDay {
        end = start.addingTimeInterval(3_600)
      } else if hasStart {
        end = start.addingTimeInterval(event.endDate.timeIntervalSince(event.startDate))
      } else {
        end = event.endDate
      }
      if end <= start { throw Failure(code: "bad_request", message: "the end must be after the start") }
      event.isAllDay = false
      event.startDate = start
      event.endDate = end
    }
  }
  if let minutes = request["alertMinutes"] as? [Any] {
    for alarm in event.alarms ?? [] { event.removeAlarm(alarm) }
    for value in minutes {
      if let m = (value as? NSNumber)?.doubleValue, m >= 0 { event.addAlarm(EKAlarm(relativeOffset: -m * 60)) }
    }
  }
}

func span(_ request: [String: Any]) -> EKSpan {
  (request["span"] as? String) == "future" ? .futureEvents : .thisEvent
}

/// The dedicated calendar.
/// - `knownId`: the one this plugin created or the owner approved before.
/// - `adoptId`: an existing calendar with that title the owner just approved.
/// - Otherwise a writable calendar with the same title is NOT taken silently
///   (it may be shared, or the owner's real "Work"): it comes back as
///   `name_taken` so the owner can be asked. If none exists, a new one is made,
///   iCloud first so it reaches the phone (Google refuses new calendars over
///   CalDAV; a default in a work Exchange account is not where private planning
///   belongs).
func ensureCalendar(_ request: [String: Any]) throws -> [String: Any] {
  guard let name = (request["name"] as? String)?.trimmingCharacters(in: .whitespaces), !name.isEmpty else {
    throw Failure(code: "bad_request", message: "name is missing")
  }
  if let known = request["knownId"] as? String, let cal = store.calendar(withIdentifier: known), cal.allowsContentModifications {
    return ["ok": true, "calendar": describe(cal), "created": false]
  }
  if let adopt = request["adoptId"] as? String {
    guard let cal = store.calendar(withIdentifier: adopt), cal.allowsContentModifications, cal.title == name else {
      throw Failure(code: "no_calendar", message: "that calendar is gone or read-only")
    }
    return ["ok": true, "calendar": describe(cal), "created": false]
  }
  let same = eventCalendars().filter { $0.title == name && $0.allowsContentModifications }
  if !same.isEmpty {
    return ["ok": false, "code": "name_taken", "error": "a writable calendar named \(name) already exists",
            "calendars": same.map(describe)]
  }
  try beforeDeadline()
  var sources: [EKSource] = []
  sources += store.sources.filter { $0.sourceType == .calDAV && $0.title.lowercased().contains("icloud") }
  if let preferred = store.defaultCalendarForNewEvents?.source { sources.append(preferred) }
  sources += store.sources.filter { $0.sourceType == .calDAV || $0.sourceType == .exchange }
  sources += store.sources.filter { $0.sourceType == .local }
  var seen = Set<String>()
  var lastError = "no account accepts new calendars"
  for source in sources where seen.insert(source.sourceIdentifier).inserted {
    let cal = EKCalendar(for: .event, eventStore: store)
    cal.title = name
    cal.source = source
    do {
      try store.saveCalendar(cal, commit: true)
      return ["ok": true, "calendar": describe(cal), "created": true]
    } catch {
      lastError = "\(source.title): \(error.localizedDescription)"
    }
  }
  throw Failure(code: "create_failed", message: lastError)
}

/// The occurrence an update or delete names, in the calendar the caller saw it in.
func target(_ request: [String: Any]) throws -> EKEvent {
  let event = try occurrence(id: request["eventId"] as? String ?? "", original: request["occurrence"], current: request["currentStart"])
  if let expected = request["expectCalendarId"] as? String, expected != event.calendar.calendarIdentifier {
    throw Failure(code: "calendar_changed", message: event.calendar.title)
  }
  guard event.calendar.allowsContentModifications else {
    throw Failure(code: "read_only", message: "calendar \(event.calendar.title) is read-only")
  }
  return event
}

// MARK: - Commands

func handle(_ request: [String: Any]) throws -> [String: Any] {
  if let id = request["timeZone"] as? String, let tz = TimeZone(identifier: id) {
    zone = tz
    // EventKit floats all-day dates in the process's default zone: keep it the same.
    NSTimeZone.default = tz
  }
  let cmd = request["cmd"] as? String ?? ""
  switch cmd {
  case "status":
    return ["ok": true, "authorization": authorization()]

  case "request":
    if authorization() == "notDetermined" {
      var finished = false
      store.requestFullAccessToEvents { _, _ in finished = true }
      let wait = (request["waitSeconds"] as? NSNumber)?.doubleValue ?? 120
      _ = waitFor(seconds: wait) { finished }
    }
    return ["ok": true, "authorization": authorization()]

  case "calendars":
    try requireFullAccess()
    return ["ok": true, "calendars": eventCalendars().map(describe)]

  case "events":
    try requireFullAccess()
    let from = try parseTime(request["from"], field: "from").date
    let to = try parseTime(request["to"], field: "to").date
    guard to > from else { throw Failure(code: "bad_request", message: "to must be after from") }
    // 92 calendar days, with room for a daylight-saving hour.
    guard to.timeIntervalSince(from) <= 92 * 86_400 + 3_600 else {
      throw Failure(code: "bad_request", message: "at most 92 days at a time")
    }
    let predicate = store.predicateForEvents(withStart: from, end: to, calendars: nil)
    let events = store.events(matching: predicate).sorted { $0.startDate < $1.startDate }
    return ["ok": true, "events": events.map(describe), "calendars": eventCalendars().map(describe)]

  case "ensureCalendar":
    try requireFullAccess()
    return try ensureCalendar(request)

  case "add":
    try requireFullAccess()
    let cal = try calendar(id: request["calendarId"] as? String ?? "")
    guard cal.allowsContentModifications else {
      throw Failure(code: "read_only", message: "calendar \(cal.title) is read-only")
    }
    guard let title = request["title"] as? String, !title.isEmpty else {
      throw Failure(code: "bad_request", message: "title is missing")
    }
    let event = EKEvent(eventStore: store)
    event.calendar = cal
    try applyFields(event, request, creating: true)
    try beforeDeadline()
    try store.save(event, span: .thisEvent, commit: true)
    return ["ok": true, "event": describe(event),
            "overlaps": overlaps(event.startDate, event.endDate, except: event.eventIdentifier)]

  case "update":
    try requireFullAccess()
    let event = try target(request)
    if let moveTo = request["calendarId"] as? String, moveTo != event.calendar.calendarIdentifier {
      let moved = try calendar(id: moveTo)
      guard moved.allowsContentModifications else {
        throw Failure(code: "read_only", message: "calendar \(moved.title) is read-only")
      }
      event.calendar = moved
    }
    try applyFields(event, request, creating: false)
    try beforeDeadline()
    try store.save(event, span: span(request), commit: true)
    return ["ok": true, "event": describe(event),
            "overlaps": overlaps(event.startDate, event.endDate, except: event.eventIdentifier)]

  case "delete":
    try requireFullAccess()
    let event = try target(request)
    let gone = describe(event)
    try beforeDeadline()
    try store.remove(event, span: span(request), commit: true)
    return ["ok": true, "event": gone]

  case "selftest":
    // Runs applyFields on events that are never saved: needs no permission and
    // touches no calendar. Lets the tests check EventKit's real date rules
    // (all-day ends are inclusive) instead of a fake's.
    var results: [[String: Any]] = []
    for c in (request["cases"] as? [[String: Any]]) ?? [] {
      let event = EKEvent(eventStore: store)
      var row: [String: Any] = ["name": c["name"] as? String ?? ""]
      do {
        if let setup = c["setup"] as? [String: Any] { try applyFields(event, setup, creating: true) }
        try applyFields(event, c["fields"] as? [String: Any] ?? [:], creating: c["setup"] == nil)
        row["start"] = isoString(event.startDate)
        row["end"] = isoString(event.endDate)
        row["allDay"] = event.isAllDay
        row["alerts"] = (event.alarms ?? []).map { Int(-$0.relativeOffset / 60) }
        if let notes = event.notes { row["notes"] = notes }
      } catch let f as Failure {
        row["error"] = f.code
      }
      results.append(row)
    }
    return ["ok": true, "results": results]

  default:
    throw Failure(code: "bad_request", message: "unknown command \(cmd)")
  }
}

// MARK: - Main

guard let requestPath = argument("--request"), let responsePath = argument("--response") else {
  FileHandle.standardError.write(Data("usage: Clawbot-Calendar --request <file> --response <file>\n".utf8))
  exit(2)
}
do {
  let data = try Data(contentsOf: URL(fileURLWithPath: requestPath))
  guard let request = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
    throw Failure(code: "bad_request", message: "request is not a JSON object")
  }
  if let ms = (request["deadline"] as? NSNumber)?.doubleValue {
    let at = Date(timeIntervalSince1970: ms / 1000)
    deadline = at
    // Answer before the caller stops waiting, even if EventKit hangs: a write
    // that lands after the caller gave up would be reported as a failure.
    let wait = max(0.5, at.timeIntervalSinceNow)
    DispatchQueue.global().asyncAfter(deadline: .now() + wait) {
      // Unlike a refusal before committing ("deadline"), this one cannot know
      // whether a save already in progress went through.
      respond(["ok": false, "code": "timeout", "error": "took too long; a change may or may not have been saved"], to: responsePath)
      exit(0)
    }
  }
  respond(try handle(request), to: responsePath)
} catch let failure as Failure {
  respond(["ok": false, "code": failure.code, "error": failure.message], to: responsePath)
} catch {
  respond(["ok": false, "code": "error", "error": error.localizedDescription], to: responsePath)
}
exit(0)
