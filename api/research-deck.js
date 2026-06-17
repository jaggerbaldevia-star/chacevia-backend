// api/research-deck.js
//
// Chacevia's "Research Deck", at:  /api/research-deck
// Researches a topic (web search + citations), builds a speech-style deck with
// luxury Unsplash photos, and a Sources & Credits slide.
//
// Speed-tuned to finish under the 60s serverless limit:
//   - ONE combined AI call (research + structure together)
//   - photos downloaded in PARALLEL, capped, and size-limited

import OpenAI from "openai"
import { createRequire } from "module"
const require = createRequire(import.meta.url)
const pptxgen = require("pptxgenjs")

// Give this function the full 60s the Hobby plan allows.
export const config = { maxDuration: 60 }

const MAX_INPUT_LENGTH = 3000
const DEFAULT_MODEL = "gpt-5.5"
const MAX_PHOTOS = 4

function setCorsHeaders(res) {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type")
}

const SPEECH_INSTRUCTIONS = `You are Chacevia's speech & presentation director for students.

Research the topic using the web, then build a compelling, well-supported speech presentation. Return ONLY valid JSON — no markdown, no backticks, no commentary — matching exactly:

{
  "deckTitle": "Striking title (max 7 words)",
  "subtitle": "One-line thesis",
  "slides": [
    { "heading": "Slide heading (max 6 words)", "bullets": ["short point", "short point", "short point"], "imageQuery": "1-3 words for a fitting photo", "notes": "one sentence the speaker can say" }
  ]
}

Rules:
- Exactly 6 slides, ordered like a speech: a hook, the thesis, three evidence points grounded in real facts/statistics you found, and a closing call to action.
- 3 to 4 bullets per slide, each under 14 words, concrete and accurate.
- "imageQuery": 1-3 words describing a premium, evocative, relevant photo (real-world imagery, not text/charts).
- "notes": a natural sentence the student could say out loud.
- No filler, no cheesy language. Clear, intelligent, persuasive.`

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

function parseDeckJson(text) {
    let t = String(text || "").trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "")
    const first = t.indexOf("{")
    const last = t.lastIndexOf("}")
    if (first === -1 || last === -1) throw new Error("No JSON found")
    return JSON.parse(t.slice(first, last + 1))
}

async function fetchUnsplash(query, key) {
    try {
        const url =
            "https://api.unsplash.com/search/photos?per_page=1&orientation=landscape&content_filter=high&query=" +
            encodeURIComponent(query)
        const r = await fetch(url, { headers: { Authorization: "Client-ID " + key } })
        if (!r.ok) return null
        const j = await r.json()
        const photo = j.results && j.results[0]
        if (!photo) return null
        const base = photo.urls && (photo.urls.raw || photo.urls.regular || photo.urls.small)
        if (!base) return null
        // Ask Unsplash for a modest, fast-loading size.
        const imgUrl = photo.urls.raw ? base + "&w=1100&q=70&fm=jpg&fit=crop" : base
        const ir = await fetch(imgUrl)
        if (!ir.ok) return null
        const buf = Buffer.from(await ir.arrayBuffer())
        return {
            data: "image/jpeg;base64," + buf.toString("base64"),
            credit: (photo.user && photo.user.name) || "Unsplash",
        }
    } catch (e) {
        return null
    }
}

