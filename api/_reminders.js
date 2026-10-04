// api/_reminders.js
//
// Not an API route (leading underscore). Rocco's reminder dispatcher, run once
// a minute by pg_cron through /api/reminder-dispatch.
//
// What it guarantees:
//   - every reminder names the assignment, the class and when it's due
//     ("Read ch. 4 for Chem. Due 3rd period tomorrow.")
//   - lines come from api/_rocco_lines.js; a student never sees the same line
//     twice within 14 days
//   - at most `daily_cap` notifications a day (default 4). Reminders the
//     student set up themselves are never blocked by the cap, but count toward it
//   - after 5 days in a row of ignored reminders: one sign-off, then only the
//     student's own reminders until they open the app again
//   - opt-in "anything to log?" prompts after each class, or once after school
//   - a tap opens that assignment (data.assignmentId); never a paywall
//
// The pure functions are exported for tests; `dispatch` takes its database
// and its push sender as arguments for the same reason.

import { REMINDER_LINES, SIGN_OFF_LINE, AFTER_CLASS_LINES, AFTER_SCHOOL_LINES } from "./_rocco_lines.js"
import { addDaysIso, classesOn, daysBetween, endOf, isoToDate, localParts, periodNum } from "./_schedule.js"

export const DEFAULT_CAP = 4
export const IGNORE_DAYS = 5
export const TEMPLATE_COOLDOWN_DAYS = 14
const STALE_MS = 24 * 3600 * 1000
// How late an after-class prompt may still go out (cron can lag a few minutes).
export const AFTER_CLASS_WINDOW_MIN = 10

const FULL_DAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

export function ordinal(n) {
    const s = ["th", "st", "nd", "rd"]
    const v = n % 100
    return n + (s[(v - 20) % 10] || s[v] || s[0])
}

/** "3rd period tomorrow", "Friday", "Oct 14, 2nd period", "today". */
export function whenPhrase(dueIso, todayIso, period) {
    const diff = daysBetween(todayIso, dueIso)
    const d = isoToDate(dueIso)
    const day =
        diff <= 0 ? "today" : diff === 1 ? "tomorrow" : diff < 7 ? FULL_DAY[d.getUTCDay()] : MONTHS[d.getUTCMonth()] + " " + d.getUTCDate()
    const p = periodNum(period)
    if (!p) return day
    return diff >= 7 ? `${day}, ${ordinal(p)} period` : `${ordinal(p)} period ${day}`
}

/** Fill {title} {class} {when}, and capitalise the first letter. */
export function fillLine(template, vars) {
    const s = template.replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? "" : String(vars[k])))
    return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * A line this student hasn't seen in 14 days; if every line has been used,
 * the one used longest ago. `recent` is [{ template, sent_at }].
 */
export function pickTemplate(pool, recent, now, rand = Math.random) {
    const cutoff = now.getTime() - TEMPLATE_COOLDOWN_DAYS * 86400000
    const used = new Set(recent.filter((r) => r.template && new Date(r.sent_at).getTime() >= cutoff).map((r) => r.template))
    const fresh = pool.filter((t) => !used.has(t))
    if (fresh.length) return fresh[Math.floor(rand() * fresh.length)]
    const last = new Map()
    for (const r of recent) {
        const t = new Date(r.sent_at).getTime()
        if (!last.has(r.template) || last.get(r.template) < t) last.set(r.template, t)
    }
    return pool.slice().sort((a, b) => (last.get(a) || 0) - (last.get(b) || 0))[0]
}

/**
 * Consecutive local days, ending yesterday, on which Rocco sent something and
 * none of it was opened — and the app wasn't opened that day or since.
 */
export function ignoredStreak(logs, lastSeenAt, todayIso, tz) {
    const byDay = {}
    for (const l of logs) {
        if (l.status !== "sent" || l.kind === "sign-off") continue
        const g = (byDay[l.local_date] ||= { opened: false })
        if (l.opened_at) g.opened = true
    }
    const seenIso = lastSeenAt ? localParts(new Date(lastSeenAt), tz).iso : null
    let streak = 0
    for (let i = 1; i <= IGNORE_DAYS + 1; i++) {
        const day = addDaysIso(todayIso, -i)
        const g = byDay[day]
        if (!g || g.opened) break
        if (seenIso && seenIso >= day) break
        streak++
    }
    return streak
}

