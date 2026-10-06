// node --test test/stale-canvas.test.mjs — archiving past-due Canvas work on
// connect, and the quiet auto-done for unanswered "did you turn it in?".
import test from "node:test"
import assert from "node:assert/strict"
import { isPastDue, backfillPastDue, autoDoneUnanswered, TURNIN_ANSWER_MS } from "../api/_canvas.js"

const NOW = new Date("2026-10-06T19:00:00Z") // 12:00 in Los Angeles

test("isPastDue: due time wins; date-only compares to today in the student's zone", () => {
    const tz = "America/Los_Angeles"
    assert.equal(isPastDue({ due_at: "2026-10-06T18:59:00Z" }, NOW, tz), true)
    assert.equal(isPastDue({ due_at: "2026-10-06T23:59:00Z", due_date: "2026-10-05" }, NOW, tz), false, "time later today = not yet")
    assert.equal(isPastDue({ due_date: "2026-10-05" }, NOW, tz), true)
    assert.equal(isPastDue({ due_date: "2026-10-06" }, NOW, tz), false, "due today is not past due")
    assert.equal(isPastDue({ due_date: "2026-10-06" }, new Date("2026-10-07T06:30:00Z"), tz), false, "still the 6th in LA")
    assert.equal(isPastDue({}, NOW, tz), false, "undated is never past due")
})

function fakeDb(rows) {
    const log = []
    const from = (table) => {
        const q = { table, ops: [] }
        const self = new Proxy(q, {
            get(t, k) {
                if (k === "then") {
                    const kind = t.ops[0][0]
                    const data = kind === "select" ? rows : kind === "update" ? rows.map((r) => ({ id: r.id })) : null
                    return (ok) => ok({ data, error: null })
                }
                return (...args) => { t.ops.push([k, ...args]); return self }
            },
        })
        log.push(q)
        return self
    }
    return { db: { from }, log }
}

test("backfillPastDue archives only past-due open Canvas work, as canvas_backfill", async () => {
    const { db, log } = fakeDb([
        { id: "a", due_date: "2026-09-30" },
        { id: "b", due_at: "2026-10-06T18:00:00Z" },
        { id: "c", due_date: "2026-10-08" },
        { id: "d", due_date: null },
    ])
    assert.equal(await backfillPastDue(db, "u1", "America/Los_Angeles", NOW), 2)
    const sel = log[0].ops
    assert.ok(sel.some((o) => o[0] === "eq" && o[1] === "source" && o[2] === "canvas"))
    assert.ok(sel.some((o) => o[0] === "eq" && o[1] === "done" && o[2] === false))
    const upd = log[1].ops
    assert.deepEqual(upd[0], ["update", { done: true, done_source: "canvas_backfill", done_at: NOW.toISOString() }])
    assert.ok(upd.some((o) => o[0] === "in" && o[1] === "id" && o[2].join() === "a,b"))
    assert.ok(upd.some((o) => o[0] === "eq" && o[1] === "user_id" && o[2] === "u1"))
})

test("backfillPastDue with nothing past due writes nothing", async () => {
    const { db, log } = fakeDb([{ id: "c", due_date: "2026-10-08" }])
    assert.equal(await backfillPastDue(db, "u1", "UTC", NOW), 0)
    assert.equal(log.length, 1)
})

test("autoDoneUnanswered: Canvas, open, asked over 3 days ago → canvas_auto", async () => {
    const { db, log } = fakeDb([{ id: "x" }])
    assert.equal(await autoDoneUnanswered(db, NOW), 1)
    const ops = log[0].ops
    assert.deepEqual(ops[0], ["update", { done: true, done_source: "canvas_auto", done_at: NOW.toISOString() }])
    assert.ok(ops.some((o) => o[0] === "lt" && o[1] === "turnin_asked_at" && o[2] === new Date(NOW - TURNIN_ANSWER_MS).toISOString()))
    assert.ok(ops.some((o) => o[0] === "eq" && o[1] === "source" && o[2] === "canvas"))
    assert.ok(ops.some((o) => o[0] === "eq" && o[1] === "done" && o[2] === false))
})
