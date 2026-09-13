// api/study-set.js
//
// Chacevia STUDY PIPELINE: lecture/voice recording → full study kit in one click.
//   1) transcribes the audio (Whisper)
//   2) one AI pass builds: organized notes + flashcards + a practice quiz
//   3) builds a downloadable Study Kit PDF (notes, flashcards, quiz, answer key)
// Costs 4 coins (charged only on success).

import OpenAI, { toFile } from "openai"
import { PDFDocument, StandardFonts, rgb } from "pdf-lib"
import { requireCoins, chargeAfter } from "./_coins.js"

export const config = { maxDuration: 60 }
const COIN_COST = 4
const DEFAULT_MODEL = "gpt-5.5"
const TRANSCRIBE_MODEL = "whisper-1"

function setCorsHeaders(res) {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")
}

const INSTRUCTIONS = `You are Chacevia's study coach. You get the transcript of a lecture, class, or study recording. Build a complete study kit from it.

Return ONLY valid JSON — no markdown, no backticks — matching exactly:

{
  "title": "short title for this study set (max 7 words)",
  "summary": "2-3 sentence overview of what the recording covered",
  "sections": [ { "heading": "topic heading", "points": ["clear, detailed note point"] } ],
  "flashcards": [ { "front": "term or question", "back": "concise answer/definition" } ],
  "quiz": [ { "question": "multiple-choice question", "choices": ["A", "B", "C", "D"], "answer": 0, "why": "one-sentence explanation of the correct answer" } ]
}

Rules:
- Notes: organize into logical sections; keep points concise but complete enough to study from alone.
- Flashcards: 8-12 cards covering the most testable terms/ideas. Front is short; back is 1-2 sentences max.
- Quiz: 5-7 questions, each with exactly 4 choices, exactly one correct. "answer" is the INDEX (0-3) of the correct choice. Mix difficulty. Wrong choices should be plausible.
- Everything must come from the transcript — don't invent content that wasn't covered.
- Write for a student reviewing for a test: clear, direct, no filler.`

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

