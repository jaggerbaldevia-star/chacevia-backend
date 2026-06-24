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

Research the topic using the web, then design a striking, gallery-quality speech presentation. Return ONLY valid JSON — no markdown, no backticks, no commentary — matching exactly:

{
  "deckTitle": "Bold title (max 6 words)",
  "subtitle": "One-line thesis",
  "coverQuery": "1-3 words for a dramatic cover photo",
  "slides": [
    {
      "kicker": "2-3 word label, e.g. THE PROBLEM",
      "heading": "Punchy heading (max 5 words)",
      "bullets": ["tight point under 10 words", "tight point under 10 words"],
      "imageQuery": "1-3 words for a fitting photo",
      "stat": "optional single striking figure, e.g. 70% or 1 in 3",
      "statLabel": "optional 4-8 word caption for the stat",
      "notes": "one sentence the speaker can say out loud",
      "delivery": "one short delivery tip: a hand gesture or eye-contact cue",
      "movement": "optional short stage-movement cue, or empty string"
    }
  ]
}

Rules:
- Exactly 6 slides, ordered like a speech: a hook, the thesis, three evidence points grounded in real facts/statistics you found, and a closing call to action.
- 2 to 3 bullets per slide, each under 10 words (they overlay photography, so keep them short and punchy).
- Put "stat"/"statLabel" on EXACTLY ONE evidence slide, where a single number lands hardest. Omit them on the others.
- "imageQuery"/"coverQuery": evocative real-world photography (no charts, no text in image).
- "kicker": a short label in caps (e.g., "THE PROBLEM", "WHY IT MATTERS", "THE ASK").
- "delivery": always a concrete, specific coaching tip under 14 words (e.g., "Open your palms on 'together'; hold one person's eyes per point").
- "movement": include only when it genuinely helps (e.g., "Step toward the audience on the call to action"); otherwise an empty string "".
- Accurate, intelligent, persuasive. No filler, no cheesy language.`

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
            url: imgUrl,
            credit: (photo.user && photo.user.name) || "Unsplash",
        }
    } catch (e) {
        return null
    }
}

// ---- Art direction tokens ----
const BG = "0E0D0C"
const INK = "F7F3EC"
const SOFT = "B7B0A6"
const SCRIM = "0B0A09"
const SERIF = "Georgia"
const SANS = "Arial"
const W = 13.333
const H = 7.5
const TSHADOW = { type: "outer", color: "000000", blur: 5, offset: 2, angle: 90, opacity: 0.55 }

function rect(pptx, slide, x, y, w, h, color, transparency) {
    slide.addShape(pptx.ShapeType.rect, { x, y, w, h, fill: { color, transparency }, line: { type: "none" } })
}
function cover(slide, img) {
    slide.addImage({ data: img.data, x: 0, y: 0, w: W, h: H, sizing: { type: "cover", w: W, h: H } })
}
function credit(slide, img, x, y) {
    if (img && img.credit) {
        slide.addText("Photo: " + img.credit + " / Unsplash", { x, y, w: 4, h: 0.3, fontFace: SANS, fontSize: 8.5, color: "FFFFFF", transparency: 25, align: "left" })
    }
}
function wordmark(slide, x, y, color) {
    slide.addText("CHACEVIA", { x, y, w: 5, h: 0.4, fontFace: SANS, fontSize: 11, bold: true, charSpacing: 6, color: color || INK })
}
function kickerHead(slide, x, y, w, s, headSize, white) {
    const col = white ? INK : INK
    if (s.kicker) slide.addText(String(s.kicker).toUpperCase(), { x, y, w, h: 0.4, fontFace: SANS, fontSize: 12.5, bold: true, charSpacing: 3, color: col, transparency: 15, shadow: white ? TSHADOW : undefined })
    slide.addText(String(s.heading || ""), { x, y: y + 0.45, w, h: 1.4, fontFace: SERIF, fontSize: headSize, bold: true, color: INK, shadow: white ? TSHADOW : undefined, lineSpacingMultiple: 1.0 })
}
function bulletsBox(slide, x, y, w, h, bullets, size, white) {
    if (!bullets.length) return
    slide.addText(
        bullets.map((b) => ({ text: String(b), options: { bullet: { code: "2022", indent: 14 } } })),
        { x, y, w, h, fontFace: SANS, fontSize: size, color: INK, lineSpacingMultiple: 1.28, valign: "top", shadow: white ? TSHADOW : undefined }
    )
}

function buildDeck(data, sources, photoCredits, coverImg) {
    const pptx = new pptxgen()
    pptx.layout = "LAYOUT_WIDE"
    pptx.defineSlideMaster({ title: "CHACEVIA", background: { color: BG } })
    const add = () => pptx.addSlide({ masterName: "CHACEVIA" })

    // ---------- COVER ----------
    const c = add()
    if (coverImg) {
        cover(c, coverImg)
        rect(pptx, c, 0, 0, W, H, SCRIM, 38)
        rect(pptx, c, 0, 3.6, W, 3.9, SCRIM, 12)
        credit(c, coverImg, 0.9, 7.05)
    }
    wordmark(c, 0.9, 0.7, INK)
    rect(pptx, c, 0.92, 4.5, 0.7, 0.05, "FFFFFF", 20)
    c.addText(String(data.deckTitle || "Presentation"), { x: 0.9, y: 4.7, w: 11.4, h: 2, fontFace: SERIF, fontSize: 54, bold: true, color: INK, shadow: coverImg ? TSHADOW : undefined, lineSpacingMultiple: 1.0 })
    c.addText(String(data.subtitle || ""), { x: 0.92, y: 6.5, w: 11, h: 0.7, fontFace: SANS, fontSize: 18, color: INK, transparency: 10, shadow: coverImg ? TSHADOW : undefined })

    // ---------- CONTENT ----------
    const slides = Array.isArray(data.slides) ? data.slides : []
    slides.forEach((s, i) => {
        const slide = add()
        const img = s._img && s._img.data ? s._img : null
        const bullets = Array.isArray(s.bullets) ? s.bullets : []
        const isLast = i === slides.length - 1
        const num = String(i + 2).padStart(2, "0")

        if (isLast) {
            // ---- CLOSING (full-bleed, centered) ----
            const bg = img || coverImg
            if (bg) { cover(slide, bg); rect(pptx, slide, 0, 0, W, H, SCRIM, 30); credit(slide, bg, 0.9, 7.05) }
            if (s.kicker) slide.addText(String(s.kicker).toUpperCase(), { x: 1, y: 2.5, w: 11.33, h: 0.5, align: "center", fontFace: SANS, fontSize: 13, bold: true, charSpacing: 4, color: INK, transparency: 10, shadow: bg ? TSHADOW : undefined })
            slide.addText(String(s.heading || ""), { x: 1, y: 3.0, w: 11.33, h: 1.8, align: "center", fontFace: SERIF, fontSize: 48, bold: true, color: INK, shadow: bg ? TSHADOW : undefined })
            if (bullets[0]) slide.addText(String(bullets[0]), { x: 2, y: 4.8, w: 9.33, h: 0.8, align: "center", fontFace: SANS, fontSize: 18, color: INK, transparency: 8, shadow: bg ? TSHADOW : undefined })
            return
        }

        if (s.stat) {
            // ---- BIG STAT ----
            if (img) { cover(slide, img); rect(pptx, slide, 0, 0, W, H, SCRIM, 20); credit(slide, img, 0.9, 7.05) }
            if (s.kicker) slide.addText(String(s.kicker).toUpperCase(), { x: 0.9, y: 1.2, w: 11, h: 0.5, fontFace: SANS, fontSize: 13, bold: true, charSpacing: 4, color: INK, transparency: 12, shadow: img ? TSHADOW : undefined })
            slide.addText(String(s.stat), { x: 0.85, y: 2.0, w: 11.5, h: 2.6, fontFace: SERIF, fontSize: 150, bold: true, color: INK, shadow: img ? TSHADOW : undefined })
            slide.addText(String(s.statLabel || s.heading || ""), { x: 0.95, y: 4.9, w: 9, h: 1, fontFace: SANS, fontSize: 22, color: INK, transparency: 6, shadow: img ? TSHADOW : undefined })
            slide.addText(num, { x: 12.4, y: 6.95, w: 0.6, h: 0.3, fontFace: SANS, fontSize: 10, color: INK, transparency: 30, align: "right" })
            return
        }

        if (!img) {
            // ---- DARK STATEMENT (no photo) ----
            rect(pptx, slide, 0.9, 1.3, 0.7, 0.05, "FFFFFF", 25)
            kickerHead(slide, 0.9, 1.6, 11.4, s, 46, false)
            bulletsBox(slide, 0.95, 4.4, 10.5, 2.6, bullets, 20, false)
            slide.addText(num, { x: 12.4, y: 6.95, w: 0.6, h: 0.3, fontFace: SANS, fontSize: 10, color: SOFT, align: "right" })
            return
        }

        if (i % 2 === 1) {
            // ---- SPLIT (image one side, text the other) ----
            const imageLeft = i % 4 === 1
            const ix = imageLeft ? 0 : 7.0
            const tx = imageLeft ? 7.0 : 0.9
            slide.addImage({ data: img.data, x: ix, y: 0, w: 6.33, h: H, sizing: { type: "cover", w: 6.33, h: H } })
            rect(pptx, slide, ix, 0, 6.33, H, SCRIM, 55)
            kickerHead(slide, tx, 1.5, 5.4, s, 32, false)
            bulletsBox(slide, tx + 0.03, 3.7, 5.3, 3, bullets, 17, false)
            credit(slide, img, ix + 0.3, 7.05)
            slide.addText(num, { x: imageLeft ? 12.4 : 6.0, y: 6.95, w: 0.6, h: 0.3, fontFace: SANS, fontSize: 10, color: SOFT, align: "right" })
            return
        }

        // ---- FULL-BLEED (image + overlaid text, bottom-anchored) ----
        cover(slide, img)
        rect(pptx, slide, 0, 0, W, H, SCRIM, 42)
        rect(pptx, slide, 0, 3.4, W, 4.1, SCRIM, 14)
        kickerHead(slide, 0.9, 3.7, 11.4, s, 40, true)
        bulletsBox(slide, 0.95, 5.7, 8.5, 1.6, bullets, 17, true)
        credit(slide, img, 0.9, 7.08)
        slide.addText(num, { x: 12.4, y: 0.6, w: 0.6, h: 0.3, fontFace: SANS, fontSize: 10, color: INK, transparency: 25, align: "right" })
    })

    // ---------- SOURCES ----------
    const src = add()
    rect(pptx, src, 0, 0, 0.18, H, "FFFFFF", 0)
    src.addText("Sources & Credits", { x: 0.9, y: 0.8, w: 11.5, h: 0.9, fontFace: SERIF, fontSize: 30, bold: true, color: INK })
    const lines = []
    sources.forEach((s, i) => lines.push("[" + (i + 1) + "]  " + s.title + " — " + s.url))
    if (photoCredits.length) { lines.push(""); lines.push("Photography via Unsplash: " + photoCredits.join(", ")) }
    if (!lines.length) lines.push("No external sources were used.")
    src.addText(lines.join("\n"), { x: 0.9, y: 2.0, w: 11.8, h: 5, fontFace: SANS, fontSize: 12, color: SOFT, lineSpacingMultiple: 1.3, valign: "top" })

    return pptx.write({ outputType: "base64" })
}

export { buildDeck }

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

        // Photos: download cover + slide images in parallel, capped and size-limited.
        const photoCredits = []
        let coverImg = null
        const key = process.env.UNSPLASH_ACCESS_KEY
        if (key && Array.isArray(data.slides)) {
            const jobs = []
            jobs.push({ key: "cover", q: data.coverQuery || (data.slides[0] && data.slides[0].imageQuery) || data.deckTitle })
            for (let i = 0; i < data.slides.length && jobs.length <= MAX_PHOTOS; i++) {
                if (data.slides[i].imageQuery) jobs.push({ key: i, q: data.slides[i].imageQuery })
            }
            const imgs = await Promise.all(jobs.map((j) => fetchUnsplash(j.q, key)))
            imgs.forEach((img, n) => {
                if (!img) return
                const j = jobs[n]
                if (j.key === "cover") coverImg = img
                else data.slides[j.key]._img = img
                if (photoCredits.indexOf(img.credit) === -1) photoCredits.push(img.credit)
            })
        }

        const base64 = await buildDeck(data, sources, photoCredits, coverImg)
        const fileName =
            (data.deckTitle || "chacevia-speech").toString().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + ".pptx"

        // Presenter coaching cards — one per slide, for the "help me present" feature.
        const cards = (Array.isArray(data.slides) ? data.slides : []).map((s, i) => ({
            n: i + 1,
            title: String(s.heading || ""),
            subtitle: String(s.kicker || ""),
            points: Array.isArray(s.bullets) ? s.bullets.map(String) : [],
            say: String(s.notes || ""),
            delivery: String(s.delivery || ""),
            movement: String(s.movement || ""),
        }))

        // Lightweight preview that mirrors the deck's layouts (uses photo URLs, not base64).
        const n = Array.isArray(data.slides) ? data.slides.length : 0
        const layoutFor = (i, s) => {
            if (i === n - 1) return "closing"
            if (s.stat) return "stat"
            if (!s._img) return "statement"
            if (i % 2 === 1) return "split"
            return "fullbleed"
        }
        const preview = {
            cover: {
                image: coverImg ? coverImg.url : null,
                deckTitle: String(data.deckTitle || ""),
                subtitle: String(data.subtitle || ""),
                credit: coverImg ? coverImg.credit : "",
            },
            slides: (Array.isArray(data.slides) ? data.slides : []).map((s, i) => {
                const layout = layoutFor(i, s)
                const img = s._img || (layout === "closing" ? coverImg : null)
                return {
                    layout,
                    kicker: String(s.kicker || ""),
                    heading: String(s.heading || ""),
                    bullets: Array.isArray(s.bullets) ? s.bullets.map(String) : [],
                    stat: String(s.stat || ""),
                    statLabel: String(s.statLabel || ""),
                    image: img ? img.url : null,
                    credit: img ? img.credit : "",
                    imageLeft: layout === "split" ? i % 4 === 1 : false,
                }
            }),
        }

        return res.status(200).json({ file: base64, fileName, deckTitle: String(data.deckTitle || ""), cards, preview })
    } catch (err) {
        console.error("Chacevia research-deck error:", err)
        return res.status(500).json({ error: "Something went wrong building the presentation. Please try again." })
    }
}
