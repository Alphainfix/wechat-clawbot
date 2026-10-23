// Clawbot-Calendar: the WeChat bot's bridge to the macOS Calendar (EventKit)
// and to Reminders, for alarms (ReminderKit).
//
// The plugin builds this file into Clawbot-Calendar.app and launches it through
// LaunchServices (`open -W -n -g -a … --args --request <file> --response <file>`),
// so macOS treats the app as its own "responsible process": the calendar and
// reminders permission prompts name this app, and the grants do not depend on
// whatever started DSH (a menu-bar app, a terminal). Each launch handles one
// request and exits.
//
// Request (JSON file): { "cmd": "...", "timeZone": "America/New_York", "deadline": <epoch ms>, ... }
// Response (JSON file): { "ok": true, ... } or { "ok": false, "error": "...", "code": "..." }
//
// Commands
//   status                     both authorization states, whether alarms can work here, the protocol; no prompt
//   request                    ask for full access to the calendar, then to reminders (each prompt once;
//                              `calendar` / `reminders`: false skips one)
//   calendars                  every event calendar with its account
//   events                     occurrences in [from, to), recurring ones expanded
//   ensureCalendar             the dedicated calendar: a known id, an adopted one, or a new one
//   add                        add one event (and report what it overlaps)
//   update / delete            change or remove one occurrence (or the series from it on)
//   ensureAlarmList            the reminders list alarms go into: a known id, one of that name, or a new one
//   alarmAdd                   one alarm: an urgent reminder at a time of day
//   alarms                     the reminders in the alarm list
//   alarmDelete                remove one alarm
//   alarmComplete              mark alarms done (ones that rang hours ago, so they do not pile up as overdue)
//   rkcheck                    which ReminderKit pieces this macOS lacks (no permission needed)
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
    out["alertMinutes"] = alarms.compactMap { $0.absoluteDate == nil ? alertMinutes($0) : nil }
  }
  return out
}

