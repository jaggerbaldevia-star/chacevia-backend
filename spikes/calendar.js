// api/calendar.js
//
// SPIKE — not production-hardened, timeboxed.
//
// GET endpoint that serves a live iCalendar (.ics) feed of one user's
// homework reminders, so they can "Add Subscription Calendar" on iPhone
// and get native lock-screen alerts without the app.
//
// Auth: NOT a Supabase session (Apple's Calendar app can't send one).
// Instead each user gets an opaque random token (public.calendar_tokens),
// passed as ?token=... in the subscribe URL. The token is unguessable
// and is never the user's real Supabase id — see the SQL this ships with.
//
// GET /api/calendar?token=<opaque token>
//   -> 200 text/calendar with one VEVENT per reminder row
//   -> 400 if token missing, 404 if token doesn't resolve to a user
//
// No writes. Read-only feed. Uses the shared service-role client (svc())
// from _coins.js since there's no user session to authenticate with.

import { svc } from "./_coins.js"

function setCorsHeaders(res) {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type")
}

// ---- iCalendar (RFC 5545) helpers --------------------------------

// Escape TEXT value special characters: backslash, semicolon, comma, newline.
// Order matters — backslash must be escaped first.
function icsEscapeText(s) {
    return String(s == null ? "" : s)
        .replace(/\\/g, "\\\\")
        .replace(/;/g, "\\;")
        .replace(/,/g, "\\,")
        .replace(/\r\n|\r|\n/g, "\\n")
}

// Fold a single logical ICS line to <=75 octets per physical line, per
// RFC 5545 §3.1: insert CRLF + a single leading SPACE at the fold point.
// Folds are counted in UTF-8 OCTETS, not characters, and must never land
// inside a multi-byte UTF-8 sequence (a continuation byte is 10xxxxxx).
function foldLine(line) {
    const bytes = Buffer.from(line, "utf8")
    if (bytes.length <= 75) return line

    const parts = []
    let start = 0
    let limit = 75 // first line gets the full 75 octets
    while (start < bytes.length) {
        let end = Math.min(start + limit, bytes.length)
        // Don't split a multi-byte UTF-8 character: back off while the next
        // byte is a continuation byte (10xxxxxx, i.e. (b & 0xC0) === 0x80).
        while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--
        parts.push(bytes.slice(start, end).toString("utf8"))
        start = end
        limit = 74 // subsequent lines: 75 minus the 1-octet leading space
    }
    return parts.join("\r\n ")
}

// Build the CRLF-terminated, folded ICS body from an array of logical lines.
function buildIcs(lines) {
    return lines.map((l) => foldLine(l) + "\r\n").join("")
}

// "2026-09-20" - 2 days -> { y, m, d } (pure calendar-date arithmetic, UTC
// so the host's local TZ setting can never shift the day).
function subtractDays(dateStr, days) {
    const [y, m, d] = String(dateStr).split("-").map(Number)
    const dt = new Date(Date.UTC(y, m - 1, d))
    dt.setUTCDate(dt.getUTCDate() - (Number(days) || 0))
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() }
}

const pad2 = (n) => String(n).padStart(2, "0")

// Floating local date-time (no Z, no TZID) — see README note on timezones
// below. Format required by RFC 5545: YYYYMMDDTHHMMSS
function floatingDateTime(dateStr, daysBefore, timeOfDay) {
    const { y, m, d } = subtractDays(dateStr, daysBefore)
    const [hh, mm] = String(timeOfDay || "17:00").split(":").map(Number)
    return `${y}${pad2(m)}${pad2(d)}T${pad2(hh || 0)}${pad2(mm || 0)}00`
}

// UTC timestamp for DTSTAMP/CREATED: YYYYMMDDTHHMMSSZ
function utcStamp(d = new Date()) {
    return (
        d.getUTCFullYear() +
        pad2(d.getUTCMonth() + 1) +
        pad2(d.getUTCDate()) +
        "T" +
        pad2(d.getUTCHours()) +
        pad2(d.getUTCMinutes()) +
        pad2(d.getUTCSeconds()) +
        "Z"
    )
}

function reminderToVEvent(r) {
    const dtstart = floatingDateTime(r.due_date, r.days_before, r.time_of_day)
    const summary = r.message || `"${r.assignment_title}" is due`
    const descParts = []
    if (r.class_name) descParts.push("Class: " + r.class_name)
    descParts.push('Assignment: "' + r.assignment_title + '"')
    if (r.due_date) descParts.push("Due: " + r.due_date)
    const description = descParts.join("\n")

    return [
        "BEGIN:VEVENT",
        "UID:" + r.id + "@chacevia.app",
        "DTSTAMP:" + utcStamp(),
        "DTSTART:" + dtstart,
        "SUMMARY:" + icsEscapeText(summary),
        "DESCRIPTION:" + icsEscapeText(description),
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        "TRIGGER:PT0S",
        "DESCRIPTION:" + icsEscapeText(summary),
        "END:VALARM",
        "END:VEVENT",
    ]
}

export default async function handler(req, res) {
    setCorsHeaders(res)
    if (req.method === "OPTIONS") return res.status(204).end()
    if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed. Use GET." })

    const token = req.query && req.query.token
    if (!token || typeof token !== "string") {
        return res.status(400).json({ error: "Missing ?token=" })
    }
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        return res.status(500).json({ error: "Server is missing Supabase configuration." })
    }

    try {
        const { data: tok, error: tokErr } = await svc()
            .from("calendar_tokens")
            .select("user_id")
            .eq("token", token)
            .maybeSingle()
        if (tokErr || !tok) return res.status(404).json({ error: "Unknown calendar token." })

        const { data: reminders, error: remErr } = await svc()
            .from("reminders")
            .select("id, days_before, time_of_day, message, assignments(title, due_date, classes(name))")
            .eq("user_id", tok.user_id)
        if (remErr) throw remErr

        const rows = (reminders || [])
            .filter((r) => r.assignments && r.assignments.due_date) // need a due_date to fire against
            .map((r) => ({
                id: r.id,
                days_before: r.days_before,
                time_of_day: r.time_of_day,
                message: r.message,
                assignment_title: r.assignments.title,
                due_date: r.assignments.due_date,
                class_name: r.assignments.classes ? r.assignments.classes.name : null,
            }))

        const lines = [
            "BEGIN:VCALENDAR",
            "VERSION:2.0",
            "PRODID:-//Chacevia//Reminders//EN",
            "CALSCALE:GREGORIAN",
            "X-WR-CALNAME:" + icsEscapeText("Chacevia Reminders"),
            ...rows.flatMap(reminderToVEvent),
            "END:VCALENDAR",
        ]

        res.setHeader("Content-Type", "text/calendar; charset=utf-8")
        res.status(200).send(buildIcs(lines))
    } catch (err) {
        console.error("calendar feed error:", err)
        return res.status(500).json({ error: "Couldn't build the calendar feed." })
    }
}
