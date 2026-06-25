// api/scan-answer.js
//
// Chacevia "Read & Write" — Study mode.
// POST { pdf: base64 }
//   - hands the PDF to the AI (reads text + page images)
//   - finds every question and answers it WITH a short explanation
//   - uses web search for factual questions
//   - returns the Q&A list + a downloadable study sheet PDF
//
// Built as a STUDY AID: it explains its reasoning and outputs a separate
// study sheet (not a filled-in copy of the original to hand in).

import OpenAI from "openai"
import { PDFDocument, StandardFonts, rgb } from "pdf-lib"

export const config = { maxDuration: 60 }
const DEFAULT_MODEL = "gpt-5.5"

function setCorsHeaders(res) {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type")
}

const INSTRUCTIONS = `You are Chacevia's study tutor. You are given a document — it may be a worksheet, quiz, study guide, reading, or list of questions.

Identify every question or prompt in it that calls for an answer. For EACH one, give:
- the correct answer,
- a short explanation of the reasoning or how you reached it (so the student learns), and
- "highlights": the most important phrases to remember, each colour-coded and annotated.

Use web search for factual, current, or reference questions to be accurate. Return ONLY valid JSON — no markdown, no backticks — matching exactly:

{ "items": [ {
  "question": "the question text",
  "answer": "the answer",
  "explanation": "1-3 sentences on why / how",
  "highlights": [ { "text": "exact phrase copied verbatim from the answer or explanation", "color": "green|blue|red|yellow", "note": "short tip: what this is and why it matters" } ]
} ] }

Highlight rules:
- "text" MUST be copied EXACTLY (verbatim) from this item's answer or explanation, so it can be found and highlighted.
- Use ONLY these four colours, by meaning:
  - "yellow" = a key term or vocabulary word
  - "green" = a core fact or definition to memorize
  - "blue" = a supporting detail, example, or step
  - "red" = a common mistake, exception, or critical "watch out"
- 1 to 3 highlights per item. Only highlight things that genuinely matter.
- "note" is a brief, helpful study tip explaining the highlight.

If the document has no answerable questions, return { "items": [] }. Be accurate; explanations and highlights should teach.`