function buildDeck(data, sources, photoCredits) {
    const BG = "0F0E0D"
    const INK = "F6F1EA"
    const SOFT = "9A938B"
    const ACCENT = "FFFFFF"

    const pptx = new pptxgen()
    pptx.layout = "LAYOUT_WIDE"
    pptx.defineSlideMaster({ title: "CHACEVIA", background: { color: BG } })

    const title = pptx.addSlide({ masterName: "CHACEVIA" })
    title.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.25, h: 7.5, fill: { color: ACCENT } })
    title.addText("CHACEVIA", { x: 0.9, y: 0.7, w: 11, h: 0.4, fontFace: "Arial", fontSize: 12, bold: true, charSpacing: 6, color: SOFT })
    title.addText(String(data.deckTitle || "Presentation"), { x: 0.9, y: 2.6, w: 11.5, h: 2, fontFace: "Georgia", fontSize: 46, bold: true, color: INK })
    title.addText(String(data.subtitle || ""), { x: 0.9, y: 4.6, w: 11, h: 1, fontFace: "Arial", fontSize: 18, color: SOFT })

    const slides = Array.isArray(data.slides) ? data.slides : []
    slides.forEach((s, i) => {
        const slide = pptx.addSlide({ masterName: "CHACEVIA" })
        slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.25, h: 7.5, fill: { color: ACCENT } })
        const hasImg = s._img && s._img.data
        const textW = hasImg ? 6.6 : 11.8
        slide.addText(String(s.heading || ""), { x: 0.9, y: 0.7, w: textW, h: 1, fontFace: "Georgia", fontSize: 30, bold: true, color: INK })
        const bullets = Array.isArray(s.bullets) ? s.bullets : []
        slide.addText(
            bullets.map((b) => ({ text: String(b), options: { bullet: { code: "2022", indent: 16 }, color: INK } })),
            { x: 0.9, y: 2.0, w: textW, h: 4.4, fontFace: "Arial", fontSize: 18, lineSpacingMultiple: 1.3, valign: "top" }
        )
        if (hasImg) {
            slide.addImage({ data: s._img.data, x: 7.9, y: 1.5, w: 4.8, h: 3.6, rounding: true })
            if (s._img.credit) {
                slide.addText("Photo: " + s._img.credit + " / Unsplash", { x: 7.9, y: 5.15, w: 4.8, h: 0.3, fontFace: "Arial", fontSize: 9, color: SOFT, align: "right" })
            }
        }
        slide.addText(String(i + 2), { x: 12.4, y: 6.95, w: 0.6, h: 0.3, fontFace: "Arial", fontSize: 10, color: SOFT, align: "right" })
    })

    const src = pptx.addSlide({ masterName: "CHACEVIA" })
    src.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.25, h: 7.5, fill: { color: ACCENT } })
    src.addText("Sources & Credits", { x: 0.9, y: 0.7, w: 11.5, h: 0.9, fontFace: "Georgia", fontSize: 30, bold: true, color: INK })
    const lines = []
    sources.forEach((s, i) => lines.push("[" + (i + 1) + "]  " + s.title + " — " + s.url))
    if (photoCredits.length) {
        lines.push("")
        lines.push("Photos via Unsplash: " + photoCredits.join(", "))
    }
    if (!lines.length) lines.push("No external sources were used.")
    src.addText(lines.join("\n"), { x: 0.9, y: 1.8, w: 11.8, h: 5, fontFace: "Arial", fontSize: 12, color: SOFT, lineSpacingMultiple: 1.25, valign: "top" })

    return pptx.write({ outputType: "base64" })
}

export default async function handler(req, res) {
    setCorsHeaders(res)
    if (req.method === "OPTIONS") return res.status(204).end()
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed. Use POST." })

    let body = req.body
    if (typeof body === "string") {
        try { body = JSON.parse(body) } catch { return res.status(400).json({ error: "Request body must be valid JSON." }) }
    }
    const input = body && body.input
    if (typeof input !== "string" || input.trim().length === 0) {
        return res.status(400).json({ error: "Missing or invalid 'input'. It must be a non-empty string." })
    }
    if (input.length > MAX_INPUT_LENGTH) {
        return res.status(400).json({ error: `Input is too long (max ${MAX_INPUT_LENGTH}).` })
    }
    if (!process.env.OPENAI_API_KEY) {
        return res.status(500).json({ error: "Server is missing OPENAI_API_KEY." })
    }

    try {
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
        const model = process.env.OPENAI_MODEL || DEFAULT_MODEL
        const ask = `Research and build a speech presentation on this topic, using reputable sources (.gov, .edu, peer-reviewed, major news, established organizations): "${input}".`

        // ONE combined call: research with web search + return the deck JSON.
        let resp
        let sources = []
        try {
            resp = await openai.responses.create({
                model,
                tools: [{ type: "web_search" }],
                instructions: SPEECH_INSTRUCTIONS,
                input: ask,
            })
            sources = extractSources(resp)
        } catch (e) {
            // Fallback: no web tool (still builds, just without live citations).
            resp = await openai.responses.create({ model, instructions: SPEECH_INSTRUCTIONS, input: ask })
            sources = []
        }

        const data = parseDeckJson(resp.output_text)

        // Photos: download in parallel, capped and size-limited.
        const photoCredits = []
        const key = process.env.UNSPLASH_ACCESS_KEY
        if (key && Array.isArray(data.slides)) {
            const idxs = []
            for (let i = 0; i < data.slides.length && idxs.length < MAX_PHOTOS; i++) {
                if (data.slides[i].imageQuery) idxs.push(i)
            }
            const imgs = await Promise.all(idxs.map((i) => fetchUnsplash(data.slides[i].imageQuery, key)))
            idxs.forEach((i, k) => {
                const img = imgs[k]
                if (img) {
                    data.slides[i]._img = img
                    if (photoCredits.indexOf(img.credit) === -1) photoCredits.push(img.credit)
                }
            })
        }

        const base64 = await buildDeck(data, sources, photoCredits)
        const fileName =
            (data.deckTitle || "chacevia-speech").toString().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + ".pptx"

        return res.status(200).json({ file: base64, fileName })
    } catch (err) {
        console.error("Chacevia research-deck error:", err)
        return res.status(500).json({ error: "Something went wrong building the presentation. Please try again." })
    }
}
