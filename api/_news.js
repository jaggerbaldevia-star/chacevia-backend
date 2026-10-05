// api/_news.js
//
// The Morning Paper's world news: fetched ONCE a day for everyone, stored in
// daily_news, and copied into each student's paper. Not an API route.
//
// Rules this file exists to enforce:
// - Never invented. Every story is a real item from a real source, and the
//   summary is written only from that item's own title and description. The
//   source is credited and linked.
// - Teen-safe only: science, space, animals, tech, nature, sports, music,
//   culture. No violence, crime, war, deaths, disasters, politics, or anything
//   graphic. A code-level word filter runs BEFORE the model sees a story and
//   again on what it writes, so a model mistake can't put one through.
// - Fewer than three safe stories means fewer stories, never filler.
// - Pictures are made-up illustrations, shared per story per day, never real
//   people or faces, and the app labels each one "illustration".
//
// Sources: US government feeds are public domain, so they can be used in a
// commercial app with credit. TheNewsAPI is wired in but stays OFF until
// THENEWSAPI_COMMERCIAL_OK=1: its terms grant a "personal, non-commercial" licence
// and forbid commercial use unless they approve it, so it needs that approval
// in writing first.

import { PNG } from "pngjs"
import { ai, withRetry, MODELS } from "./_ai.js"

export const FEEDS = [
    { id: "nasa", name: "NASA", url: "https://www.nasa.gov/feed/", topic: "space" },
    { id: "nsf", name: "National Science Foundation", url: "https://www.nsf.gov/rss/rss_www_news.xml", topic: "science" },
    { id: "nist", name: "NIST", url: "https://www.nist.gov/news-events/news/rss.xml", topic: "tech" },
    { id: "noaa", name: "NOAA", url: "https://www.noaa.gov/rss.xml", topic: "nature" },
    { id: "fws", name: "U.S. Fish & Wildlife Service", url: "https://www.fws.gov/news/rss.xml", topic: "animals" },
]

// Anything matching this is dropped before and after the model, whatever the
// model thinks of it. Deliberately broad: losing a harmless story costs
// nothing, letting a grim one through to a 14-year-old's morning does.
export const UNSAFE = /\b(kill(s|ed|ing)?|dead|death|deaths|die[sd]?|dying|murder\w*|shoot\w*|shot|gun\w*|weapon\w*|bomb\w*|attack\w*|war|wars|warfare|military|troops?|army|soldier\w*|missile\w*|terror\w*|crime\w*|criminal\w*|arrest\w*|police|prison\w*|jail\w*|court|lawsuit\w*|sued|trial|charged|abuse\w*|assault\w*|violen\w*|injur\w*|wound\w*|blood\w*|fatal\w*|victim\w*|disaster\w*|tragedy|tragic|crash\w*|explosion\w*|hurricane\w*|tornado\w*|wildfire\w*|earthquake\w*|flood\w*|drown\w*|overdose\w*|drug\w*|suicide\w*|politic\w*|election\w*|vote\w*|voting|congress\w*|senat\w*|president\w*|governor\w*|democrat\w*|republican\w*|trump|biden|campaign\w*|lawmaker\w*|legislat\w*|shutdown|tariff\w*|sanction\w*|budget|funding cut\w*|layoff\w*|fired|scandal\w*|stolen|steal\w*|theft|thie\w*|smuggl\w*|poach\w*|cold case|nuclear|sex\w*|nude\w*|graphic|hostage\w*|refugee\w*|famine|pandemic|outbreak\w*|virus\w*|cancer|disease\w*|illness\w*)\b/i

const MAX_AGE_MS = 4 * 24 * 3600 * 1000

