// api/_paper.js
//
// One student's Morning Paper for one local day. Not an API route.
//
// Everything about their day is computed here from their real classes and due
// work; the model only writes the jokes (front-page headline, its deck, the
// forecast) and never sees anything it could invent from. If the model fails
// or says something it shouldn't, fixed templates take its place, so a paper
// is always complete.

import { svc } from "./_coins.js"
import { ai, withRetry, MODELS } from "./_ai.js"
import { localParts, addDaysIso, classesOn, endOf, isoToDate } from "./_schedule.js"

const DOW = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]
const DAY_FULL = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"]
const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]

const dow = (iso) => isoToDate(iso).getUTCDay()
const clock12 = (min) => `${((Math.floor(min / 60) + 11) % 12) + 1}:${String(min % 60).padStart(2, "0")}`

/** Pure. Everything the paper says about the student's day. */
export function paperFacts({ now, tz, name, signupAt, classes, pattern, rows, yesterday }) {
    const local = localParts(now, tz)
    const today = local.iso
    const d = isoToDate(today)
    const open = rows.filter((r) => !r.done && !r.dropped_at && r.kind !== "event" && r.due_date)
    const className = new Map(classes.map((c) => [c.id, c.short_name || c.name]))
    const due = (iso) => open.filter((r) => r.due_date === iso)

    const todays = classesOn(today, classes, pattern)
    const schedule = todays.map((r) => ({
        label: [r.cls.period, String(r.cls.short_name || r.cls.name || "").toLowerCase()].filter(Boolean).join(" "),
        time: clock12(r.start),
    }))
    const schoolDay = todays.length > 0
    // No classes saved means we don't know whether there's school; only a
    // saved schedule with nothing on today is a day off.
    const hasSchedule = classes.length > 0
    const schoolEnd = schoolDay ? Math.max(...todays.map(endOf)) : null

    const dueToday = due(today)
    const tomorrowIso = addDaysIso(today, 1)
    const dueTomorrow = due(tomorrowIso)
    const late = open.filter((r) => r.due_date < today && r.due_date >= addDaysIso(today, -1))

    // This school week (next week's on a weekend), Monday to Friday.
    const wd = dow(today)
    const monday = addDaysIso(today, wd === 0 ? 1 : wd === 6 ? 2 : 1 - wd)
    const week = [0, 1, 2, 3, 4].map((i) => {
        const iso = addDaysIso(monday, i)
        return { iso, d: DOW[dow(iso)], n: due(iso).length, today: iso === today }
    })
    const maxN = Math.max(...week.map((w) => w.n))
    week.forEach((w) => { w.heavy = maxN > 0 && w.n === maxN })

    // The heaviest day still ahead (today counts), next 7 days.
    let heavy = null
    for (let i = 0; i <= 7; i++) {
        const iso = addDaysIso(today, i)
        const n = due(iso).length
        if (n && (!heavy || n > heavy.n)) heavy = { iso, n, d: DOW[dow(iso)], full: DAY_FULL[dow(iso)] }
    }

    // Free time tonight, roughly: from school's end (or 3pm; 9am on a day off)
    // to 10pm, less half an hour for each thing due today or tomorrow.
    const start = schoolDay ? Math.max(schoolEnd, 15 * 60) : 9 * 60
    const workMin = 30 * (dueToday.length + dueTomorrow.length + late.length)
    const freeMin = Math.max(0, Math.round((22 * 60 - Math.max(start, local.minutes) - workMin) / 30) * 30)
    const load = dueToday.length + dueTomorrow.length + 1.5 * late.length
    const stress = load <= 1 ? "LOW" : load <= 3 ? "MED" : "HIGH"

    const next = open
        .filter((r) => r.due_date >= today)
        .sort((a, b) => (a.due_date + (a.due_at || "")).localeCompare(b.due_date + (b.due_at || "")))
        .slice(0, 3)
        .map((r) => ({ title: String(r.short_title || r.title).toLowerCase(), day: r.due_date === today ? "TODAY" : DOW[dow(r.due_date)] }))

    const issue = signupAt ? Math.max(1, Math.floor((isoToDate(today) - isoToDate(localParts(new Date(signupAt), tz).iso)) / 86400000) + 1) : 1
    const weekEnd = addDaysIso(monday, 4)

    return {
        today,
        name: name || null,
        dayFull: DAY_FULL[wd],
        dateLabel: `${DOW[wd]}, ${MON[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`,
        issue,
        schoolDay,
        hasSchedule,
        schedule,
        firstClass: todays[0] ? { name: String(todays[0].cls.short_name || todays[0].cls.name || "").toLowerCase(), time: clock12(todays[0].start) } : null,
        dueToday: dueToday.map((r) => ({ title: r.short_title || r.title, cls: className.get(r.class_id) || null })),
        dueTomorrow: dueTomorrow.map((r) => ({ title: r.short_title || r.title, cls: className.get(r.class_id) || null })),
        lateCount: late.length,
        week,
        weekLabel: `${MON[isoToDate(monday).getUTCMonth()]} ${isoToDate(monday).getUTCDate()}–${isoToDate(weekEnd).getUTCMonth() === isoToDate(monday).getUTCMonth() ? "" : MON[isoToDate(weekEnd).getUTCMonth()] + " "}${isoToDate(weekEnd).getUTCDate()}`,
        heavy,
        next,
        raw: { homework: dueToday.length, freeMin, stress, heavyIso: heavy ? heavy.iso : null, heavyN: heavy ? heavy.n : 0 },
        yesterday: yesterday || null,
    }
}

