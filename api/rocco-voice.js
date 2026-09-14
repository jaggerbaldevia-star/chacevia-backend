// api/rocco-voice.js
//
// Gives Rocco his voice. Takes text, returns spoken audio (mp3 as base64).
//
// The newer TTS model accepts plain-English tone instructions, which is how
// we get Rocco's "scratchy, soothing, a little goofy" delivery.
//
// No coin charge here: Rocco's chat already costs a coin, and speaking his
// reply is cheap — charging twice for one answer would feel unfair.

import OpenAI from "openai"

export const config = { maxDuration: 30 }

// Swap the voice without touching code by setting ROCCO_VOICE in Vercel.
// Raspier/characterful options to try: ash, ballad, echo, verse, sage, fable.
const VOICE = process.env.ROCCO_VOICE || "ash"
const TTS_MODEL = process.env.ROCCO_TTS_MODEL || "gpt-4o-mini-tts"
const FALLBACK_MODEL = "tts-1"

// Playback speed. 1.0 = normal. Raise for snappier, lower for slower.
// Override without touching code by setting ROCCO_SPEED in Vercel.
const SPEED = Math.min(2, Math.max(0.5, Number(process.env.ROCCO_SPEED) || 1.15))

const TONE = `Speak like a tiny, friendly cartoon creature named Rocco.

MOST IMPORTANT — the voice is RASPY. Really lean into it:
a rough, gravelly, scratchy texture on every word, like a small creature with a
permanently croaky little throat. Crackly and worn around the edges, the way a
voice sounds first thing in the morning or after cheering all day. Let the rasp
break slightly on longer words. Breathy and gruff rather than clean or smooth —
never a crisp, polished announcer voice.

Underneath the rasp: warm, soothing and kind. Slightly goofy and playful, with a
bounce on the fun words.

PACE: talk at a normal, lively conversational speed — the way a friend talks when
they're excited to tell you something. Keep it moving. Do NOT drag words out,
do NOT pause dramatically between sentences, and never sound sleepy or sluggish.
Snappy and upbeat, just cozy and a bit silly in character.`

const MAX_CHARS = 800

function setCorsHeaders(res) {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")
}

export default async function handler(req, res) {
    setCorsHeaders(res)
    if (req.method === "OPTIONS") return res.status(204).end()
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed. Use POST." })

    let body = req.body
    if (typeof body === "string") {
        try { body = JSON.parse(body) } catch { return res.status(400).json({ error: "Body must be valid JSON." }) }
    }
    const text = body && body.text
    if (typeof text !== "string" || !text.trim()) return res.status(400).json({ error: "Nothing for Rocco to say." })
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "Server is missing OPENAI_API_KEY." })

    const say = text.trim().slice(0, MAX_CHARS)

    try {
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

        let speech
        try {
            speech = await openai.audio.speech.create({
                model: TTS_MODEL,
                voice: VOICE,
                input: say,
                instructions: TONE,
                speed: SPEED,
                response_format: "mp3",
            })
        } catch (e) {
            // Older model doesn't support tone instructions — fall back plainly.
            console.error("tts primary failed, falling back:", e && e.message)
            speech = await openai.audio.speech.create({
                model: FALLBACK_MODEL,
                voice: VOICE,
                input: say,
                speed: SPEED,
                response_format: "mp3",
            })
        }

        const buf = Buffer.from(await speech.arrayBuffer())
        return res.status(200).json({ audio: buf.toString("base64"), format: "mp3" })
    } catch (err) {
        console.error("rocco-voice error:", err)
        return res.status(500).json({ error: "Rocco lost his voice for a second. Try again." })
    }
}
