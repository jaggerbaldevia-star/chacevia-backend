// api/schedule-extract.js
//
// Turns a class schedule into structured JSON — two ways in, one way out:
//   { image: base64 }  → vision reads a photo/screenshot/handwritten list
//   { audio: base64 }  → transcribed, then read the same way
// Both converge on the identical class array so the confirmation screen
// doesn't care which path the user took.
//
// Nothing here writes to the database. The user confirms first.

import OpenAI, { toFile } from "openai"
import { requireCoins, chargeAfter } from "./_coins.js"
import { MODELS, withRetry, ai } from "./_ai.js"

export const config = { maxDuration: 60 }
const COIN_COST = 2
const TRANSCRIBE_MODEL = "whisper-1"

function setCorsHeaders(res) {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")
}

const SHARED_RULES = `Extract the student's class schedule AND work out the pattern it follows.

Return ONLY valid JSON — no prose, no markdown, no code fences:
{
  "pattern": {
    "type": "weekly" | "ab" | "rotating" | "other",
    "cycle_labels": ["A","B"],
    "skip_weekends": true,
    "notes": "one short sentence explaining the pattern in plain words"
  },
  "classes": [{"name": "...", "period": "...", "start_time": "...", "end_time": "...", "days": ["A"]}]
}

FIGURING OUT THE PATTERN — do this first, it changes how you read everything else:
- "weekly": the same classes every Monday, every Tuesday, etc. cycle_labels is ["Mon","Tue","Wed","Thu","Fri"].
- "ab": alternating A/B (or Blue/Gold, X/Y, Odd/Even) days. cycle_labels like ["A","B"].
- "rotating": a numbered cycle that keeps rolling regardless of weekday — Day 1 through Day 6, etc. cycle_labels like ["Day 1","Day 2",...]. These are common and easy to misread as weekly — if you see day numbers that go past 5, or the same period holding different classes on different days, it's rotating.
- "other": anything else (college MWF/TTh blocks, flex/seminar days, week A/week B). Explain it in notes.

Signals to look for: a legend or key, columns labelled with letters or day numbers, the same period holding different classes, "drop" or "flex" periods, classes that clearly don't meet daily.

Then set each class's "days" to the cycle labels it meets on — ["A"], ["Day 1","Day 4"], ["Mon","Wed","Fri"] — using the SAME labels you put in cycle_labels. Empty array [] if you can't tell.

Field rules:
- "name": the class as the student would say it ("Algebra 2", "AP Bio", "Chemistry").
- "period": whatever labels the slot — "1st", "3rd", "Block A", "Period 4". null if there isn't one.
- "start_time"/"end_time": 24-hour "HH:MM". null if not stated or not certain.
- "days": array from ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"], OR rotation letters like ["A"], ["B"], ["A","B"] for A/B day schedules. Empty array [] if unknown.

CRITICAL — never guess. If a time or day isn't clearly there, use null (or [] for days).
A null the student fixes in two taps is far better than a wrong time they don't notice.

Keep classes in the order they occur in the day. Include lunch/advisory/study hall if listed.
If you can't find any classes at all, return {"classes": []}.`

const IMAGE_RULES = SHARED_RULES + `

This is a photo or screenshot of a schedule. It might be a grid/table, a portal screenshot, a printed handout, or handwritten. Read carefully:
- In a grid, figure out whether columns are days and rows are periods (or the reverse) before reading off classes.
- Rotating A/B day schedules often repeat the same period with different classes — capture both, using days ["A"] and ["B"].
- Ignore headers, room numbers, teacher names, and logos unless the class name is genuinely part of them.`

const SPEECH_RULES = SHARED_RULES + `

This is a student casually describing their day out loud, not reading a form. So:
- ORDER MATTERS MORE THAN TIMES. They'll say "first period", "then", "after that" — preserve the sequence and put it in "period" when they name one.
- They almost never state exact clock times. Leave start_time and end_time null rather than inventing them — the student fills those in on the next screen.
- They may not mention days at all. Leave days as [] unless they actually say it.
- Listen for pattern clues in how they talk: "on A days", "it rotates", "Day 3 I have...", "every other day", "I don't have it Fridays". If they clearly describe a rotation or A/B setup, set the pattern accordingly. If they just list a normal day, use "weekly".
- Strip filler ("um", "I think", "uh") and keep the class names clean.`

