// node --test test/
import test from "node:test"
import assert from "node:assert/strict"
import { REMINDER_LINES, AFTER_CLASS_LINES, AFTER_SCHOOL_LINES, SIGN_OFF_LINE, BANNED_WORDS } from "../api/_rocco_lines.js"
import { whenPhrase, fillLine, pickTemplate, ignoredStreak, afterClassDue, dispatch, ordinal, titleFor, classFor, DEFAULT_CAP, TEMPLATE_COOLDOWN_DAYS } from "../api/_reminders.js"
import { labelOn, meetsOn, classesOn, localParts } from "../api/_schedule.js"

const ALL = ["Mon", "Tue", "Wed", "Thu", "Fri"]

test("the line pool: big enough, every line names title/class/when, tone rules hold", () => {
    assert.ok(REMINDER_LINES.length >= 56, "need 56+ lines for 4/day × 14 days, have " + REMINDER_LINES.length)
    assert.equal(new Set(REMINDER_LINES).size, REMINDER_LINES.length, "duplicate lines")
    for (const l of REMINDER_LINES) {
        for (const k of ["{title}", "{class}", "{when}"]) assert.ok(l.includes(k), `"${l}" is missing ${k}`)
        const filled = fillLine(l, { title: "Ch. 4 reading", class: "Chemistry", when: "3rd period tomorrow" })
        assert.ok(filled.length <= 120, `too long (${filled.length}): ${filled}`)
        assert.doesNotMatch(filled, /[\u{1F300}-\u{1FAFF}☀-➿]/u, "no emoji: " + filled)
    }
    for (const l of [...REMINDER_LINES, ...AFTER_CLASS_LINES, ...AFTER_SCHOOL_LINES, SIGN_OFF_LINE])
        for (const w of BANNED_WORDS) assert.doesNotMatch(l.toLowerCase(), new RegExp("\\b" + w.replace(/ /g, "\\s+") + "\\b"), `banned "${w}" in: ${l}`)
})

test("whenPhrase", () => {
    assert.equal(whenPhrase("2026-10-08", "2026-10-07", "3"), "3rd period tomorrow")
    assert.equal(whenPhrase("2026-10-07", "2026-10-07", "Period 1"), "1st period today")
    assert.equal(whenPhrase("2026-10-09", "2026-10-07", null), "Friday")
    assert.equal(whenPhrase("2026-10-20", "2026-10-07", "2"), "Oct 20, 2nd period")
    assert.equal(ordinal(11), "11th"); assert.equal(ordinal(22), "22nd")
})

test("names: the student's own wording unless it's long", () => {
    assert.equal(titleFor("QA test - delete me", "qa test"), "QA test - delete me")
    assert.equal(titleFor("Read chapters four through seven and annotate every page", "ch. 4-7 reading"), "Ch. 4-7 reading")
    assert.equal(classFor("Spanish 3", "spanish"), "Spanish 3")
    assert.equal(classFor("Graphic Design and Typography", "graphic design"), "Graphic design")
    assert.equal(classFor(null, null), "school")
})

test("fillLine capitalises a lowercase start", () => {
    assert.equal(fillLine("{title} is due {when}.", { title: "read ch. 4", when: "tomorrow" }), "Read ch. 4 is due tomorrow.")
})

test("no line repeats within 14 days at 4 a day", () => {
    let recent = []
    const start = new Date("2026-10-01T15:00:00Z")
    for (let day = 0; day < 30; day++) {
        for (let k = 0; k < DEFAULT_CAP; k++) {
            const now = new Date(start.getTime() + day * 86400000 + k * 3600000)
            const t = pickTemplate(REMINDER_LINES, recent, now, Math.random)
            const clash = recent.find((r) => r.template === t && now - new Date(r.sent_at) < TEMPLATE_COOLDOWN_DAYS * 86400000)
            assert.ok(!clash, `repeat on day ${day}: ${t}`)
            recent.push({ template: t, sent_at: now.toISOString() })
        }
    }
})

test("pool exhausted → least recently used", () => {
    const pool = ["a", "b"]
    const now = new Date("2026-10-10T00:00:00Z")
    const recent = [{ template: "a", sent_at: "2026-10-09T00:00:00Z" }, { template: "b", sent_at: "2026-10-05T00:00:00Z" }]
    assert.equal(pickTemplate(pool, recent, now), "b")
})

