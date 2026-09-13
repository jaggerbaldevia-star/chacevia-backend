// api/direction-pdf.js
// Turns a creative direction (already generated) into a polished, branded
// one-page "Creative Brief" PDF the user can download and share.
// No coins charged — this just formats text the user already paid to generate.

import { PDFDocument, StandardFonts, rgb } from "pdf-lib"

function setCorsHeaders(res) {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")
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

function stripMd(s) {
    return String(s || "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/^#+\s*/, "").trim()
}

export async function buildBriefPdf(idea, text) {
    const pdf = await PDFDocument.create()
    const reg = await pdf.embedFont(StandardFonts.Helvetica)
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
    const ital = await pdf.embedFont(StandardFonts.HelveticaOblique)
    const PW = 612, PH = 792, M = 58, maxW = PW - M * 2
    const INK = rgb(0.165, 0.149, 0.133), SOFT = rgb(0.49, 0.46, 0.42)
    const ACCENT = rgb(0.878, 0.478, 0.353) // Chacevia coral

    let page = pdf.addPage([PW, PH])
    let y = PH - M
    const ensure = (need) => { if (y - need < M + 24) { page = pdf.addPage([PW, PH]); y = PH - M } }
    const draw = (t, font, size, color, gap, indent) => {
        for (const ln of wrap(t, font, size, maxW - (indent || 0))) {
            ensure(size + 4)
            page.drawText(ln, { x: M + (indent || 0), y: y - size, size, font, color })
            y -= size + (gap || 4)
        }
    }

    // Header
    page.drawRectangle({ x: M, y: y - 3, width: 46, height: 4, color: ACCENT })
    y -= 20
    draw("CREATIVE BRIEF", bold, 10, SOFT, 10)
    draw(stripMd(idea) || "Your idea", bold, 22, INK, 12)
    page.drawLine({ start: { x: M, y }, end: { x: PW - M, y }, thickness: 1, color: rgb(0.85, 0.82, 0.77) })
    y -= 18

    // Body — parse the direction text
    const lines = String(text || "").split("\n")
    for (const raw of lines) {
        const s = raw.trim()
        if (!s) { y -= 6; continue }
        const isHeading = s.startsWith("#") || /^\*\*(.+?)\*\*:?$/.test(s)
        const isBullet = /^[-*•]\s+/.test(s)
        if (isHeading) {
            y -= 6
            draw(stripMd(s), bold, 13, INK, 6)
        } else if (isBullet) {
            ensure(14)
            page.drawText("•", { x: M + 4, y: y - 11, size: 11, font: reg, color: ACCENT })
            draw(stripMd(s.replace(/^[-*•]\s+/, "")), reg, 10.5, INK, 4, 18)
        } else {
            draw(stripMd(s), reg, 10.5, INK, 5)
        }
    }

    // Footer
    ensure(30)
    y = M + 8
    page.drawText("Made with Chacevia", { x: M, y, size: 9, font: ital, color: SOFT })

    const bytes = await pdf.save()
    return Buffer.from(bytes).toString("base64")
}

export default async function handler(req, res) {
    setCorsHeaders(res)
    if (req.method === "OPTIONS") return res.status(204).end()
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed. Use POST." })

    let body = req.body
    if (typeof body === "string") { try { body = JSON.parse(body) } catch { return res.status(400).json({ error: "Body must be valid JSON." }) } }
    const idea = body && body.idea
    const text = body && body.text
    if (!text) return res.status(400).json({ error: "Missing the direction text." })

    try {
        const file = await buildBriefPdf(idea, text)
        const fileName = (stripMd(idea) || "creative-brief").toString().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) + "-brief.pdf"
        return res.status(200).json({ file, fileName })
    } catch (err) {
        console.error("direction-pdf error:", err)
        return res.status(500).json({ error: "Couldn't build the brief PDF." })
    }
}
