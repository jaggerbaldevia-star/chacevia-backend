// api/voice-notes.js
//
// Chacevia "Voice Memo → Notes".
// POST { audio: base64 (data URI ok), filename }
//   - transcribes the audio (Whisper)
//   - turns the transcript into clean, detailed, organized notes
//   - color-codes key phrases with notes (same system as the study feature)
//   - returns the notes + a downloadable notes PDF
//
// Built for short voice memos (request size is capped by the host).

import OpenAI, { toFile } from "openai"
import { PDFDocument, StandardFonts, rgb } from "pdf-lib"

export const config = { maxDuration: 60 }
const DEFAULT_MODEL = "gpt-5.5"
const TRANSCRIBE_MODEL = "whisper-1"

function setCorsHeaders(res) {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type")
}

const INSTRUCTIONS = `You are Chacevia's note-taker. You are given a transcript of a spoken voice memo — it may be rambling, informal, or stream-of-consciousness. Turn it into clean, detailed, well-organized notes that capture everything important.

Return ONLY valid JSON — no markdown, no backticks — matching exactly:

{
  "title": "short title for the memo (max 7 words)",
  "summary": "1-2 sentence overview",
  "sections": [ { "heading": "section heading", "points": ["clear note point", "clear note point"] } ],
  "actions": ["any to-do, decision, or follow-up mentioned"],
  "highlights": [ { "text": "exact phrase copied verbatim from the summary or a point", "color": "green|blue|red|yellow", "note": "short tip: what this is and why it matters" } ]
}

Rules:
- Organize the content into logical sections with clear headings; keep points concise but detailed enough to be useful later.
- Put any tasks, decisions, deadlines, or follow-ups in "actions". Use [] if there are none.
- Highlights use ONLY these four colours, by meaning:
  - "yellow" = a key term, name, or topic
  - "green" = an important fact or decision
  - "blue" = a supporting detail or example
  - "red" = a deadline, risk, or critical "don't forget"
- Highlight "text" MUST be copied EXACTLY from the summary or a point so it can be found. 2-5 highlights total.
- Stay faithful to what was actually said; don't invent content.`

function extractParsed(text) {
    let t = String(text || "").trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "")
    const a = t.indexOf("{"), b = t.lastIndexOf("}")
    return JSON.parse(t.slice(a, b + 1))
}

function wrap(text, font, size, maxW) {
    const words = String(text || "").split(/\s+/).filter(Boolean)
    const lines = []
    let line = ""
    for (const w of words) {
        const test = line ? line + " " + w : w
        if (font.widthOfTextAtSize(test, size) > maxW && line) { lines.push(line); line = w }
        else line = test
    }
    if (line) lines.push(line)
    return lines.length ? lines : [""]
}