test("ignoredStreak counts days with unopened sends, stops at an opened day or an app open", () => {
    const tz = "America/Los_Angeles"
    const days = ["2026-10-09", "2026-10-08", "2026-10-07", "2026-10-06", "2026-10-05"]
    const logs = days.map((d) => ({ local_date: d, status: "sent", kind: "reminder", opened_at: null }))
    assert.equal(ignoredStreak(logs, null, "2026-10-10", tz), 5)
    assert.equal(ignoredStreak(logs, "2026-10-08T20:00:00Z", "2026-10-10", tz), 1, "app opened Oct 8 local")
    const opened = logs.map((l, i) => (i === 2 ? { ...l, opened_at: "x" } : l))
    assert.equal(ignoredStreak(opened, null, "2026-10-10", tz), 2)
    const gap = logs.filter((l) => l.local_date !== "2026-10-08")
    assert.equal(ignoredStreak(gap, null, "2026-10-10", tz), 1, "a day with nothing sent breaks the streak")
})

test("schedule: weekly and rotation labels; classesOn uses slot bell times", () => {
    const rot = { cycle_labels: ["Odd Fwd", "Even Fwd", "Odd Rev", "Even Rev"], anchor_date: "2026-10-05", anchor_label: "Odd Fwd", skip_weekends: true }
    assert.equal(labelOn("2026-10-07", rot), "Odd Rev")
    assert.equal(labelOn("2026-10-10", rot), null, "Saturday")
    assert.equal(labelOn("2026-10-12", rot), "Even Fwd", "weekend skipped")
    assert.equal(labelOn("2026-10-07", null), "Wed")
    const classes = [1, 3, 5, 7].map((p) => ({ id: "p" + p, name: "P" + p, period: String(p), start_time: `${7 + p}:00`, end_time: `${7 + p}:50` }))
    const wed = classesOn("2026-10-07", classes, rot) // Odd Rev: 7,5,3,1 at the first four bell times
    assert.deepEqual(wed.map((r) => r.cls.id), ["p7", "p5", "p3", "p1"])
    assert.equal(wed[0].start, 8 * 60)
    assert.ok(meetsOn({ days: ["monday"] }, "Mon"))
})

test("afterClassDue: each class / after school, inside a 10-minute window, in the student's timezone", () => {
    const tz = "America/Los_Angeles"
    const classes = [
        { id: "c1", name: "Chem", start_time: "08:00", end_time: "08:50", days: ALL },
        { id: "c2", name: "Eng", start_time: "09:00", end_time: "09:50", days: ALL },
    ]
    const at = (local) => new Date(local + "-07:00") // PDT
    assert.deepEqual(afterClassDue(at("2026-10-07T08:53:00"), tz, "each", classes, null).map((d) => d.cls.id), ["c1"])
    assert.deepEqual(afterClassDue(at("2026-10-07T09:20:00"), tz, "each", classes, null), [], "outside window")
    assert.deepEqual(afterClassDue(at("2026-10-07T08:53:00"), tz, "after_school", classes, null), [])
    assert.equal(afterClassDue(at("2026-10-07T09:51:00"), tz, "after_school", classes, null)[0].key, "as:2026-10-07")
    assert.deepEqual(afterClassDue(at("2026-10-10T08:53:00"), tz, "each", classes, null), [], "Saturday")
    assert.deepEqual(afterClassDue(at("2026-10-07T08:53:00"), tz, "off", classes, null), [])
})

// ---- dispatch, with an in-memory store ----
function fakeStore({ claimed = [], prefs = [], logs = [], tokens = {}, schedule = {} } = {}) {
    const st = { logs: logs.slice(), paused: [], deleted: [], nextId: 1 }
    st.store = {
        claimDue: async () => claimed,
        afterClassUsers: async () => prefs.filter((p) => p.after_class && p.after_class !== "off"),
        prefs: async () => new Map(prefs.map((p) => [p.user_id, p])),
        logs: async () => st.logs.slice(),
        tokens: async () => new Map(Object.entries(tokens)),
        schedule: async (uid) => schedule[uid] || { classes: [], pattern: null },
        insertLog: async (row) => {
            if (row.dedupe_key && st.logs.some((l) => l.user_id === row.user_id && l.dedupe_key === row.dedupe_key)) return null
            const id = st.nextId++
            st.logs.push({ id, sent_at: new Date().toISOString(), ...row })
            return id
        },
        setPaused: async (uid) => st.paused.push(uid),
        deleteToken: async (t) => st.deleted.push(t),
    }
    st.sent = []
    st.send = async (msgs) => {
        st.sent.push(...msgs)
        return msgs.map((m) => (m.to === "dead" ? { status: "error", details: { error: "DeviceNotRegistered" } } : { status: "ok", id: "t" }))
    }
    return st
}
const NOW = new Date("2026-10-07T23:00:00Z") // Wed 4pm PDT
const rem = (i, extra = {}) => ({ r_id: "r" + i, r_user: "u1", r_assignment: "a" + i, r_title: "Assignment " + i, r_short: null, r_due: "2026-10-08", r_done: false, r_class: "c1", r_class_name: "Chemistry", r_class_short: "Chem", r_period: "3", r_days_before: 1, r_user_set: false, r_fire: "2026-10-07T22:59:00Z", r_tz: "America/Los_Angeles", ...extra })