/// An alert's minutes before the start; nil for one no calendar app would set
/// (Int() would trap on an absurd offset from some calendar server).
func alertMinutes(_ alarm: EKAlarm) -> Int? {
  let minutes = -alarm.relativeOffset / 60
  return minutes.isFinite && abs(minutes) < 1e9 ? Int(minutes) : nil
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

// MARK: - Alarms: urgent reminders through ReminderKit
//
// An alarm is an urgent reminder: Reminders rings it like an alarm on the
// owner's devices (macOS and iOS 26 and later), and iCloud carries it to the
// phone, so it rings even when WeChat could not deliver a message. EventKit,
// the public API, has no "urgent", so alarms go through ReminderKit, the
// private framework Reminders.app itself uses: the same remindd, the same
// Reminders permission. Private means any macOS update may change it, so every
// call first checks that the method is still there and fails with
// "reminderkit_missing" instead of crashing; `rkcheck` lists what is missing.
//
// Where it rings: only on the device Find My uses as the owner's location
// (usually the iPhone); other devices show a plain notification. And the phone
// has its own say: Reminders there asks to allow urgent alarms only the first
// time someone marks a reminder urgent there by hand.
//
// Protocol 2 = this file has the alarm commands; 3 = also alarmComplete, and
// `status` says whether alarms can work on this macOS. The plugin reads it
// from `status` and tells an older build apart without asking it anything new.
// Every change to this file bumps it (a regression test holds the two together).
let helperProtocol = 3

func remindersAuthorization() -> String {
  switch EKEventStore.authorizationStatus(for: .reminder) {
  case .notDetermined: return "notDetermined"
  case .restricted: return "restricted"
  case .denied: return "denied"
  case .fullAccess: return "fullAccess"
  case .writeOnly: return "writeOnly"
  @unknown default: return "unknown"
  }
}

func requireRemindersAccess() throws {
  let state = remindersAuthorization()
  guard state == "fullAccess" else {
    throw Failure(code: "reminders_not_authorized", message: state)
  }
}

/// Typed calls into ReminderKit through the Objective-C runtime. Its objects keep
/// most fields in a storage object they forward to, so "does it answer" asks both.
enum RK {
  static var loaded = false

  static func load() throws {
    if loaded { return }
    guard let bundle = Bundle(path: "/System/Library/PrivateFrameworks/ReminderKit.framework"), bundle.load() else {
      throw Failure(code: "reminderkit_missing", message: "ReminderKit could not be loaded")
    }
    loaded = true
  }

  static func missing(_ what: String) -> Failure {
    Failure(code: "reminderkit_missing", message: "ReminderKit changed: \(what) is gone")
  }

  static func answers(_ target: NSObject, _ sel: Selector) -> Bool {
    if target.responds(to: sel) { return true }
    if let other = target.forwardingTarget(for: sel) as? NSObject { return other.responds(to: sel) }
    return false
  }

  static func selector(_ target: NSObject, _ name: String) throws -> Selector {
    let sel = NSSelectorFromString(name)
    guard answers(target, sel) else { throw missing("\(type(of: target)).\(name)") }
    return sel
  }

  /// An object-returning method with up to three object arguments. Not owned (+0).
  static func object(_ target: NSObject, _ name: String, _ args: AnyObject?...) throws -> NSObject? {
    let sel = try selector(target, name)
    let imp = target.method(for: sel)
    switch args.count {
    case 0:
      typealias F = @convention(c) (NSObject, Selector) -> Unmanaged<NSObject>?
      return unsafeBitCast(imp, to: F.self)(target, sel)?.takeUnretainedValue()
    case 1:
      typealias F = @convention(c) (NSObject, Selector, AnyObject?) -> Unmanaged<NSObject>?
      return unsafeBitCast(imp, to: F.self)(target, sel, args[0])?.takeUnretainedValue()
    case 2:
      typealias F = @convention(c) (NSObject, Selector, AnyObject?, AnyObject?) -> Unmanaged<NSObject>?
      return unsafeBitCast(imp, to: F.self)(target, sel, args[0], args[1])?.takeUnretainedValue()
    case 3:
      typealias F = @convention(c) (NSObject, Selector, AnyObject?, AnyObject?, AnyObject?) -> Unmanaged<NSObject>?
      return unsafeBitCast(imp, to: F.self)(target, sel, args[0], args[1], args[2])?.takeUnretainedValue()
    default:
      throw Failure(code: "error", message: "too many arguments for \(name)")
    }
  }

  /// A fetch that reports failure through a trailing NSError**.
  static func fetch(_ target: NSObject, _ name: String, _ args: AnyObject?...) throws -> NSObject? {
    let sel = try selector(target, name)
    let imp = target.method(for: sel)
    var error: Unmanaged<NSError>? = nil
    let result: NSObject?
    switch args.count {
    case 0:
      typealias F = @convention(c) (NSObject, Selector, UnsafeMutablePointer<Unmanaged<NSError>?>) -> Unmanaged<NSObject>?
      result = unsafeBitCast(imp, to: F.self)(target, sel, &error)?.takeUnretainedValue()
    case 1:
      typealias F = @convention(c) (NSObject, Selector, AnyObject?, UnsafeMutablePointer<Unmanaged<NSError>?>) -> Unmanaged<NSObject>?
      result = unsafeBitCast(imp, to: F.self)(target, sel, args[0], &error)?.takeUnretainedValue()
    default:
      throw Failure(code: "error", message: "too many arguments for \(name)")
    }
    if result == nil, let e = error?.takeUnretainedValue() {
      throw Failure(code: "reminders_error", message: e.localizedDescription)
    }
    return result
  }

  static func bool(_ target: NSObject, _ name: String) throws -> Bool {
    let sel = try selector(target, name)
    typealias F = @convention(c) (NSObject, Selector) -> Bool
    return unsafeBitCast(target.method(for: sel), to: F.self)(target, sel)
  }

  /// A void method with no argument or one object argument.
  static func perform(_ target: NSObject, _ name: String, _ arg: AnyObject? = nil, hasArgument: Bool = false) throws {
    let sel = try selector(target, name)
    let imp = target.method(for: sel)
    if hasArgument {
      typealias F = @convention(c) (NSObject, Selector, AnyObject?) -> Void
      unsafeBitCast(imp, to: F.self)(target, sel, arg)
    } else {
      typealias F = @convention(c) (NSObject, Selector) -> Void
      unsafeBitCast(imp, to: F.self)(target, sel)
    }
  }

  static func setBool(_ target: NSObject, _ name: String, _ value: Bool) throws {
    let sel = try selector(target, name)
    typealias F = @convention(c) (NSObject, Selector, Bool) -> Void
    unsafeBitCast(target.method(for: sel), to: F.self)(target, sel, value)
  }

  /// `[[ClassName alloc] initName:arg]`, owned by the caller. The init gets its
  /// own reference to consume, so this stays balanced whether it returns the
  /// allocated object or another one.
  static func make(_ className: String, _ initName: String, object arg: AnyObject? = nil, bool flag: Bool? = nil) throws -> NSObject {
    try load()
    guard let cls: AnyClass = NSClassFromString(className), let meta = object_getClass(cls) else { throw missing(className) }
    let allocSel = NSSelectorFromString("alloc")
    typealias Alloc = @convention(c) (AnyClass, Selector) -> Unmanaged<NSObject>?
    guard let allocIMP = class_getMethodImplementation(meta, allocSel),
          let raw = unsafeBitCast(allocIMP, to: Alloc.self)(cls, allocSel)?.takeRetainedValue() else {
      throw missing("\(className) alloc")
    }
    let sel = try selector(raw, initName)
    let imp = raw.method(for: sel)
    _ = Unmanaged.passUnretained(raw).retain()
    let made: NSObject?
    if let flag {
      typealias F = @convention(c) (NSObject, Selector, Bool) -> Unmanaged<NSObject>?
      made = unsafeBitCast(imp, to: F.self)(raw, sel, flag)?.takeRetainedValue()
    } else {
      typealias F = @convention(c) (NSObject, Selector, AnyObject?) -> Unmanaged<NSObject>?
      made = unsafeBitCast(imp, to: F.self)(raw, sel, arg)?.takeRetainedValue()
    }
    guard let made else { throw Failure(code: "reminders_error", message: "\(className) \(initName) returned nil") }
    return made
  }

  static func save(_ request: NSObject) throws {
    let sel = try selector(request, "saveSynchronouslyWithError:")
    typealias F = @convention(c) (NSObject, Selector, UnsafeMutablePointer<Unmanaged<NSError>?>) -> Bool
    var error: Unmanaged<NSError>? = nil
    guard unsafeBitCast(request.method(for: sel), to: F.self)(request, sel, &error) else {
      throw Failure(code: "save_failed", message: error?.takeUnretainedValue().localizedDescription ?? "Reminders did not save")
    }
  }
}

var remindersStore: NSObject? = nil

func reminderStore() throws -> NSObject {
  if let s = remindersStore { return s }
  try requireRemindersAccess()
  let s = try RK.make("REMStore", "initUserInteractive:", bool: true)
  remindersStore = s
  return s
}

func uuidOf(_ object: NSObject?) -> String? {
  guard let object, let oid = try? RK.object(object, "objectID"), let uuid = try? RK.object(oid, "uuid") else { return nil }
  return (uuid as? NSUUID)?.uuidString
}

func text(_ object: NSObject, _ name: String) -> String? {
  ((try? RK.object(object, name)) ?? nil) as? String
}

/// Lists only (groups hold lists and take no reminders).
func reminderLists(_ rem: NSObject) throws -> [NSObject] {
  let lists = (try RK.fetch(rem, "fetchEligibleDefaultListsWithError:") as? [NSObject]) ?? []
  return lists.filter { !((try? RK.bool($0, "isGroup")) ?? false) }
}

func accountName(_ account: NSObject?) -> String {
  guard let account else { return "" }
  return text(account, "name") ?? ""
}

func describeList(_ list: NSObject) -> [String: Any] {
  ["id": uuidOf(list) ?? "", "name": text(list, "name") ?? "", "account": accountName((try? RK.object(list, "account")) ?? nil)]
}

/// Where alarms live: the primary iCloud account, which must support urgent alarms.
func alarmAccount(_ rem: NSObject) throws -> NSObject {
  guard let account = try RK.fetch(rem, "fetchPrimaryActiveCloudKitAccountWithError:") else {
    throw Failure(code: "no_icloud", message: "Reminders has no active iCloud account")
  }
  if let capabilities = try RK.object(account, "capabilities"), try !RK.bool(capabilities, "supportsUrgentAlarm") {
    throw Failure(code: "no_urgent", message: "the iCloud account \(accountName(account)) does not support urgent reminders")
  }
  return account
}

/// The alarm list:
/// - `knownId`: the one used before.
/// - Otherwise a list with exactly this name in the alarm account (the owner
///   made it, or it outlived the record of it): an alarm list is what it is for.
/// - Otherwise a new one in that account.
func ensureAlarmList(_ request: [String: Any]) throws -> [String: Any] {
  guard let name = (request["name"] as? String)?.trimmingCharacters(in: .whitespaces), !name.isEmpty else {
    throw Failure(code: "bad_request", message: "name is missing")
  }
  let rem = try reminderStore()
  let lists = try reminderLists(rem)
  if let known = (request["knownId"] as? String)?.uppercased(), let list = lists.first(where: { uuidOf($0) == known }) {
    return ["ok": true, "list": describeList(list), "created": false]
  }
  let account = try alarmAccount(rem)
  let accountID = uuidOf(account)
  if let same = lists.first(where: { text($0, "name") == name && uuidOf((try? RK.object($0, "account")) ?? nil) == accountID }) {
    return ["ok": true, "list": describeList(same), "created": false, "adopted": true]
  }
  try beforeDeadline()
  let save = try RK.make("REMSaveRequest", "initWithStore:", object: rem)
  guard let accountChange = try RK.object(save, "updateAccount:", account),
        let listChange = try RK.object(save, "addListWithName:toAccountChangeItem:listObjectID:", name as NSString, accountChange, nil),
        let id = uuidOf(listChange) else {
    throw Failure(code: "create_failed", message: "Reminders did not make the list")
  }
  try RK.save(save)
  // Made: a read that fails from here on is not a failure (the next call finds it by name).
  let made = ((try? reminderLists(rem)) ?? []).first { uuidOf($0) == id }
  return ["ok": true, "list": made.map(describeList) ?? ["id": id, "name": name, "account": accountName(account)], "created": true]
}

func alarmList(_ rem: NSObject, _ raw: Any?) throws -> NSObject {
  let id = ((raw as? String) ?? "").uppercased()
  guard let list = try reminderLists(rem).first(where: { uuidOf($0) == id }) else {
    throw Failure(code: "no_list", message: "the alarm list is gone")
  }
  return list
}

func remindersIn(_ rem: NSObject, _ list: NSObject) throws -> [NSObject] {
  guard let listID = try RK.object(list, "objectID") else { throw RK.missing("REMList.objectID") }
  return (try RK.fetch(rem, "fetchRemindersForEventKitBridgingWithListIDs:error:", [listID] as NSArray) as? [NSObject]) ?? []
}

/// A due date as Reminders keeps it (wall clock, maybe with a zone) as an instant.
func instant(_ raw: NSObject?) -> Date? {
  guard var parts = raw as? DateComponents ?? (raw as? NSDateComponents).map({ $0 as DateComponents }) else { return nil }
  var cal = Calendar(identifier: .gregorian)
  cal.timeZone = parts.timeZone ?? zone
  parts.timeZone = nil
  parts.calendar = nil
  return cal.date(from: parts)
}

/// No fallback through urgentAlarmContext: that context only forwards to this
/// same getter, so where the getter is gone it would crash instead of saying no.
func isUrgent(_ reminder: NSObject) -> Bool {
  (try? RK.bool(reminder, "isUrgentStateEnabledForCurrentUser")) ?? false
}

func describeAlarm(_ reminder: NSObject) -> [String: Any] {
  var out: [String: Any] = [
    "id": uuidOf(reminder) ?? "",
    "title": text(reminder, "titleAsString") ?? "",
    "completed": (try? RK.bool(reminder, "isCompleted")) ?? false,
    "urgent": isUrgent(reminder),
  ]
  if let due = instant((try? RK.object(reminder, "dueDateComponents")) ?? nil) { out["due"] = isoString(due) }
  if let notes = text(reminder, "notesAsString"), !notes.isEmpty { out["notes"] = notes }
  return out
}

func addAlarm(_ request: [String: Any]) throws -> [String: Any] {
  // The request is checked before Reminders is opened: that needs no permission.
  guard let title = (request["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty else {
    throw Failure(code: "bad_request", message: "title is missing")
  }
  let due = try parseTime(request["due"], field: "due")
  if due.dateOnly { throw Failure(code: "bad_request", message: "an alarm needs a time of day") }
  if due.date <= Date() { throw Failure(code: "past", message: "that time has already passed") }
  var parts = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: due.date)
  parts.timeZone = zone
  // Reminders keeps a wall clock and a zone. In the hour the clocks go back one
  // wall time names two instants and reads back as the first: refuse the second
  // rather than ring an hour early.
  if let back = instant(parts as NSDateComponents), abs(back.timeIntervalSince(due.date)) > 1 {
    throw Failure(code: "ambiguous", message: "that wall-clock time happens twice (clocks going back); only the first can be set")
  }
  let rem = try reminderStore()
  let list = try alarmList(rem, request["listId"])
  try beforeDeadline()
  let save = try RK.make("REMSaveRequest", "initWithStore:", object: rem)
  guard let listChange = try RK.object(save, "updateList:", list),
        let change = try RK.object(save, "addReminderWithTitle:toListChangeItem:", title as NSString, listChange),
        let id = uuidOf(change) else {
    throw Failure(code: "create_failed", message: "Reminders did not make the alarm")
  }
  // A due time with its default alert, then the urgent state on top of it.
  try RK.perform(change, "setDueDateComponentsWithAlarmsIfNeeded:", parts as NSDateComponents, hasArgument: true)
  if let notes = request["notes"] as? String, !notes.isEmpty {
    try RK.perform(change, "setNotesAsString:", notes as NSString, hasArgument: true)
  }
  guard let urgent = try RK.object(change, "urgentAlarmContext") else { throw RK.missing("urgentAlarmContext") }
  try RK.setBool(urgent, "setIsUrgentStateEnabledForCurrentUser:", true)
  try RK.save(save)
  // What Reminders actually kept, urgent state included. The alarm exists from
  // here on, so a read that fails now is not a failure: reporting one would
  // have the caller set it again, and the owner would get two.
  let saved = ((try? remindersIn(rem, list)) ?? []).first { uuidOf($0) == id }
  return ["ok": true, "alarm": saved.map(describeAlarm) ?? ["id": id, "title": title, "due": isoString(due.date), "urgent": true, "completed": false]]
}

/// Alarms that rang a while ago stay open in Reminders (ringing does not
/// complete them) and would pile up as overdue items: mark them done.
func completeAlarms(_ request: [String: Any]) throws -> [String: Any] {
  let rem = try reminderStore()
  let list = try alarmList(rem, request["listId"])
  let wanted = Set(((request["ids"] as? [Any]) ?? []).compactMap { ($0 as? String)?.uppercased() })
  let open = try remindersIn(rem, list).filter {
    guard let id = uuidOf($0), wanted.contains(id) else { return false }
    return !((try? RK.bool($0, "isCompleted")) ?? false)
  }
  if open.isEmpty { return ["ok": true, "completed": 0] }
  try beforeDeadline()
  let save = try RK.make("REMSaveRequest", "initWithStore:", object: rem)
  for reminder in open {
    guard let change = try RK.object(save, "updateReminder:", reminder) else { throw RK.missing("updateReminder:") }
    try RK.setBool(change, "setCompleted:", true)
  }
  try RK.save(save)
  return ["ok": true, "completed": open.count]
}

func deleteAlarm(_ request: [String: Any]) throws -> [String: Any] {
  let rem = try reminderStore()
  let list = try alarmList(rem, request["listId"])
  let id = ((request["id"] as? String) ?? "").uppercased()
  guard let reminder = try remindersIn(rem, list).first(where: { uuidOf($0) == id }) else {
    throw Failure(code: "no_alarm", message: "that alarm is not in the list any more")
  }
  let gone = describeAlarm(reminder)
  try beforeDeadline()
  let save = try RK.make("REMSaveRequest", "initWithStore:", object: rem)
  guard let change = try RK.object(save, "updateReminder:", reminder) else { throw RK.missing("updateReminder:") }
  try RK.perform(change, "removeFromList")
  try RK.save(save)
  return ["ok": true, "alarm": gone]
}

/// What the alarm commands rely on, checked on the classes alone: no rem, no permission.
func reminderKitCheck() -> [String] {
  guard (try? RK.load()) != nil else { return ["ReminderKit.framework"] }
  let needs: [(String, String)] = [
    ("REMStore", "initUserInteractive:"),
    ("REMStore", "fetchEligibleDefaultListsWithError:"),
    ("REMStore", "fetchPrimaryActiveCloudKitAccountWithError:"),
    ("REMStore", "fetchRemindersForEventKitBridgingWithListIDs:error:"),
    ("REMSaveRequest", "initWithStore:"),
    ("REMSaveRequest", "updateAccount:"),
    ("REMSaveRequest", "updateList:"),
    ("REMSaveRequest", "updateReminder:"),
    ("REMSaveRequest", "addListWithName:toAccountChangeItem:listObjectID:"),
    ("REMSaveRequest", "addReminderWithTitle:toListChangeItem:"),
    ("REMSaveRequest", "saveSynchronouslyWithError:"),
    ("REMAccount", "capabilities"),
    ("REMAccountCapabilities", "supportsUrgentAlarm"),
    ("REMAccountStorage", "name"),
    ("REMListStorage", "name"),
    ("REMListStorage", "objectID"),
    ("REMListStorage", "isGroup"),
    ("REMReminderStorage", "objectID"),
    ("REMReminderStorage", "titleAsString"),
    ("REMReminderStorage", "dueDateComponents"),
    ("REMReminderStorage", "isCompleted"),
    ("REMReminderStorage", "isUrgentStateEnabledForCurrentUser"),
    ("REMReminderStorage", "setIsUrgentStateEnabledForCurrentUser:"),
    ("REMReminderStorage", "notesAsString"),
    ("REMReminderStorage", "setNotesAsString:"),
    ("REMReminderStorage", "setCompleted:"),
    ("REMAccountStorage", "objectID"),
    ("REMReminderChangeItem", "setDueDateComponentsWithAlarmsIfNeeded:"),
    ("REMReminderChangeItem", "setNotesAsString:"),
    ("REMReminderChangeItem", "urgentAlarmContext"),
    ("REMReminderChangeItem", "removeFromList"),
    ("REMReminderChangeItem", "setCompleted:"),
    ("REMList", "account"),
    ("REMReminderUrgentAlarmContextChangeItem", "setIsUrgentStateEnabledForCurrentUser:"),
    ("REMObjectID", "uuid"),
  ]
  return needs.compactMap { cls, sel in
    guard let c: AnyClass = NSClassFromString(cls) else { return cls }
    return class_getInstanceMethod(c, NSSelectorFromString(sel)) == nil ? "\(cls).\(sel)" : nil
  }
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
    let missing = reminderKitCheck()
    var out: [String: Any] = ["ok": true, "authorization": authorization(), "reminders": remindersAuthorization(),
                              "protocol": helperProtocol, "alarms": missing.isEmpty ? "supported" : "unsupported"]
    if !missing.isEmpty { out["missing"] = missing }
    return out

  case "request":
    // Both prompts in one go, while the owner is at the Mac: one for the
    // calendar, then one for reminders (alarms). Each shows only once. No
    // reminders prompt where urgent alarms cannot work: it would ask for nothing.
    let wait = (request["waitSeconds"] as? NSNumber)?.doubleValue ?? 120
    if (request["calendar"] as? Bool ?? true) && authorization() == "notDetermined" {
      var finished = false
      store.requestFullAccessToEvents { _, _ in finished = true }
      _ = waitFor(seconds: wait) { finished }
    }
    if (request["reminders"] as? Bool ?? true) && remindersAuthorization() == "notDetermined" && reminderKitCheck().isEmpty {
      var finished = false
      store.requestFullAccessToReminders { _, _ in finished = true }
      _ = waitFor(seconds: wait) { finished }
    }
    return ["ok": true, "authorization": authorization(), "reminders": remindersAuthorization(), "protocol": helperProtocol]

  case "ensureAlarmList":
    return try ensureAlarmList(request)

  case "alarmAdd":
    return try addAlarm(request)

  case "alarms":
    let rem = try reminderStore()
    let list = try alarmList(rem, request["listId"])
    return ["ok": true, "alarms": try remindersIn(rem, list).map(describeAlarm), "list": describeList(list)]

  case "alarmDelete":
    return try deleteAlarm(request)

  case "alarmComplete":
    return try completeAlarms(request)

  case "rkcheck":
    return ["ok": true, "missing": reminderKitCheck(), "protocol": helperProtocol]

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
        row["alerts"] = (event.alarms ?? []).compactMap(alertMinutes)
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
