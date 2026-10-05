// node --test test/rocco-stream.test.mjs — pulling the reply out of half-written JSON.
import test from "node:test"
import assert from "node:assert/strict"
import { replyStream } from "../api/_rocco_stream.js"

const feed = (chunks) => {
    const s = replyStream()
    let text = "", crisis = null
    for (const c of chunks) { const o = s.push(c); text += o.text; crisis = o.crisis }
    return { text, crisis }
}

test("reply comes through chunk by chunk, crisis read first", () => {
    const out = feed(['{"cri', 'sis": false, "re', 'ply": "Hey', ' Demo!', ' Let\'s go."', ', "doodle": null}'])
    assert.equal(out.text, "Hey Demo! Let's go.")
    assert.equal(out.crisis, false)
})

test("escapes split across chunks are decoded once whole", () => {
    const out = feed(['{"crisis":false,"reply":"say \\', '"hi\\"\\', 'n then \\u00', 'e9 ok"}'])
    assert.equal(out.text, 'say "hi"\n then é ok')
})

test("nothing after the closing quote leaks into the reply", () => {
    const out = feed(['{"crisis":false,"reply":"short"', ',"doodle":{"title":"x","shapes":[{"label":"reply"}]}}'])
    assert.equal(out.text, "short")
})

test("crisis true is reported before any reply text", () => {
    const s = replyStream()
    const first = s.push('{"crisis": true, ')
    assert.equal(first.crisis, true)
    assert.equal(first.text, "")
})

test("no crisis flag yet when the model writes reply first", () => {
    const s = replyStream()
    const o = s.push('{"reply": "hi there')
    assert.equal(o.crisis, null)
    assert.equal(o.text, "hi there")
})
