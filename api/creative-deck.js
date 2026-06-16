// api/creative-deck.js
//
// Third endpoint for Chacevia, living at:  /api/creative-deck
//
// Two stages:
//   1. Ask OpenAI to write structured slide content (clean JSON).
//   2. Render that into a REAL .pptx file with pptxgenjs.
//
// Returns the file as base64 so Framer can trigger a download. The user can
// then open and edit it in PowerPoint, Google Slides, Keynote, or Canva.

import OpenAI from "openai"
// pptxgenjs ships an ES-module build that conflicts with this project's module
// setup on Vercel. Loading it through createRequire forces its CommonJS build,
// which runs cleanly in the serverless environment.
import { createRequire } from "module"
const require = createRequire(import.meta.url)
const pptxgen = require("pptxgenjs")

const MAX_INPUT_LENGTH = 3000
const MAX_CONTEXT_LENGTH = 8000
const DEFAULT_MODEL = "gpt-5.5"
const BRAND_ORANGE = "ED6A2C"

function setCorsHeaders(res) {
    // Allow all origins for now. LATER: replace "*" with your Framer domain.
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type")
}

// Instructions that make Chacevia produce a clean, presentation-ready outline.
const DECK_INSTRUCTIONS = `You are Chacevia's creative director, turning an idea into a short, premium pitch/brand presentation.

Return ONLY valid JSON — no markdown, no backticks, no commentary. Match this exact shape:

{
  "deckTitle": "Short, striking title (max 6 words)",
  "subtitle": "One-line tagline",
  "accent": "#RRGGBB",
  "slides": [
    { "heading": "Slide heading (max 6 words)", "bullets": ["short point", "short point", "short point"] }
  ]
}

Rules:
- 6 to 8 slides.
- Each slide: 3 to 5 bullets, each bullet under 12 words, punchy and concrete.
- No filler, no cheesy startup language. Premium and specific.
- Pick a tasteful "accent" hex color that fits the concept.
- The deck should cover, in a sensible order: the concept, visual direction, color & type, audience, and a closing call to action.`

function isHex(s) {
    return typeof s === "string" && /^#?[0-9a-fA-F]{6}$/.test(s)
}
function cleanHex(s, fallback) {
    if (!isHex(s)) return fallback
    return s.replace("#", "").toUpperCase()
}

// Pull the JSON object out of the model's text, even if it adds stray text.
function parseDeckJson(text) {
    let t = text.trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "")
    const first = t.indexOf("{")
    const last = t.lastIndexOf("}")
    if (first === -1 || last === -1) throw new Error("No JSON found")
    return JSON.parse(t.slice(first, last + 1))
}

// Build the .pptx and return it as base64. Exported so it can be tested alone.
export async function buildDeck(data) {
    const accent = cleanHex(data.accent, BRAND_ORANGE)
    const BG = "FCF8F2" // warm white
    const INK = "2A2520" // warm near-black
    const SOFT = "6F665E" // muted

    const pptx = new pptxgen()
    pptx.layout = "LAYOUT_WIDE" // 13.33 x 7.5in, 16:9
    pptx.defineSlideMaster({
        title: "CHACEVIA",
        background: { color: BG },
    })

    // --- Title slide ---
    const title = pptx.addSlide({ masterName: "CHACEVIA" })
    title.addShape(pptx.ShapeType.rect, {
        x: 0, y: 0, w: 0.35, h: 7.5, fill: { color: accent },
    })
    title.addText("CHACEVIA", {
        x: 1, y: 0.7, w: 11, h: 0.4, fontFace: "Arial",
        fontSize: 12, bold: true, charSpacing: 6, color: accent,
    })
    title.addText(String(data.deckTitle || "Creative Direction"), {
        x: 1, y: 2.4, w: 11.3, h: 2, fontFace: "Georgia",
        fontSize: 48, bold: true, color: INK,
    })
    title.addText(String(data.subtitle || ""), {
        x: 1, y: 4.4, w: 11, h: 0.8, fontFace: "Arial",
        fontSize: 18, color: SOFT,
    })

    // --- Content slides ---
    const slides = Array.isArray(data.slides) ? data.slides : []
    slides.forEach((s, i) => {
        const slide = pptx.addSlide({ masterName: "CHACEVIA" })
        slide.addShape(pptx.ShapeType.rect, {
            x: 0, y: 0, w: 0.35, h: 7.5, fill: { color: accent },
        })
        slide.addText(String(s.heading || ""), {
            x: 1, y: 0.8, w: 11.3, h: 1, fontFace: "Georgia",
            fontSize: 32, bold: true, color: INK,
        })
        const bullets = Array.isArray(s.bullets) ? s.bullets : []
        slide.addText(
            bullets.map((b) => ({
                text: String(b),
                options: { bullet: { code: "2022", indent: 18 }, color: INK },
            })),
            {
                x: 1, y: 2.1, w: 11, h: 4.6, fontFace: "Arial",
                fontSize: 20, lineSpacingMultiple: 1.3, valign: "top",
            }
        )
        // page number + accent footer dot
        slide.addText(String(i + 2), {
            x: 12.4, y: 6.9, w: 0.6, h: 0.3, fontFace: "Arial",
            fontSize: 11, color: SOFT, align: "right",
        })
    })

    return await pptx.write({ outputType: "base64" })
}

export default async function handler(req, res) {
    setCorsHeaders(res)

    if (req.method === "OPTIONS") return res.status(204).end()
    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed. Use POST." })
    }

    let body = req.body
    if (typeof body === "string") {
        try {
            body = JSON.parse(body)
        } catch {
            return res.status(400).json({ error: "Request body must be valid JSON." })
        }
    }

    const input = body && body.input
    const context = (body && body.context) || ""

    if (typeof input !== "string" || input.trim().length === 0) {
        return res
            .status(400)
            .json({ error: "Missing or invalid 'input'. It must be a non-empty string." })
    }
    if (input.length > MAX_INPUT_LENGTH) {
        return res.status(400).json({ error: `Input is too long (max ${MAX_INPUT_LENGTH}).` })
    }
    if (typeof context === "string" && context.length > MAX_CONTEXT_LENGTH) {
        return res.status(400).json({ error: "Context is too long." })
    }

    if (!process.env.OPENAI_API_KEY) {
        return res
            .status(500)
            .json({ error: "Server is missing OPENAI_API_KEY. Set it in your Vercel settings." })
    }

    try {
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
        const model = process.env.OPENAI_MODEL || DEFAULT_MODEL

        const userText = context
            ? `Idea: ${input}\n\nCreative direction to base the deck on:\n${context}`
            : `Idea: ${input}`

        const response = await openai.responses.create({
            model,
            instructions: DECK_INSTRUCTIONS,
            input: userText,
        })

        const raw = response.output_text || ""
        let data
        try {
            data = parseDeckJson(raw)
        } catch (e) {
            return res
                .status(502)
                .json({ error: "Couldn't build the slide outline. Please try again." })
        }

        const base64 = await buildDeck(data)
        const fileName =
            (data.deckTitle || "chacevia-deck").toString().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + ".pptx"

        return res.status(200).json({ file: base64, fileName })
    } catch (err) {
        console.error("Chacevia creative-deck error:", err)
        return res
            .status(500)
            .json({ error: "Something went wrong building the presentation. Please try again." })
    }
}
