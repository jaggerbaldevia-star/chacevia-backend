// api/_stats.js
// The owner's private stats (/api/owner-stats → account?action=owner-stats).
// Read-only, counts only: never a name, email, id or any user's content leaves
// this file. Only the owner's own login may ask; everyone else gets a 404 so
// the endpoint doesn't advertise itself.
//
// Sources (nothing new in the database):
//   - auth users: created_at → total users, signups per day, 7-day retention
//   - public.events: "app_open" → daily / weekly active users, and the other
//     event names → features used this week
// The owner's own accounts and throwaway test accounts (@example.com) are left
// out, so the numbers are real students.

import { svc, getUserId } from "./_coins.js"

/** The owner's main login. The page only shows for this account. */
export const OWNER_IDS = ["2163d128-db68-4c14-b15a-eaad4dcfe489"]
/** Not real students: the owner's accounts. Plus any @example.com address. */
const EXCLUDE_IDS = ["2163d128-db68-4c14-b15a-eaad4dcfe489", "52975fdc-29bd-4360-be56-172eaf635571"]
export const STATS_TZ = "America/Los_Angeles"
const DAY = 86400000

/** Events that aren't a feature someone chose to use. */
const NOT_FEATURES = new Set(["app_open", "signed_in", "tutorial_step", "tutorial_done", "onboarding_started", "home_reached"])
/** Event names that mean "started recording a class" (Cover / record screen). */
const COVER_EVENTS = new Set(["cover_started", "ae_started"])

/** Pure. "2026-10-15" for an instant, in the stats time zone. */
export function dayKey(ms, tz = STATS_TZ) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms))
}

/**
 * Pure. users: [{ id, created_at, real }], events: [{ user_id, name, created_at }].
 * Returns counts only.
 */
export function buildStats({ users, events, now = Date.now(), tz = STATS_TZ }) {
    const real = users.filter((u) => u.real)
    const realIds = new Set(real.map((u) => u.id))
    const ev = events.filter((e) => realIds.has(e.user_id))
    const today = dayKey(now, tz)

    // New signups per day, last 30 days (oldest first, every day present).
    const days30 = []
    for (let i = 29; i >= 0; i--) days30.push(dayKey(now - i * DAY, tz))
    const signups = Object.fromEntries(days30.map((d) => [d, 0]))
    for (const u of real) {
        const d = dayKey(Date.parse(u.created_at), tz)
        if (d in signups) signups[d]++
    }

    // Active = opened the app (an "app_open" event that day).
    const opens = ev.filter((e) => e.name === "app_open")
    const activeOn = (d) => new Set(opens.filter((e) => dayKey(Date.parse(e.created_at), tz) === d).map((e) => e.user_id)).size
    const days14 = days30.slice(-14)
    const dau = days14.map((d) => ({ date: d, n: activeOn(d) }))
    const weekAgo = now - 7 * DAY
    const wau = new Set(opens.filter((e) => Date.parse(e.created_at) > weekAgo).map((e) => e.user_id)).size

    // 7-day retention: of people who signed up 7+ days ago, how many opened
    // the app again 7 or more days after signing up.
    const eligible = real.filter((u) => Date.parse(u.created_at) <= now - 7 * DAY)
    const firstLateOpen = new Set()
    for (const u of eligible) {
        const after = Date.parse(u.created_at) + 7 * DAY
        if (opens.some((e) => e.user_id === u.id && Date.parse(e.created_at) >= after)) firstLateOpen.add(u.id)
    }
    const retention = {
        eligible: eligible.length,
        returned: firstLateOpen.size,
        pct: eligible.length ? Math.round((firstLateOpen.size / eligible.length) * 100) : null,
    }

    // This week: Cover starts, and the features people used.
    const thisWeek = ev.filter((e) => Date.parse(e.created_at) > weekAgo)
    const coverEvents = thisWeek.filter((e) => COVER_EVENTS.has(e.name))
    const coverTracked = events.some((e) => COVER_EVENTS.has(e.name))
    const byName = {}
    for (const e of thisWeek) {
        if (NOT_FEATURES.has(e.name)) continue
        const b = (byName[e.name] = byName[e.name] || { name: e.name, n: 0, users: new Set() })
        b.n++
        b.users.add(e.user_id)
    }
    const features = Object.values(byName)
        .map((b) => ({ name: b.name, n: b.n, users: b.users.size }))
        .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
        .slice(0, 10)

    return {
        tz,
        today,
        totalUsers: real.length,
        signups: days30.map((d) => ({ date: d, n: signups[d] })),
        dau,
        dauToday: activeOn(today),
        wau,
        retention,
        cover: { tracked: coverTracked, starts: coverEvents.length, users: new Set(coverEvents.map((e) => e.user_id)).size },
        features,
        opensSince: opens.length ? dayKey(Math.min(...opens.map((e) => Date.parse(e.created_at))), tz) : null,
    }
}

function isReal(u) {
    return !EXCLUDE_IDS.includes(u.id) && !/@example\.com$/i.test(String(u.email || ""))
}

async function loadUsers(db) {
    const out = []
    for (let page = 1; page <= 20; page++) {
        const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 })
        if (error) throw error
        const list = (data && data.users) || []
        // Only what the counts need; the email is read here to drop test accounts and goes no further.
        for (const u of list) out.push({ id: u.id, created_at: u.created_at, real: isReal(u) })
        if (list.length < 1000) break
    }
    return out
}

async function loadEvents(db, sinceIso) {
    const out = []
    for (let from = 0; from < 200000; from += 1000) {
        const { data, error } = await db
            .from("events")
            .select("user_id, name, created_at")
            .gte("created_at", sinceIso)
            .order("created_at", { ascending: true })
            .range(from, from + 999)
        if (error) throw error
        out.push(...(data || []))
        if (!data || data.length < 1000) break
    }
    return out
}

function realDeps() {
    return {
        userIdFrom: (req) => getUserId(String((req.headers && req.headers.authorization) || "").replace(/^Bearer\s+/i, "")),
        loadUsers: () => loadUsers(svc()),
        loadEvents: (since) => loadEvents(svc(), since),
        now: () => Date.now(),
    }
}

export async function handleOwnerStats(req, res, deps = realDeps()) {
    if (req.method && req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "Method not allowed." })
    const uid = await deps.userIdFrom(req)
    // Not the owner (or not signed in): as if there were nothing here.
    if (!uid || !OWNER_IDS.includes(uid)) return res.status(404).json({ error: "Not found." })
    try {
        const now = deps.now()
        const [users, events] = await Promise.all([deps.loadUsers(), deps.loadEvents(new Date(now - 60 * DAY).toISOString())])
        res.setHeader && res.setHeader("Cache-Control", "no-store")
        return res.status(200).json(buildStats({ users, events, now }))
    } catch (err) {
        console.error("owner-stats error:", (err && (err.code || err.name)) || "unknown")
        return res.status(502).json({ error: "Couldn't load the numbers. Try again." })
    }
}
