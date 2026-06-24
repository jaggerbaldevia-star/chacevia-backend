// api/notes-pdf.js
//
// Turns the presenter note-cards into a clean, simple PDF.
// POST { deckTitle, cards: [{ n, title, subtitle, points[], say, delivery, movement }] }
// → { file: base64, fileName }

import { PDFDocument, StandardFonts, rgb } from "pdf-lib"

function setCorsHeaders(res) {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type")
}

// Wrap a string to a max width for the given font/size.
function wrap(text, font, size, maxW) {
    const words = String(text || "").split(/\s+/).filter(Boolean)
    const lines = []
    let line = ""
    for (const w of words) {
        const test = line ? line + " " + w : w
        if (font.widthOfTextAtSize(test, size) > maxW && line) {
            lines.push(line)
            line = w
        } else {
            line = test
        }
    }
    if (line) lines.push(line)
    return lines.length ? lines : [""]
}

export default async function handler(req, res) {
    setCorsHeaders(res)
    if (req.method === "OPTIONS") return res.status(204).end()
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed. Use POST." })

    let body = req.body
    if (typeof body === "string") {
        try { body = JSON.parse(body) } catch { return res.status(400).json({ error: "Body must be valid JSON." }) }
    }
    const cards = body && Array.isArray(body.cards) ? body.cards : null
    if (!cards || !cards.length) {
        return res.status(400).json({ error: "Missing 'cards' array." })
    }
    const deckTitle = (body && body.deckTitle) || "Presentation"

    try {
        const pdf = await PDFDocument.create()
        const reg = await pdf.embedFont(StandardFonts.Helvetica)
        const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
        const ital = await pdf.embedFont(StandardFonts.HelveticaOblique)

        const PW = 612, PH = 792 // US Letter
        const M = 56 // margin
        const maxW = PW - M * 2
        const INK = rgb(0.16, 0.145, 0.125)
        const SOFT = rgb(0.46, 0.43, 0.4)
        const RULE = rgb(0.82, 0.79, 0.74)

        let page = pdf.addPage([PW, PH])
        let y = PH - M

        const ensure = (need) => {
            if (y - need < M) {
                page = pdf.addPage([PW, PH])
                y = PH - M
            }
        }
        const line = (text, font, size, color, gap, indent) => {
            const lines = wrap(text, font, size, maxW - (indent || 0))
            for (const ln of lines) {
                ensure(size + 4)
                page.drawText(ln, { x: M + (indent || 0), y: y - size, size, font, color })
                y -= size + (gap || 4)
            }
        }

        // Header
        line("PRESENTER NOTES", bold, 10, SOFT, 6)
        line(String(deckTitle), bold, 22, INK, 10)
        ensure(2)
        page.drawLine({ start: { x: M, y: y }, end: { x: PW - M, y: y }, thickness: 1, color: RULE })
        y -= 18

        cards.forEach((c, i) => {
            ensure(70)
            // Card number + subtitle
            const tag = (c.subtitle ? String(c.subtitle).toUpperCase() + "  ·  " : "") + "CARD " + (c.n || i + 1)
            line(tag, bold, 9, SOFT, 5)
            // Title
            line(String(c.title || ""), bold, 16, INK, 8)
            // Points
            ;(Array.isArray(c.points) ? c.points : []).forEach((p) => {
                ensure(16)
                page.drawText("•", { x: M, y: y - 11, size: 11, font: reg, color: INK })
                line(String(p), reg, 11, INK, 4, 16)
            })
            // Say
            if (c.say) { y -= 2; line("Say:  " + c.say, ital, 10.5, SOFT, 4) }
            // Delivery
            if (c.delivery) line("Delivery:  " + c.delivery, reg, 10.5, INK, 4)
            // Movement
            if (c.movement) line("Move:  " + c.movement, reg, 10.5, INK, 4)
            y -= 14
            ensure(2)
            page.drawLine({ start: { x: M, y: y }, end: { x: PW - M, y: y }, thickness: 0.5, color: RULE })
            y -= 16
        })

        const bytes = await pdf.save()
        const base64 = Buffer.from(bytes).toString("base64")
        const fileName =
            String(deckTitle).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + "-presenter-notes.pdf"

        return res.status(200).json({ file: base64, fileName })
    } catch (err) {
        console.error("notes-pdf error:", err)
        return res.status(500).json({ error: "Couldn't build the PDF. Please try again." })
    }
}