function decode(s) {
    return String(s || "")
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
        // Entities first: feeds often escape their HTML, so tags only become
        // tags once &lt; and &gt; are decoded.
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;|&rsquo;|&#8217;/g, "’")
        .replace(/&lsquo;|&#8216;/g, "‘")
        .replace(/&ldquo;|&#8220;/g, "“")
        .replace(/&rdquo;|&#8221;/g, "”")
        .replace(/&mdash;|&#8212;/g, "—")
        .replace(/&ndash;|&#8211;/g, "–")
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
        .replace(/\s+/g, " ")
        .trim()
}

/** RSS/Atom text → [{ title, link, text, published }]. Pure. */
export function parseFeed(xml) {
    const out = []
    const blocks = String(xml || "").match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/g) || []
    for (const b of blocks) {
        const tag = (name) => {
            const m = b.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`))
            return m ? decode(m[1]) : ""
        }
        let link = tag("link")
        if (!link) {
            const m = b.match(/<link[^>]*href="([^"]+)"/)
            link = m ? m[1] : ""
        }
        const title = tag("title")
        const text = (tag("description") || tag("summary") || tag("content:encoded") || "").slice(0, 900)
        const when = tag("pubDate") || tag("published") || tag("updated") || tag("dc:date")
        const t = Date.parse(when)
        if (title && /^https?:\/\//.test(link)) out.push({ title, link, text, published: isNaN(t) ? null : new Date(t).toISOString() })
    }
    return out
}

/** Recent, word-filtered candidates from every source. Pure apart from fetch. */
export async function fetchCandidates(now = new Date(), fetchImpl = fetch) {
    const all = []
    await Promise.all(FEEDS.map(async (f) => {
        try {
            const ctrl = new AbortController()
            const t = setTimeout(() => ctrl.abort(), 10000)
            const res = await fetchImpl(f.url, { headers: { "User-Agent": "ChaceviaMorningPaper/1.0 (+https://chacevia.com)" }, signal: ctrl.signal })
            clearTimeout(t)
            if (!res.ok) return
            const items = parseFeed(await res.text())
                .filter((i) => !i.published || now - new Date(i.published) < MAX_AGE_MS)
                .slice(0, 8)
            for (const i of items) all.push({ ...i, source: f.name, sourceId: f.id, topic: f.topic })
        } catch (e) { /* one feed down is fine */ }
    }))
    return safeCandidates(all)
}

/** The word filter, on title and text. Pure. */
export function safeCandidates(items) {
    return items.filter((i) => !UNSAFE.test(i.title + " " + i.text))
}

const PICK_INSTRUCTIONS = `You pick and write the "Around the world" section of a teenager's morning newspaper.

You get a numbered list of real news items: each has a source, a title and a short description. Choose up to 3 that a teenager would find fun or interesting: science, space, animals, nature, technology, sports, music, culture.

NEVER choose anything about violence, crime, war, the military, death or dying, accidents, disasters, illness, drugs, politics, government budgets or funding fights, lawsuits, or anything graphic or upsetting. Skip anything that is mainly an agency announcing an event, a job, a grant, a webinar, a policy or a regulation: we want things that happened or were discovered. If fewer than 3 items qualify, return fewer. Returning none is fine.

For each chosen item write, in your OWN words, using ONLY what the item's title and description say. Never add a fact, number, name, date or detail that is not in them, and never add your own interpretation, significance, comparison or "this means" — if the description doesn't say why it matters, don't say why it matters:
- "headline": short newspaper headline, max 55 characters, plain caps-friendly words.
- "ticker": max 30 characters, punchy, for a scrolling ticker.
- "summary": 1 or 2 short sentences, max 200 characters, written so a 14-year-old gets it.
- "picture": a description for a simple black-and-white illustration of the story's main OBJECT or scene, max 25 words. No people, no faces, no hands, no text, no logos, no flags.

Return ONLY JSON: {"stories":[{"n": <item number>, "headline": "...", "ticker": "...", "summary": "...", "picture": "..."}]}. Best story first.`

/** Asks the model to pick up to 3 and write them; validates everything it says. */
export async function pickStories(candidates) {
    if (!candidates.length) return []
    const list = candidates.slice(0, 30).map((c, i) => `${i + 1}. [${c.source}] ${c.title}\n   ${c.text.slice(0, 400)}`).join("\n")
    const resp = await withRetry(() => ai().responses.create({
        model: process.env.PAPER_MODEL || MODELS.cheap,
        instructions: PICK_INSTRUCTIONS,
        input: list,
    }), { label: "paper-news", tries: 2 })
    return checkPicks(resp.output_text, candidates)
}

/** Pure: parses and polices the model's picks. */
export function checkPicks(text, candidates) {
    let obj
    try {
        const t = String(text || "")
        obj = JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1))
    } catch (e) {
        return []
    }
    const seen = new Set()
    const out = []
    for (const s of Array.isArray(obj.stories) ? obj.stories : []) {
        const c = candidates[Number(s.n) - 1]
        if (!c || seen.has(c.link)) continue
        const headline = String(s.headline || "").trim().slice(0, 70)
        const ticker = String(s.ticker || "").trim().slice(0, 36)
        const summary = String(s.summary || "").trim().slice(0, 240)
        const picture = String(s.picture || "").trim().slice(0, 220)
        if (!headline || !summary) continue
        if (UNSAFE.test([headline, ticker, summary, picture].join(" "))) continue
        seen.add(c.link)
        out.push({ headline, ticker: ticker || headline, summary, picture, source: c.source, url: c.link, topic: c.topic, published: c.published })
        if (out.length === 3) break
    }
    return out
}

// ---- Illustrations ------------------------------------------------------

const PICTURE_STYLE = "Simple black and white illustration, bold shapes, strong contrast, plain background, like a woodcut or a newspaper engraving. No people, no faces, no hands, no text, no letters, no logos. Subject: "

/** Greyscale PNG bytes → { w, h, g } at the paper's pixel size (area average, contrast stretched). Pure. */
export function toGrey(pngBuffer, w, h) {
    const png = PNG.sync.read(pngBuffer)
    const W = png.width, H = png.height, d = png.data
    // Crop to the target aspect ratio from the centre, then average blocks.
    const want = w / h
    let cw = W, ch = Math.round(W / want)
    if (ch > H) { ch = H; cw = Math.round(H * want) }
    const x0 = Math.floor((W - cw) / 2), y0 = Math.floor((H - ch) / 2)
    const out = new Uint8Array(w * h)
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const sx0 = x0 + Math.floor((x * cw) / w), sx1 = x0 + Math.floor(((x + 1) * cw) / w)
            const sy0 = y0 + Math.floor((y * ch) / h), sy1 = y0 + Math.floor(((y + 1) * ch) / h)
            let sum = 0, n = 0
            for (let yy = sy0; yy < Math.max(sy1, sy0 + 1); yy++) {
                for (let xx = sx0; xx < Math.max(sx1, sx0 + 1); xx++) {
                    const i = (yy * W + xx) * 4
                    sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
                    n++
                }
            }
            out[y * w + x] = sum / n
        }
    }
    let lo = 255, hi = 0
    for (const v of out) { if (v < lo) lo = v; if (v > hi) hi = v }
    const span = Math.max(1, hi - lo)
    for (let i = 0; i < out.length; i++) out[i] = Math.round(((out[i] - lo) * 255) / span)
    return { w, h, g: Buffer.from(out).toString("base64") }
}

/** One illustration for a story, or null (the app then draws a stock one). */
export async function illustrate(story, lead) {
    try {
        const resp = await withRetry(() => ai().images.generate({
            model: process.env.PAPER_IMAGE_MODEL || "gpt-image-1-mini",
            prompt: PICTURE_STYLE + story.picture,
            size: lead ? "1536x1024" : "1024x1024",
            quality: "low",
            output_format: "png",
            n: 1,
        }), { label: "paper-image", tries: 2 })
        const b64 = resp && resp.data && resp.data[0] && resp.data[0].b64_json
        if (!b64) return null
        return lead ? toGrey(Buffer.from(b64, "base64"), 96, 52) : toGrey(Buffer.from(b64, "base64"), 48, 36)
    } catch (e) {
        console.warn("paper-image failed:", e && (e.status || e.message))
        return null
    }
}

/** The whole edition: fetch, pick, illustrate. Never throws; [] is a valid edition. */
export async function buildEdition(now = new Date()) {
    let stories = []
    try {
        stories = await pickStories(await fetchCandidates(now))
    } catch (e) {
        console.warn("paper-news failed:", e && (e.status || e.message))
        return []
    }
    const art = await Promise.all(stories.map((s, i) => illustrate(s, i === 0)))
    return stories.map((s, i) => ({ ...s, art: art[i] }))
}