export async function buildStudyKitPdf(data) {
    const pdf = await PDFDocument.create()
    const reg = await pdf.embedFont(StandardFonts.Helvetica)
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
    const ital = await pdf.embedFont(StandardFonts.HelveticaOblique)
    const PW = 612, PH = 792, M = 56, maxW = PW - M * 2
    const INK = rgb(0.165, 0.149, 0.133), SOFT = rgb(0.49, 0.46, 0.42), RULE = rgb(0.85, 0.82, 0.77)
    const ACCENT = rgb(0.878, 0.478, 0.353)

    let page = pdf.addPage([PW, PH])
    let y = PH - M
    const ensure = (need) => { if (y - need < M + 20) { page = pdf.addPage([PW, PH]); y = PH - M } }
    const draw = (t, font, size, color, gap, indent) => {
        for (const ln of wrap(t, font, size, maxW - (indent || 0))) {
            ensure(size + 4)
            page.drawText(ln, { x: M + (indent || 0), y: y - size, size, font, color })
            y -= size + (gap || 4)
        }
    }
    const rule = () => { ensure(4); page.drawLine({ start: { x: M, y }, end: { x: PW - M, y }, thickness: 1, color: RULE }); y -= 16 }
    const sectionHead = (t) => { ensure(46); y -= 8; page.drawRectangle({ x: M, y: y - 3, width: 38, height: 4, color: ACCENT }); y -= 16; draw(t, bold, 15, INK, 10) }

    // Cover-ish header
    page.drawRectangle({ x: M, y: y - 3, width: 46, height: 4, color: ACCENT })
    y -= 20
    draw("STUDY KIT", bold, 10, SOFT, 8)
    draw(String(data.title || "Study set"), bold, 22, INK, 8)
    if (data.summary) draw(String(data.summary), ital, 11.5, SOFT, 10)
    rule()

    // 1) Notes
    sectionHead("Notes")
    ;(Array.isArray(data.sections) ? data.sections : []).forEach((s) => {
        ensure(34)
        draw(String(s.heading || ""), bold, 12.5, INK, 5)
        ;(Array.isArray(s.points) ? s.points : []).forEach((p) => {
            ensure(14)
            page.drawText("•", { x: M + 2, y: y - 11, size: 11, font: reg, color: ACCENT })
            draw(String(p), reg, 10.5, INK, 4, 16)
        })
        y -= 6
    })

    // 2) Flashcards
    const cards = Array.isArray(data.flashcards) ? data.flashcards : []
    if (cards.length) {
        sectionHead("Flashcards")
        draw("Cover the right column and quiz yourself.", ital, 9.5, SOFT, 8)
        cards.forEach((c, i) => {
            ensure(30)
            draw((i + 1) + ".  " + String(c.front || ""), bold, 10.5, INK, 3)
            draw(String(c.back || ""), reg, 10, rgb(0.3, 0.28, 0.25), 8, 18)
        })
    }

    // 3) Quiz
    const quiz = Array.isArray(data.quiz) ? data.quiz : []
    if (quiz.length) {
        sectionHead("Practice quiz")
        const letters = ["A", "B", "C", "D"]
        quiz.forEach((q, i) => {
            ensure(60)
            draw((i + 1) + ".  " + String(q.question || ""), bold, 10.5, INK, 5)
            ;(Array.isArray(q.choices) ? q.choices : []).forEach((ch, k) => {
                draw(letters[k] + ")  " + String(ch), reg, 10, INK, 3, 18)
            })
            y -= 6
        })

        // 4) Answer key — on its own page so it isn't spoiled
        page = pdf.addPage([PW, PH]); y = PH - M
        sectionHead("Answer key")
        quiz.forEach((q, i) => {
            ensure(26)
            const idx = typeof q.answer === "number" ? q.answer : 0
            draw((i + 1) + ".  " + letters[idx] + "  —  " + String((q.choices && q.choices[idx]) || ""), bold, 10.5, INK, 3)
            if (q.why) draw(String(q.why), ital, 9.5, SOFT, 8, 18)
        })
    }

    // Footer on last page
    page.drawText("Made with Chacevia", { x: M, y: M - 18, size: 9, font: ital, color: SOFT })

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
    const filename = (body && body.filename) || "lecture.m4a"
    if (typeof audioB64 !== "string" || !audioB64) return res.status(400).json({ error: "Missing audio." })
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "Server is missing OPENAI_API_KEY." })

    try {
        const guard = await requireCoins(req, body, COIN_COST)
        if (!guard.ok) return res.status(guard.status).json(guard.payload)

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
            return res.status(502).json({ error: "Couldn't transcribe that audio. Use a voice recording (.m4a, .mp3, .wav) under ~3MB." })
        }
        if (!transcript.trim()) {
            return res.status(200).json({ empty: true, error: "I couldn't hear any speech in that recording.", coins: guard.balance })
        }

        // 2) Build the full study kit in one pass
        const resp = await openai.responses.create({
            model,
            instructions: INSTRUCTIONS,
            input: "Transcript:\n" + transcript,
        })
        let data
        try { data = extractParsed(resp.output_text) } catch (e) {
            return res.status(502).json({ error: "Couldn't build the study set. Please try again." })
        }

        // 3) PDF
        const fileB64 = await buildStudyKitPdf(data)
        const fileName = (data.title || "study-kit").toString().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) + "-study-kit.pdf"

        const coins = await chargeAfter(guard)
        return res.status(200).json({
            title: data.title || "Study set",
            summary: data.summary || "",
            sections: Array.isArray(data.sections) ? data.sections : [],
            flashcards: Array.isArray(data.flashcards) ? data.flashcards : [],
            quiz: Array.isArray(data.quiz) ? data.quiz : [],
            file: fileB64,
            fileName,
            coins,
        })
    } catch (err) {
        console.error("study-set error:", err)
        return res.status(500).json({ error: "Something went wrong building that study set. Please try again." })
    }
}