const arrow = (now, then, fmt = (x) => String(x)) => {
    if (then == null) return ""
    if (now === then) return "—"
    return (now > then ? "▲ " : "▼ ") + fmt(Math.abs(now - then))
}
const hours = (m) => (m % 60 ? (m / 60).toFixed(1) : String(m / 60)) + "H"
const STRESS_N = { LOW: 0, MED: 1, HIGH: 2 }
const outlook = (n) => (n >= 3 ? "STORMY" : n === 2 ? "CLOUDY" : n === 1 ? "FAIR" : "CLEAR")

/** Pure. "Today's market", with ▲▼ against yesterday's paper when there is one. */
export function marketRows(f) {
    const y = f.yesterday
    const rows = [
        { label: "HOMEWORK", value: String(f.raw.homework), delta: arrow(f.raw.homework, y && y.homework) },
        { label: "FREE TIME", value: hours(f.raw.freeMin), delta: arrow(f.raw.freeMin, y && y.freeMin, hours) },
        { label: "STRESS", value: f.raw.stress, delta: y && y.stress ? (f.raw.stress === y.stress ? "—" : STRESS_N[f.raw.stress] > STRESS_N[y.stress] ? "▲" : "▼") : "" },
    ]
    if (f.heavy) {
        const before = y && y.heavyIso === f.heavy.iso ? y.heavyN : null
        rows.push({ label: `${f.heavy.d} OUTLOOK`, value: outlook(f.heavy.n), delta: arrow(f.heavy.n, before) })
    } else {
        rows.push({ label: "WEEK OUTLOOK", value: "CLEAR", delta: "" })
    }
    return rows
}

/** Pure. The short paragraph under the market, from the facts only. */
export function introText(f) {
    const parts = []
    if (f.firstClass) parts.push(`Your day starts with ${f.firstClass.name} at ${f.firstClass.time}.`)
    else if (f.hasSchedule) parts.push(`No classes today.`)
    if (f.dueToday.length === 1) parts.push(`${f.dueToday[0].title} is due today.`)
    else if (f.dueToday.length > 1) parts.push(`${f.dueToday.length} things are due today, starting with ${f.dueToday[0].title}.`)
    else parts.push(`Nothing is due today.`)
    if (f.dueTomorrow.length) parts.push(`Tomorrow: ${f.dueTomorrow.map((x) => x.title).slice(0, 2).join(" and ")}${f.dueTomorrow.length > 2 ? ` and ${f.dueTomorrow.length - 2} more` : ""}.`)
    return parts.join(" ")
}

/** Pure. The ticker: world headlines plus one line about their week. */
export function tickerLines(f, news) {
    const own = f.hasSchedule && !f.schoolDay && !f.dueToday.length
        ? `YOUR ${f.dayFull}: FREE`
        : f.heavy && f.heavy.n >= 3
            ? `YOUR ${f.heavy.full}: HEAVY`
            : `YOUR ${f.dayFull}: LIGHT`
    return news.map((s) => String(s.ticker || s.headline).toUpperCase()).concat([own])
}

/** Pure. A complete front page with no model at all. */
export function fallbackFront(f) {
    const who = f.name ? `Sources close to ${f.name}` : "Sources"
    if (f.hasSchedule && !f.schoolDay && !f.dueToday.length) {
        return { headline: "LOCAL STUDENT GRANTED ENTIRE DAY OFF", highlight: "ENTIRE", deck: `${who} confirm no classes and nothing due. Experts recommend snacks.`, forecast: forecastText(f) }
    }
    if (!f.dueToday.length) {
        return { headline: "NOTHING DUE TODAY. NATION REJOICES", highlight: "NOTHING", deck: `${who} describe the to-do list as "suspiciously empty."`, forecast: forecastText(f) }
    }
    if (f.dueToday.length === 1) {
        return { headline: "LOCAL STUDENT HAS JUST ONE THING DUE TODAY", highlight: "ONE", deck: `${who} confirm ${f.dueToday[0].title} is the only item on the agenda.`, forecast: forecastText(f) }
    }
    return { headline: `${f.dueToday.length} THINGS DUE TODAY. LOCAL STUDENT UNFAZED`, highlight: String(f.dueToday.length), deck: `${who} say there is a plan. There is always a plan.`, forecast: forecastText(f) }
}