export async function buildNotesPdf(data) {
    const pdf = await PDFDocument.create()
    const reg = await pdf.embedFont(StandardFonts.Helvetica)
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
    const ital = await pdf.embedFont(StandardFonts.HelveticaOblique)
    const PW = 612, PH = 792, M = 56, maxW = PW - M * 2
    const INK = rgb(0.16, 0.145, 0.125), SOFT = rgb(0.46, 0.43, 0.4), RULE = rgb(0.82, 0.79, 0.74)
    const SWATCH = { green: rgb(0.5, 0.72, 0.45), blue: rgb(0.45, 0.72, 0.85), yellow: rgb(0.9, 0.82, 0.35), red: rgb(0.85, 0.42, 0.32) }

    let page = pdf.addPage([PW, PH]); let y = PH - M
    const ensure = (need) => { if (y - need < M) { page = pdf.addPage([PW, PH]); y = PH - M } }
    const line = (text, font, size, color, gap, indent) => {
        for (const ln of wrap(text, font, size, maxW - (indent || 0))) {
            ensure(size + 4)
            page.drawText(ln, { x: M + (indent || 0), y: y - size, size, font, color })
            y -= size + (gap || 4)
        }
    }

    line("VOICE NOTES", bold, 10, SOFT, 6)
    line(String(data.title || "Notes"), bold, 22, INK, 8)
    if (data.summary) line(String(data.summary), ital, 12, SOFT, 10)
    ensure(2); page.drawLine({ start: { x: M, y }, end: { x: PW - M, y }, thickness: 1, color: RULE }); y -= 16

    ;(Array.isArray(data.sections) ? data.sections : []).forEach((s) => {
        ensure(40)
        line(String(s.heading || ""), bold, 14, INK, 6)
        ;(Array.isArray(s.points) ? s.points : []).forEach((p) => {
            ensure(14)
            page.drawText("•", { x: M, y: y - 11, size: 11, font: reg, color: INK })
            line(String(p), reg, 11, INK, 4, 16)
        })
        y -= 8
    })

    if (Array.isArray(data.actions) && data.actions.length) {
        ensure(30)
        line("Action items", bold, 13, INK, 6)
        data.actions.forEach((p) => {
            ensure(14)
            page.drawRectangle({ x: M, y: y - 11, width: 8, height: 8, borderColor: INK, borderWidth: 0.9 })
            line(String(p), reg, 11, INK, 4, 16)
        })
        y -= 8
    }

    if (Array.isArray(data.highlights) && data.highlights.length) {
        ensure(30)
        line("Highlights", bold, 13, INK, 6)
        data.highlights.forEach((h) => {
            ensure(14)
            const c = SWATCH[h.color] || SOFT
            page.drawRectangle({ x: M + 2, y: y - 9.5, width: 8, height: 8, color: c })
            const label = (h.text ? h.text + " — " : "") + (h.note || "")
            wrap(label, reg, 10, maxW - 18).forEach((ln, li, arr) => {
                ensure(13)
                page.drawText(ln, { x: M + 16, y: y - 9.5, size: 10, font: reg, color: INK })
                y -= li === arr.length - 1 ? 14 : 12
            })
        })
    }

    const bytes = await pdf.save()
    return Buffer.from(bytes).toString("base64")
}

export default async function handler(req, res) {
    setCorsHeaders(res)
    if (req.method === "OPTIONS") return res.status(204).end()
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed. Use POST." })

    let body = req.body
    if (typeof body === "string") {
        try { body = JSON.parse(body) } catch { return res.status(400).json({ error: "Body must be valid JSON." }) }
    }
    const audioB64 = body && body.audio
    const filename = (body && body.filename) || "memo.m4a"
    if (typeof audioB64 !== "string" || !audioB64) return res.status(400).json({ error: "Missing audio." })
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "Server is missing OPENAI_API_KEY." })

    try {
        const clean = audioB64.replace(/^data:[^;]+;base64,/, "")
        const buffer = Buffer.from(clean, "base64")
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
        const model = process.env.OPENAI_MODEL || DEFAULT_MODEL

        // 1) Transcribe
        let transcript = ""
        try {
            const file = await toFile(buffer, filename)
            const tr = await openai.audio.transcriptions.create({ file, model: TRANSCRIBE_MODEL })
            transcript = (tr && tr.text) || ""
        } catch (e) {
            console.error("transcription error:", e)
            return res.status(502).json({ error: "Couldn't transcribe that audio. Make sure it's a voice memo (.m4a, .mp3, .wav) and not too long." })
        }
        if (!transcript.trim()) {
            return res.status(200).json({ empty: true, error: "I couldn't hear any speech in that recording." })
        }

        // 2) Structure into notes
        const resp = await openai.responses.create({
            model,
            instructions: INSTRUCTIONS,
            input: "Transcript:\n" + transcript,
        })
        let data
        try { data = extractParsed(resp.output_text) } catch (e) {
            return res.status(502).json({ error: "Couldn't organize the notes. Please try again." })
        }

        // 3) PDF
        const fileB64 = await buildNotesPdf(data)
        const fileName = (data.title || "voice-notes").toString().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + "-notes.pdf"

        return res.status(200).json({
            title: data.title || "Notes",
            summary: data.summary || "",
            sections: Array.isArray(data.sections) ? data.sections : [],
            actions: Array.isArray(data.actions) ? data.actions : [],
            highlights: Array.isArray(data.highlights) ? data.highlights : [],
            transcript,
            file: fileB64,
            fileName,
        })
    } catch (err) {
        console.error("voice-notes error:", err)
        return res.status(500).json({ error: "Something went wrong processing that memo. Please try again." })
    }
}
