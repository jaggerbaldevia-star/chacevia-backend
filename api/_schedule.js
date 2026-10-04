// api/_schedule.js
//
// Not an API route (leading underscore). The server's copy of the schedule
// math in the Framer component (labelOn / meetsOn / nextMeeting), so the
// reminder dispatcher and the app agree on which classes meet on which day.
// Keep the two in step: same rules, same names.
//
// Dates here are plain "local calendar" values in the student's timezone,
// represented as { y, m, d } or "YYYY-MM-DD" strings. Nothing depends on the
// server's own timezone.

const DOW_LABEL = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const DOW3 = DOW_LABEL.map((s) => s.toLowerCase())

/** Local wall-clock parts of `instant` in `tz`. */
export function localParts(instant, tz) {
    let fmt
    try {
        fmt = new Intl.DateTimeFormat("en-US", {
            timeZone: tz || "UTC",
            year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
        })
    } catch (e) {
        return localParts(instant, "UTC")
    }
    const p = Object.fromEntries(fmt.formatToParts(instant).map((x) => [x.type, x.value]))
    const iso = `${p.year}-${p.month}-${p.day}`
    return { iso, minutes: Number(p.hour) * 60 + Number(p.minute), dow: DOW3.indexOf(String(p.weekday).toLowerCase().slice(0, 3)) }
}

/** "YYYY-MM-DD" → a UTC-noon Date, safe for day arithmetic. */
export function isoToDate(iso) {
    return new Date(iso + "T12:00:00Z")
}
export function dateToIso(d) {
    return d.toISOString().slice(0, 10)
}
export function addDaysIso(iso, n) {
    const d = isoToDate(iso)
    d.setUTCDate(d.getUTCDate() + n)
    return dateToIso(d)
}
export function daysBetween(fromIso, toIso) {
    return Math.round((isoToDate(toIso) - isoToDate(fromIso)) / 86400000)
}

export function rotationSlots(label) {
    const s = String(label || "").toLowerCase()
    const odd = /odd/.test(s)
    const even = /even/.test(s)
    if (odd === even) return null
    const base = odd ? [1, 3, 5, 7] : [2, 4, 6, 8]
    return /rev/.test(s) ? base.slice().reverse() : base
}

export function periodNum(period) {
    const m = String(period == null ? "" : period).match(/\d+/)
    return m ? parseInt(m[0], 10) : null
}

// Same as the app's parseHM: "HH:MM" anywhere in the string, 24-hour.
export function parseHM(raw) {
    const m = String(raw == null ? "" : raw).match(/(\d{1,2}):(\d{2})/)
    if (!m) return null
    const h = parseInt(m[1], 10)
    const mi = parseInt(m[2], 10)
    if (!(h >= 0 && h <= 23 && mi >= 0 && mi <= 59)) return null
    return h * 60 + mi
}

/** The schedule label a local date carries, or null for no school. */
export function labelOn(iso, pattern) {
    const dow = isoToDate(iso).getUTCDay()
    const skip = !pattern || pattern.skip_weekends !== false
    if (skip && (dow === 0 || dow === 6)) return null
    const labels = (pattern && pattern.cycle_labels) || []
    const idx0 =
        pattern && pattern.anchor_date && pattern.anchor_label ? labels.indexOf(pattern.anchor_label) : -1
    if (idx0 === -1) return DOW_LABEL[dow]
    if (iso < pattern.anchor_date) return null
    let steps = 0
    let cur = pattern.anchor_date
    while (cur < iso) {
        cur = addDaysIso(cur, 1)
        const w = isoToDate(cur).getUTCDay()
        if (skip && (w === 0 || w === 6)) continue
        steps++
    }
    return labels[(idx0 + steps) % labels.length]
}

function sameDayLabel(a, b) {
    const x = String(a || "").trim().toLowerCase()
    const y = String(b || "").trim().toLowerCase()
    if (x === y) return true
    if (x.length < 3 || y.length < 3) return false
    const i = DOW3.indexOf(x.slice(0, 3))
    return i !== -1 && i === DOW3.indexOf(y.slice(0, 3))
}

export function meetsOn(cls, label) {
    if (!cls || !label) return false
    const slots = rotationSlots(label)
    if (slots) {
        const n = periodNum(cls.period)
        return n != null && slots.indexOf(n) !== -1
    }
    return (cls.days || []).some((d) => sameDayLabel(d, label))
}

/** Today's classes in meeting order, with the bell times that apply today. */
export function classesOn(iso, classes, pattern) {
    const label = labelOn(iso, pattern)
    if (!label) return []
    const slots = rotationSlots(label)
    if (slots) {
        const byPeriod = {}
        classes.forEach((c) => {
            const n = periodNum(c.period)
            if (n && !byPeriod[n]) byPeriod[n] = c
        })
        const fwd = slots.slice().sort((a, b) => a - b)
        return slots
            .map((p, i) => ({
                cls: byPeriod[p] || null,
                start: byPeriod[fwd[i]] ? parseHM(byPeriod[fwd[i]].start_time) : null,
                end: byPeriod[fwd[i]] ? parseHM(byPeriod[fwd[i]].end_time) : null,
            }))
            .filter((r) => r.cls && r.start != null)
    }
    return classes
        .filter((c) => meetsOn(c, label))
        .map((c) => ({ cls: c, start: parseHM(c.start_time), end: parseHM(c.end_time) }))
        .filter((r) => r.start != null)
        .sort((a, b) => a.start - b.start)
}

/** When a class lets out: its end time, or 50 minutes after it starts. */
export function endOf(row) {
    return row.end != null ? row.end : row.start + 50
}

export { DOW_LABEL }