/** Pure. The boxed forecast without a model. */
export function forecastText(f) {
    if (!f.heavy) return "Clear skies all week. Nothing due in the next seven days."
    if (f.heavy.iso === f.today) return `Today is the heavy one: ${f.heavy.n} due. One at a time, smallest first.`
    return `${f.heavy.full[0] + f.heavy.full.slice(1).toLowerCase()} is the heavy one, with ${f.heavy.n} due. Twenty minutes on it tonight makes that day lighter.`
}

// Things the front page must never touch, however it's phrased.
const OFF_LIMITS = /\b(grade\w*|gpa|score\w*|fail\w*|flunk\w*|weight|fat|skinny|thin|body|bodies|looks|ugly|pretty|hot|crush\w*|dating|date night|boyfriend|girlfriend|parent\w*|mom|dad|family|money|broke|sick|ill|illness|depress\w*|anxi\w*|stupid|dumb|idiot|lazy|loser|hate|kill\w*|die|dead|death)\b/i

const WRITER = `You write the front page of a teenager's personal tabloid newspaper about THEIR day, from the facts given. Funny, warm, kind, a little over-dramatic, like a tabloid that adores its reader.

Return ONLY JSON: {"headline": "...", "highlight": "...", "deck": "...", "forecast": "..."}
- headline: ALL CAPS, max 60 characters, tabloid style about their day (example: "LOCAL STUDENT HAS JUST ONE REAL THING DUE TODAY").
- highlight: one word copied exactly from the headline to print in a black box (a number or the key word).
- deck: one sentence, max 150 characters, same voice (example: "Experts stunned. Sources close to Jagger confirm the bio lab is the only threat.").
- forecast: one or two sentences, max 150 characters: a small, specific, encouraging plan for the heaviest day ahead, or something light if nothing is due.

Rules:
- Use ONLY the facts given. Never invent a class, assignment, time, number, teacher or event. Mention at most the assignment titles listed.
- If "School today" is "no", the joke is about the free day. If it's "unknown", say nothing about school either way. Never invent homework or classes.
- Use the first name only if one is given; otherwise say "local student".
- Never mention grades, scores, failing, weight, bodies, looks, crushes, dating, family, money, health, feelings, or anything private. Never be mean or sarcastic about the reader.`

/** The model's front page, policed; null means "use the fallback". */
export async function writeFront(f) {
    const facts = [
        `First name: ${f.name || "(none)"}`,
        `Today: ${f.dayFull}. School today: ${f.schoolDay ? "yes" : f.hasSchedule ? "no" : "unknown (they haven't saved their classes, so never say whether there's school)"}.`,
        f.schedule.length ? `Classes today: ${f.schedule.map((s) => `${s.label} at ${s.time}`).join(", ")}` : "Classes today: none",
        `Due today (${f.dueToday.length}): ${f.dueToday.map((x) => x.title + (x.cls ? ` (${x.cls})` : "")).join("; ") || "nothing"}`,
        `Due tomorrow (${f.dueTomorrow.length}): ${f.dueTomorrow.map((x) => x.title).join("; ") || "nothing"}`,
        `Heaviest day ahead: ${f.heavy ? `${f.heavy.full}, ${f.heavy.n} due` : "none, nothing due in 7 days"}`,
    ].join("\n")
    try {
        const resp = await withRetry(() => ai().responses.create({
            model: process.env.PAPER_MODEL || MODELS.cheap,
            instructions: WRITER,
            input: facts,
        }), { label: "paper-front", tries: 2 })
        return checkFront(resp.output_text, f)
    } catch (e) {
        return null
    }
}

