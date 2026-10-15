import test from "node:test"
import assert from "node:assert/strict"
import { buildStats, dayKey, handleOwnerStats, OWNER_IDS } from "../api/_stats.js"

const NOW = Date.parse("2026-10-15T20:00:00Z") // 1pm in Los Angeles
const at = (daysAgo, h = 18) => new Date(NOW - daysAgo * 86400000 - (20 - h) * 3600000).toISOString()
const U = (id, daysAgo, real = true) => ({ id, created_at: at(daysAgo), real })
const E = (user_id, name, daysAgo) => ({ user_id, name, created_at: at(daysAgo) })

test("dayKey uses the stats time zone", () => {
    assert.equal(dayKey(Date.parse("2026-10-16T03:00:00Z")), "2026-10-15")
})

test("buildStats: totals, signups, actives, retention, features — test accounts left out", () => {
    const users = [U("a", 20), U("b", 10), U("c", 2), U("d", 0), U("me", 40, false)]
    const events = [
        E("a", "app_open", 1), E("a", "app_open", 0), E("b", "app_open", 9), E("c", "app_open", 0),
        E("me", "app_open", 0), E("a", "assignment_completed", 1), E("b", "assignment_completed", 2), E("a", "canvas_connected", 3),
        E("a", "tutorial_step", 1), E("a", "assignment_created", 10),
    ]
    const s = buildStats({ users, events, now: NOW })
    assert.equal(s.totalUsers, 4)
    assert.equal(s.signups.length, 30)
    assert.equal(s.signups.reduce((n, d) => n + d.n, 0), 4)
    assert.equal(s.signups[29].n, 1, "today")
    assert.equal(s.dauToday, 2, "a and c (not the owner)")
    assert.equal(s.wau, 2, "a and c this week")
    assert.deepEqual(s.retention, { eligible: 2, returned: 1, pct: 50 }) // a came back after day 7; b only on day 1 after signup
    assert.deepEqual(s.features.map((f) => [f.name, f.n, f.users]), [["assignment_completed", 2, 2], ["canvas_connected", 1, 1]])
    assert.deepEqual(s.cover, { tracked: false, starts: 0, users: 0 })
    assert.ok(!JSON.stringify(s).match(/"(a|b|c|d|me)"/), "no ids in the output")
})

test("handler: 404 for anyone but the owner; counts for the owner", async () => {
    const res = () => { const r = { code: 0, body: null, headers: {} }; r.status = (c) => { r.code = c; return r }; r.json = (b) => { r.body = b; return r }; r.setHeader = (k, v) => { r.headers[k] = v }; return r }
    const deps = (uid) => ({ userIdFrom: async () => uid, loadUsers: async () => [U("a", 3)], loadEvents: async () => [E("a", "app_open", 0)], now: () => NOW })
    for (const uid of [null, "someone-else"]) {
        const r = res(); await handleOwnerStats({ method: "GET", headers: {} }, r, deps(uid))
        assert.equal(r.code, 404)
    }
    const r = res(); await handleOwnerStats({ method: "GET", headers: {} }, r, deps(OWNER_IDS[0]))
    assert.equal(r.code, 200); assert.equal(r.body.totalUsers, 1); assert.equal(r.headers["Cache-Control"], "no-store")
})
