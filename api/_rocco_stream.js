// api/_rocco_stream.js
//
// Pulls Rocco's spoken reply out of his JSON answer while it is still being
// written, so the app can show the first words before the model has finished.
// Not an API route (leading underscore).
//
// The model answers {"crisis": ..., "reply": "...", "doodle": ...}. Each push()
// takes the next chunk of that text and returns the new reply characters it
// completed, plus the crisis flag once it has been written. JSON string escapes
// are decoded here; one cut in half across two chunks waits for the rest.

const REPLY_START = /"reply"\s*:\s*"/
const CRISIS = /"crisis"\s*:\s*(true|false)/

const ESCAPES = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }

export function replyStream() {
    let raw = ""
    let pos = -1        // index in raw of the next undecoded reply character
    let closed = false  // the reply string has ended
    let crisis = null

    return {
        push(chunk) {
            raw += chunk
            if (crisis === null) {
                const m = CRISIS.exec(raw)
                if (m) crisis = m[1] === "true"
            }
            let text = ""
            if (pos < 0 && !closed) {
                const m = REPLY_START.exec(raw)
                if (m) pos = m.index + m[0].length
            }
            while (pos >= 0 && !closed && pos < raw.length) {
                const c = raw[pos]
                if (c === '"') { closed = true; break }
                if (c !== "\\") { text += c; pos++; continue }
                const e = raw[pos + 1]
                if (e === undefined) break
                if (e === "u") {
                    const hex = raw.slice(pos + 2, pos + 6)
                    if (hex.length < 4) break
                    text += String.fromCharCode(parseInt(hex, 16))
                    pos += 6
                    continue
                }
                text += ESCAPES[e] ?? e
                pos += 2
            }
            return { text, crisis }
        },
        get raw() { return raw },
    }
}