test("dispatch: names the work, carries the assignment id, honours the cap but never blocks the student's own", async () => {
    const claimed = [1, 2, 3, 4, 5].map((i) => rem(i)).concat([rem(6, { r_user_set: true })])
    const st = fakeStore({ claimed, prefs: [{ user_id: "u1", daily_cap: 4, tz: "America/Los_Angeles" }], tokens: { u1: ["tokA"] } })
    const s = await dispatch({ store: st.store, send: st.send, now: NOW })
    assert.equal(s.sent, 4, "cap is the total: own + 3 of Rocco's"); assert.equal(s.capped, 2)
    const own = st.sent.find((m) => m.data.assignmentId === "a6"); assert.ok(own, "own reminder always goes")
    for (const m of st.sent) {
        assert.match(m.body, /Assignment \d/); assert.match(m.body, /Chemistry/); assert.match(m.body, /3rd period tomorrow/)
        assert.equal(m.categoryId, "assignment"); assert.equal(m.data.type, "assignment"); assert.ok(m.data.logId)
    }
    assert.equal(new Set(st.sent.map((m) => m.body.replace(/Assignment \d/, ""))).size, 4, "four different lines")
})

test("dispatch: stale, done and paused", async () => {
    const claimed = [rem(1, { r_fire: "2026-10-05T00:00:00Z" }), rem(2, { r_done: true }), rem(3), rem(4, { r_user_set: true })]
    const st = fakeStore({ claimed, prefs: [{ user_id: "u1", paused: true, tz: "America/Los_Angeles" }], tokens: { u1: ["tokA"] } })
    const s = await dispatch({ store: st.store, send: st.send, now: NOW })
    assert.equal(s.stale, 1); assert.equal(s.done, 1); assert.equal(s.paused, 1); assert.equal(s.sent, 1)
    assert.equal(st.sent[0].data.assignmentId, "a4")
})

test("dispatch: 5 ignored days → one sign-off, then pause", async () => {
    const days = ["2026-10-06", "2026-10-05", "2026-10-04", "2026-10-03", "2026-10-02"]
    const logs = days.map((d) => ({ user_id: "u1", local_date: d, status: "sent", kind: "reminder", opened_at: null, template: null, sent_at: d + "T20:00:00Z" }))
    const st = fakeStore({ claimed: [rem(1), rem(2, { r_user_set: true })], prefs: [{ user_id: "u1", tz: "America/Los_Angeles", last_seen_at: "2026-09-30T20:00:00Z" }], logs, tokens: { u1: ["tokA"] } })
    const s = await dispatch({ store: st.store, send: st.send, now: NOW })
    assert.equal(s.signOffs, 1); assert.deepEqual(st.paused, ["u1"])
    assert.equal(st.sent[0].body, "I'll stop bugging you. I'm here when you need me.")
    assert.equal(s.paused, 1, "Rocco's own reminder held back"); assert.ok(st.sent.some((m) => m.data.assignmentId === "a2"), "student's own still sent")
    // a second run the same day doesn't sign off again
    const st2 = fakeStore({ claimed: [rem(3)], prefs: [{ user_id: "u1", tz: "America/Los_Angeles", paused: true }], logs: st.logs, tokens: { u1: ["tokA"] } })
    const s2 = await dispatch({ store: st2.store, send: st2.send, now: NOW })
    assert.equal(s2.signOffs, 0); assert.equal(s2.paused, 1)
})

test("dispatch: after-class prompt once per class per day, dead tokens removed", async () => {
    const sched = { classes: [{ id: "c1", name: "Chemistry", short_name: "Chem", start_time: "15:00", end_time: "15:55", days: ALL }], pattern: null }
    const prefs = [{ user_id: "u1", tz: "America/Los_Angeles", after_class: "each" }]
    const now = new Date("2026-10-07T22:58:00Z") // 3:58pm PDT, Chem ended 3:55
    const st = fakeStore({ prefs, tokens: { u1: ["tokA", "dead"] }, schedule: { u1: sched } })
    const s = await dispatch({ store: st.store, send: st.send, now })
    assert.equal(s.afterClass, 1); assert.equal(st.sent.length, 2)
    assert.equal(st.sent[0].categoryId, "after-class"); assert.equal(st.sent[0].data.classId, "c1"); assert.match(st.sent[0].body, /Chem/)
    assert.deepEqual(st.deleted, ["dead"])
    const s2 = await dispatch({ store: st.store, send: st.send, now: new Date(now.getTime() + 60000) })
    assert.equal(s2.afterClass, 0, "deduped")
})

test("dispatch: nobody to notify → no queries beyond the claim", async () => {
    const st = fakeStore({})
    const s = await dispatch({ store: st.store, send: st.send, now: NOW })
    assert.equal(s.sent, 0); assert.equal(st.sent.length, 0)
})