function extractSources(resp) {
    const out = []
    const seen = new Set()
    const items = (resp && resp.output) || []
    for (const item of items) {
        const content = item && item.content
        if (!Array.isArray(content)) continue
        for (const block of content) {
            const anns = block && block.annotations
            if (!Array.isArray(anns)) continue
            for (const a of anns) {
                if (a && a.type === "url_citation" && a.url && !seen.has(a.url)) {
                    seen.add(a.url)
                    out.push({ title: a.title || a.url, url: a.url })
                }
            }
        }
    }
    return out.slice(0, 10)
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

async function buildStudySheet(items, sources) {
    const pdf = await PDFDocument.create()
    const reg = await pdf.embedFont(StandardFonts.Helvetica)
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
    const ital = await pdf.embedFont(StandardFonts.HelveticaOblique)
    const PW = 612, PH = 792, M = 56, maxW = PW - M * 2
    const INK = rgb(0.16, 0.145, 0.125), SOFT = rgb(0.46, 0.43, 0.4), RULE = rgb(0.82, 0.79, 0.74)
    const SWATCH = {
        green: rgb(0.5, 0.72, 0.45),
        blue: rgb(0.45, 0.72, 0.85),
        yellow: rgb(0.9, 0.82, 0.35),
        red: rgb(0.85, 0.42, 0.32),
    }

    let page = pdf.addPage([PW, PH]); let y = PH - M
    const ensure = (need) => { if (y - need < M) { page = pdf.addPage([PW, PH]); y = PH - M } }
    const line = (text, font, size, color, gap, indent) => {
        for (const ln of wrap(text, font, size, maxW - (indent || 0))) {
            ensure(size + 4)
            page.drawText(ln, { x: M + (indent || 0), y: y - size, size, font, color })
            y -= size + (gap || 4)
        }
    }
    const highlightLine = (h) => {
        ensure(14)
        const c = SWATCH[h.color] || SOFT
        page.drawRectangle({ x: M + 16, y: y - 9.5, width: 8, height: 8, color: c })
        const label = (h.text ? h.text + " — " : "") + (h.note || "")
        const lines = wrap(label, reg, 10, maxW - 32)
        lines.forEach((ln, li) => {
            ensure(13)
            page.drawText(ln, { x: M + 30, y: y - 9.5, size: 10, font: reg, color: INK })
            y -= li === lines.length - 1 ? 14 : 12
        })
    }

    line("STUDY SHEET", bold, 10, SOFT, 6)
    line("Questions, answers & explanations", bold, 20, INK, 12)
    ensure(2); page.drawLine({ start: { x: M, y }, end: { x: PW - M, y }, thickness: 1, color: RULE }); y -= 18

    items.forEach((it, i) => {
        ensure(60)
        line("Q" + (i + 1) + ".  " + (it.question || ""), bold, 12.5, INK, 6)
        line("Answer:  " + (it.answer || ""), reg, 11.5, INK, 4)
        if (it.explanation) line("Why:  " + it.explanation, ital, 10.5, SOFT, 4)
        if (Array.isArray(it.highlights) && it.highlights.length) {
            y -= 3
            it.highlights.forEach(highlightLine)
        }
        y -= 12; ensure(2)
        page.drawLine({ start: { x: M, y }, end: { x: PW - M, y }, thickness: 0.5, color: RULE }); y -= 16
    })

    if (sources && sources.length) {
        ensure(40)
        line("Sources", bold, 11, SOFT, 6)
        sources.forEach((s, i) => line("[" + (i + 1) + "] " + s.title + " — " + s.url, reg, 9.5, SOFT, 3))
    }

    const bytes = await pdf.save()
    return Buffer.from(bytes).toString("base64")
}

export { buildStudySheet }

export default async function handler(req, res) {
    setCorsHeaders(res)
    if (req.method === "OPTIONS") return res.status(204).end()
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed. Use POST." })

    let body = req.body
    if (typeof body === "string") {
        try { body = JSON.parse(body) } catch { return res.status(400).json({ error: "Body must be valid JSON." }) }
    }
    const pdfB64 = body && body.pdf
    if (typeof pdfB64 !== "string" || !pdfB64) return res.status(400).json({ error: "Missing PDF." })
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "Server is missing OPENAI_API_KEY." })

    try {
        const dataUri = pdfB64.startsWith("data:") ? pdfB64 : "data:application/pdf;base64," + pdfB64
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
        const model = process.env.OPENAI_MODEL || DEFAULT_MODEL

        const content = [
            { type: "input_file", filename: "document.pdf", file_data: dataUri },
            { type: "input_text", text: INSTRUCTIONS },
        ]

        let resp
        let sources = []
        try {
            resp = await openai.responses.create({
                model,
                tools: [{ type: "web_search" }],
                input: [{ role: "user", content }],
            })
            sources = extractSources(resp)
        } catch (e) {
            resp = await openai.responses.create({ model, input: [{ role: "user", content }] })
            sources = []
        }

        let parsed = { items: [] }
        try {
            let t = String(resp.output_text || "").trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "")
            const a = t.indexOf("{"), b = t.lastIndexOf("}")
            parsed = JSON.parse(t.slice(a, b + 1))
        } catch (e) {
            return res.status(502).json({ error: "Couldn't read the AI's response. Please try again." })
        }
        const items = Array.isArray(parsed.items) ? parsed.items : []

        if (!items.length) {
            return res.status(200).json({ items: [], sources, message: "I couldn't find any answerable questions in that PDF." })
        }

        const file = await buildStudySheet(items, sources)
        return res.status(200).json({ items, sources, file, fileName: "study-sheet.pdf" })
    } catch (err) {
        console.error("scan-answer error:", err)
        return res.status(500).json({ error: "Something went wrong reading that PDF. Please try again." })
    }
}