/** Pure. Validates the model's front page against the rules and the facts. */
export function checkFront(text, f) {
    let o
    try {
        const t = String(text || "")
        o = JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1))
    } catch (e) {
        return null
    }
    const headline = String(o.headline || "").trim().toUpperCase()
    const deck = String(o.deck || "").trim()
    const forecast = String(o.forecast || "").trim()
    let highlight = String(o.highlight || "").trim().toUpperCase()
    if (!headline || headline.length > 70 || !deck || deck.length > 180 || !forecast || forecast.length > 180) return null
    if (OFF_LIMITS.test([headline, deck, forecast].join(" "))) return null
    // Any number it prints must be one the facts contain.
    const allowed = new Set([f.dueToday.length, f.dueTomorrow.length, f.heavy ? f.heavy.n : 0, f.schedule.length].map(String))
    f.schedule.forEach((s) => s.time.split(":").forEach((p) => allowed.add(String(Number(p)))))
    for (const n of [headline, deck, forecast].join(" ").match(/\b\d+\b/g) || []) if (!allowed.has(String(Number(n)))) return null
    // A name it wasn't given is a name it made up.
    if (!f.name && /[Ss]ources close to [A-Z][a-z]/.test(deck)) return null
    if (!new RegExp(`(^|[^A-Z0-9])${highlight.replace(/[^A-Z0-9]/g, "")}([^A-Z0-9]|$)`).test(headline)) highlight = ""
    return { headline, highlight, deck, forecast }
}

/** Pure. The stored paper. */
export function assemble(f, front, news) {
    return {
        v: 1,
        date: f.today,
        dateLabel: f.dateLabel,
        issue: f.issue,
        name: f.name,
        front: { kicker: "BREAKING · YOUR DAY", ...front },
        market: marketRows(f),
        marketRaw: f.raw,
        intro: introText(f),
        schedule: f.schedule,
        hasSchedule: f.hasSchedule,
        ticker: tickerLines(f, news),
        news,
        week: { label: f.weekLabel, days: f.week.map(({ d, n, today, heavy }) => ({ d, n, today, heavy })) },
        next: f.next,
        forecast: front.forecast,
    }
}

// ---- Loading and saving --------------------------------------------------

/** First name the student goes by, or null. Never the email. */
export function firstNameOf(profile, meta) {
    const raw = (profile && profile.display_name) || (meta && (meta.name || meta.full_name)) || ""
    const first = String(raw).trim().split(/\s+/)[0] || ""
    return /^[\p{L}][\p{L}'’-]{0,23}$/u.test(first) ? first : null
}

export async function userTz(db, userId) {
    try {
        const { data } = await db.from("notification_prefs").select("tz").eq("user_id", userId).maybeSingle()
        if (data && data.tz) { new Intl.DateTimeFormat("en-US", { timeZone: data.tz }); return data.tz }
    } catch (e) { /* fall through */ }
    return "America/Los_Angeles"
}

/** Latest news edition (today's, or the most recent one). */
export async function latestNews(db) {
    const { data } = await db.from("daily_news").select("edition, stories").order("edition", { ascending: false }).limit(1).maybeSingle()
    return (data && Array.isArray(data.stories) ? data.stories : [])
}

/** Builds and saves one student's paper for their local today. Returns the content. */
export async function buildPaper(userId, { now = new Date(), tzOverride = null, news = null } = {}) {
    const db = svc()
    const tz = tzOverride || await userTz(db, userId)
    const today = localParts(now, tz).iso
    const wd = dow(today)
    const monday = addDaysIso(today, wd === 0 ? 1 : wd === 6 ? 2 : 1 - wd)
    const [u, prof, c, m, a, y, n] = await Promise.all([
        db.auth.admin.getUserById(userId),
        db.from("rocco_profile").select("display_name").eq("user_id", userId).maybeSingle(),
        db.from("classes").select("id, name, short_name, period, start_time, end_time, days").eq("user_id", userId).order("sort_order"),
        db.from("schedule_meta").select("*").eq("user_id", userId).maybeSingle(),
        db.from("assignments").select("id, title, short_title, class_id, due_date, due_at, done, dropped_at, kind")
            .eq("user_id", userId).eq("done", false).is("dropped_at", null)
            .gte("due_date", [monday, addDaysIso(today, -1)].sort()[0]).lte("due_date", addDaysIso(today, 8)).limit(200),
        db.from("daily_papers").select("content").eq("user_id", userId).eq("local_date", addDaysIso(today, -1)).maybeSingle(),
        news ? Promise.resolve(news) : latestNews(db),
    ])
    const user = u && u.data && u.data.user
    const f = paperFacts({
        now, tz,
        name: firstNameOf(prof.data, user && user.user_metadata),
        signupAt: user && user.created_at,
        classes: c.data || [], pattern: m.data || null, rows: a.data || [],
        yesterday: y.data && y.data.content && y.data.content.marketRaw,
    })
    const front = (await writeFront(f)) || fallbackFront(f)
    const content = assemble(f, front, n || [])
    await db.from("daily_papers").upsert({ user_id: userId, local_date: today, content })
    return content
}