function parseClasses(text) {
    const t = String(text || "").trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "")
    const a = t.indexOf("{"), b = t.lastIndexOf("}")
    const obj = JSON.parse(t.slice(a, b + 1))
    const list = Array.isArray(obj.classes) ? obj.classes : []
    const classes = list.slice(0, 24).map((c) => ({
        name: String((c && c.name) || "").slice(0, 60) || "Untitled class",
        period: c && c.period ? String(c.period).slice(0, 20) : null,
        start_time: c && c.start_time ? String(c.start_time).slice(0, 5) : null,
        end_time: c && c.end_time ? String(c.end_time).slice(0, 5) : null,
        days: Array.isArray(c && c.days) ? c.days.map((d) => String(d).slice(0, 12)).filter(Boolean).slice(0, 8) : [],
    })).filter((c) => c.name)

    const p = obj.pattern || {}
    const types = ["weekly", "ab", "rotating", "other"]
    const pattern = {
        type: types.includes(p.type) ? p.type : "weekly",
        cycle_labels: Array.isArray(p.cycle_labels) && p.cycle_labels.length
            ? p.cycle_labels.map((d) => String(d).slice(0, 12)).slice(0, 10)
            : ["Mon", "Tue", "Wed", "Thu", "Fri"],
        skip_weekends: p.skip_weekends !== false,
        notes: p.notes ? String(p.notes).slice(0, 200) : "",
    }
    return { classes, pattern }
}

export default async function handler(req, res) {
    setCorsHeaders(res)
    if (req.method === "OPTIONS") return res.status(204).end()
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed. Use POST." })

    let body = req.body
    if (typeof body === "string") {
        try { body = JSON.parse(body) } catch { return res.status(400).json({ error: "Body must be valid JSON." }) }
    }
    const image = body && body.image
    const audio = body && body.audio
    if (!image && !audio) return res.status(400).json({ error: "Send a photo of your schedule, or record yourself describing it." })
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "Server is missing OPENAI_API_KEY." })

    try {
        const guard = await requireCoins(req, body, COIN_COST, "schedule-extract")
        if (!guard.ok) return res.status(guard.status).json(guard.payload)

        const model = MODELS.smart
        let resp
        let transcript = ""

        if (image) {
            const dataUri = image.startsWith("data:") ? image : "data:image/jpeg;base64," + image
            resp = await withRetry(
                () => ai().responses.create({
                    model,
                    input: [{
                        role: "user",
                        content: [
                            { type: "input_image", image_url: dataUri },
                            { type: "input_text", text: IMAGE_RULES },
                        ],
                    }],
                }),
                { label: "schedule-image" }
            )
        } else {
            const clean = audio.replace(/^data:[^;]+;base64,/, "")
            const buffer = Buffer.from(clean, "base64")
            try {
                const file = await toFile(buffer, (body && body.filename) || "schedule.m4a")
                const tr = await withRetry(
                    () => ai().audio.transcriptions.create({ file, model: TRANSCRIBE_MODEL }),
                    { label: "schedule-transcribe" }
                )
                transcript = (tr && tr.text) || ""
            } catch (e) {
                console.error("schedule transcription error:", e)
                return res.status(502).json({ error: "Couldn't hear that recording. Try again somewhere quieter." })
            }
            if (!transcript.trim()) {
                return res.status(200).json({ classes: [], transcript: "", message: "I couldn't hear any speech in that.", coins: guard.balance })
            }
            resp = await withRetry(
                () => ai().responses.create({
                    model,
                    instructions: SPEECH_RULES,
                    input: "The student said:\n" + transcript,
                }),
                { label: "schedule-speech" }
            )
        }

        let parsed
        try { parsed = parseClasses(resp.output_text) } catch (e) {
            return res.status(502).json({ error: "Couldn't read that schedule. Try a clearer photo, or just say your classes out loud." })
        }

        const coins = await chargeAfter(guard)
        return res.status(200).json({ classes: parsed.classes, pattern: parsed.pattern, transcript, coins })
    } catch (err) {
        console.error("schedule-extract error:", err)
        return res.status(500).json({ error: "Something went wrong reading that schedule. Try again." })
    }
}