/** After-class prompts owed right now: [{ cls, key }] (cls null = after school). */
export function afterClassDue(now, tz, mode, classes, pattern) {
    if (mode !== "each" && mode !== "after_school") return []
    const local = localParts(now, tz)
    const rows = classesOn(local.iso, classes || [], pattern)
    if (!rows.length) return []
    const inWindow = (end) => end <= local.minutes && local.minutes - end < AFTER_CLASS_WINDOW_MIN
    if (mode === "each")
        return rows.filter((r) => inWindow(endOf(r))).map((r) => ({ cls: r.cls, key: `ac:${r.cls.id}:${local.iso}` }))
    const last = Math.max(...rows.map(endOf))
    return inWindow(last) ? [{ cls: null, key: `as:${local.iso}` }] : []
}

// The names a student typed read best in a notification; the short labels
// (written lowercase for the home squares) only stand in for long ones.
const cap1 = (t) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t)
export function titleFor(full, short) {
    const t = String(full || "").trim()
    if (t && t.length <= 40) return t
    return cap1(String(short || "").trim()) || t.slice(0, 40)
}
export function classFor(full, short) {
    const n = String(full || "").trim()
    if (n && n.length <= 18) return n
    return cap1(String(short || "").trim()) || n || "school"
}

/**
 * One run. `store` is the database (see makeStore), `send` posts an array of
 * Expo messages and returns their tickets in order.
 */
export async function dispatch({ store, send, now = new Date(), rand = Math.random }) {
    const claimed = await store.claimDue()
    const acPrefs = await store.afterClassUsers()
    const userIds = [...new Set(claimed.map((r) => r.r_user).concat(acPrefs.map((p) => p.user_id)))]
    const summary = { claimed: claimed.length, sent: 0, capped: 0, paused: 0, stale: 0, done: 0, noToken: 0, signOffs: 0, afterClass: 0, failedTokens: 0 }
    if (!userIds.length) return summary

    const prefs = await store.prefs(userIds)
    const logs = await store.logs(userIds, new Date(now.getTime() - (TEMPLATE_COOLDOWN_DAYS + 1) * 86400000))
    const tokens = await store.tokens(userIds)
    const messages = []

    for (const uid of userIds) {
        const mine = claimed.filter((r) => r.r_user === uid)
        const p = prefs.get(uid) || {}
        const tz = p.tz || (mine[0] && mine[0].r_tz) || "UTC"
        const cap = Number(p.daily_cap) || DEFAULT_CAP
        const local = localParts(now, tz)
        const ulogs = logs.filter((l) => l.user_id === uid)
        const recent = ulogs.slice()
        let sentToday = ulogs.filter((l) => l.local_date === local.iso && l.status === "sent").length
        let paused = !!p.paused
        const toks = tokens.get(uid) || []

        // Own reminders first, then soonest first.
        mine.sort((a, b) => (b.r_user_set ? 1 : 0) - (a.r_user_set ? 1 : 0) || new Date(a.r_fire) - new Date(b.r_fire))

        const deliver = async (row, body, data, categoryId) => {
            const status = toks.length ? "sent" : "no-token"
            const id = await store.insertLog({ ...row, user_id: uid, body, local_date: local.iso, status })
            if (id == null) return false // dedupe: already handled by an earlier run
            if (status === "sent") {
                for (const to of toks) messages.push({ to, title: "Rocco", body, sound: "default", data: { ...data, logId: id }, ...(categoryId ? { categoryId } : {}) })
                sentToday++
                summary.sent++
            } else summary.noToken++
            return true
        }

        const fresh = mine.filter((r) => now.getTime() - new Date(r.r_fire).getTime() <= STALE_MS)
        summary.stale += mine.length - fresh.length
        const wantsAuto = fresh.some((r) => !r.r_done && !r.r_user_set) || (p.after_class && p.after_class !== "off")

        // Five ignored days: say so once, then step back.
        if (!paused && wantsAuto && ignoredStreak(ulogs, p.last_seen_at, local.iso, tz) >= IGNORE_DAYS) {
            await deliver({ kind: "sign-off", dedupe_key: `so:${local.iso}` }, SIGN_OFF_LINE, { type: "sign-off" }, null)
            await store.setPaused(uid, now)
            paused = true
            summary.signOffs++
        }

        for (const r of fresh) {
            if (r.r_done) {
                summary.done++
                continue
            }
            const base = { kind: "reminder", reminder_id: r.r_id, assignment_id: r.r_assignment, class_id: r.r_class }
            if (paused && !r.r_user_set) {
                await store.insertLog({ ...base, user_id: uid, local_date: local.iso, status: "paused" })
                summary.paused++
                continue
            }
            if (!r.r_user_set && sentToday >= cap) {
                await store.insertLog({ ...base, user_id: uid, local_date: local.iso, status: "capped" })
                summary.capped++
                continue
            }
            const template = pickTemplate(REMINDER_LINES, recent, now, rand)
            recent.push({ template, sent_at: now.toISOString() })
            const body = fillLine(template, {
                title: titleFor(r.r_title, r.r_short),
                class: classFor(r.r_class_name, r.r_class_short),
                when: whenPhrase(r.r_due, local.iso, r.r_period),
            })
            await deliver({ ...base, template }, body, { type: "assignment", assignmentId: r.r_assignment }, "assignment")
        }

        // "Anything to log?" after class — Rocco's own idea, so it obeys both
        // the pause and the cap.
        if (p.after_class && p.after_class !== "off" && !paused) {
            const sched = await store.schedule(uid)
            for (const due of afterClassDue(now, tz, p.after_class, sched.classes, sched.pattern)) {
                if (sentToday >= cap) {
                    summary.capped++
                    break
                }
                const pool = due.cls ? AFTER_CLASS_LINES : AFTER_SCHOOL_LINES
                const template = pickTemplate(pool, recent, now, rand)
                recent.push({ template, sent_at: now.toISOString() })
                const body = fillLine(template, { class: due.cls ? classFor(due.cls.name, due.cls.short_name) : "" })
                const ok = await deliver(
                    { kind: "after-class", class_id: due.cls ? due.cls.id : null, template, dedupe_key: due.key },
                    body,
                    { type: "after-class", classId: due.cls ? due.cls.id : null },
                    "after-class"
                )
                if (ok) summary.afterClass++
            }
        }
    }

    if (messages.length) {
        const tickets = await send(messages)
        for (let i = 0; i < tickets.length; i++) {
            const t = tickets[i]
            if (t && t.status === "error") {
                summary.failedTokens++
                if (t.details && t.details.error === "DeviceNotRegistered") await store.deleteToken(messages[i].to)
            }
        }
    }
    return summary
}

