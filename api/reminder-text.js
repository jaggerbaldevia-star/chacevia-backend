// api/reminder-text.js
//
// Writes the reminder lines in Rocco's voice, ahead of time, so whatever
// eventually delivers them (push, email) just reads a string out of the DB.
// Free — this is part of setting up an assignment, not a separate AI feature.

import { requireCoins } from "./_coins.js"
import { MODELS, withRetry, ai } from "./_ai.js"

export const config = { maxDuration: 30 }

function setCorsHeaders(res) {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")
}

const INSTRUCTIONS = `You are Rocco, a tiny raspy pixel buddy who lives in a study app. Write push notification lines nudging a student about homework.

Return ONLY valid JSON: {"messages": ["...", "..."]} — one string per reminder, in the order given.

Rules for every line:
- Under 90 characters. It's a lock-screen notification, not a paragraph.
- Sound like a funny friend who remembered, not an app. Warm, a bit goofy, light sarcasm is fine.
- Natural slang is welcome but at most one per line, and never forced.
- Match the urgency to the timing: days ahead is a casual heads-up, night before is "ok actually", morning of is "IT'S TODAY".
- Use the class and assignment name so it's obviously about their real work.
- Never guilt-trip, shame, or catastrophize. No "you're going to fail". Encouraging, even when it's urgent.
- No emoji spam — one, sometimes, max.`

export default async function handler(req, res) {
    setCorsHeaders(res)
    if (req.method === "OPTIONS") return res.status(204).end()
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed. Use POST." })

    let body = req.body
    if (typeof body === "string") {
        try { body = JSON.parse(body) } catch { return res.status(400).json({ error: "Body must be valid JSON." }) }
    }
    const title = body && body.title
    const className = (body && body.className) || ""
    const dueDate = (body && body.dueDate) || ""
    const reminders = Array.isArray(body && body.reminders) ? body.reminders.slice(0, 5) : []
    if (!title || !reminders.length) return res.status(400).json({ error: "Missing assignment or reminders." })

    // Fallback lines so reminders always exist even if the AI call fails.
    const fallback = reminders.map((r) => {
        const d = Number(r.days_before) || 0
        if (d === 0) return `Today's the day — "${title}" is due! You got this.`
        if (d === 1) return `Heads up: "${title}" is due tomorrow.`
        return `"${title}" is due in ${d} days — might be worth a look.`
    })

    if (!process.env.OPENAI_API_KEY) return res.status(200).json({ messages: fallback })

    try {
        // Must be logged in, but no coin charge for this.
        const guard = await requireCoins(req, body, 0, "reminder-text")
        if (!guard.ok) return res.status(guard.status).json(guard.payload)

        const lines = reminders.map((r) => {
            const d = Number(r.days_before) || 0
            const when = d === 0 ? "the morning it's due" : d === 1 ? "the night before" : d + " days before it's due"
            return "- a reminder sent " + when + " at " + (r.time_of_day || "17:00")
        }).join("\n")

        const resp = await withRetry(
            () => ai().responses.create({
                model: MODELS.fast,
                instructions: INSTRUCTIONS,
                input: `Assignment: "${title}"${className ? "\nClass: " + className : ""}${dueDate ? "\nDue: " + dueDate : ""}\n\nWrite one line for each of these reminders, in order:\n${lines}`,
            }),
            { label: "reminder-text", tries: 2 }
        )

        let messages = fallback
        try {
            const t = String(resp.output_text || "").trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "")
            const a = t.indexOf("{"), b = t.lastIndexOf("}")
            const obj = JSON.parse(t.slice(a, b + 1))
            if (Array.isArray(obj.messages) && obj.messages.length) {
                messages = reminders.map((_, i) => String(obj.messages[i] || fallback[i]).slice(0, 140))
            }
        } catch (e) { /* keep fallback */ }

        return res.status(200).json({ messages })
    } catch (err) {
        console.error("reminder-text error:", err)
        return res.status(200).json({ messages: fallback })
    }
}