// ---------------------------------------------------------------------
// Production wiring
// ---------------------------------------------------------------------

export function makeStore(db) {
    return {
        async claimDue() {
            const { data, error } = await db.rpc("claim_due_reminders")
            if (error) throw error
            return data || []
        },
        async afterClassUsers() {
            const { data } = await db.from("notification_prefs").select("*").neq("after_class", "off")
            return data || []
        },
        async prefs(ids) {
            const { data } = await db.from("notification_prefs").select("*").in("user_id", ids)
            return new Map((data || []).map((p) => [p.user_id, p]))
        },
        async logs(ids, since) {
            const { data } = await db
                .from("notification_log")
                .select("user_id, kind, template, local_date, status, opened_at, sent_at")
                .in("user_id", ids)
                .gte("sent_at", since.toISOString())
            return data || []
        },
        async tokens(ids) {
            const { data } = await db.from("push_tokens").select("user_id, token").in("user_id", ids)
            const m = new Map()
            for (const t of data || []) m.set(t.user_id, (m.get(t.user_id) || []).concat(t.token))
            return m
        },
        async schedule(uid) {
            const [c, m] = await Promise.all([
                db.from("classes").select("*").eq("user_id", uid).order("sort_order"),
                db.from("schedule_meta").select("*").eq("user_id", uid).maybeSingle(),
            ])
            return { classes: c.data || [], pattern: m.data || null }
        },
        async insertLog(row) {
            const { data, error } = await db.from("notification_log").insert(row).select("id").single()
            if (error) {
                if (error.code === "23505") return null
                throw error
            }
            return data.id
        },
        async setPaused(uid, now) {
            await db
                .from("notification_prefs")
                .upsert({ user_id: uid, paused: true, paused_at: now.toISOString(), updated_at: now.toISOString() }, { onConflict: "user_id" })
        },
        async deleteToken(token) {
            await db.from("push_tokens").delete().eq("token", token)
        },
    }
}

/** Expo push, 100 messages per request. Returns one ticket per message. */
export async function sendExpo(messages) {
    const tickets = []
    for (let i = 0; i < messages.length; i += 100) {
        const chunk = messages.slice(i, i + 100)
        try {
            const r = await fetch("https://exp.host/--/api/v2/push/send", {
                method: "POST",
                headers: { "Content-Type": "application/json", Accept: "application/json" },
                body: JSON.stringify(chunk),
            })
            const j = await r.json().catch(() => ({}))
            const data = Array.isArray(j.data) ? j.data : chunk.map(() => ({ status: "error", message: "bad response" }))
            tickets.push(...data)
        } catch (e) {
            tickets.push(...chunk.map(() => ({ status: "error", message: String(e && e.message) })))
        }
    }
    return tickets
}
