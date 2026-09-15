// api/_ai.js
// Shared brains for every Chacevia endpoint.
//   - model tiering (cheap model for small jobs, strong model for heavy ones)
//   - automatic retries with backoff on flaky/overloaded API calls
//   - response caching (same input => instant, free answer)
//   - strict JSON handling so malformed output can't crash a route
// Not an API route (leading underscore).

import OpenAI from "openai"
import crypto from "crypto"
import { svc } from "./_coins.js"

// ---- Model tiers -------------------------------------------------
// Override per-tier in Vercel without touching code.
export const MODELS = {
    fast: process.env.MODEL_FAST || "gpt-5.5-mini",   // chat, short replies
    smart: process.env.MODEL_SMART || "gpt-5.5",      // research, study kits
}

let _client = null
export function ai() {
    if (!_client) _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 90000 })
    return _client
}

// ---- Retries -----------------------------------------------------
const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504])

function isRetryable(err) {
    if (!err) return false
    if (RETRYABLE.has(err.status)) return true
    const m = String(err.message || "").toLowerCase()
    return m.includes("timeout") || m.includes("econnreset") || m.includes("overloaded") || m.includes("fetch failed")
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Run an async call, retrying transient failures with exponential backoff.
export async function withRetry(fn, { tries = 3, baseMs = 700, label = "openai" } = {}) {
    let lastErr
    for (let i = 0; i < tries; i++) {
        try {
            return await fn()
        } catch (err) {
            lastErr = err
            if (i === tries - 1 || !isRetryable(err)) break
            const wait = baseMs * Math.pow(2, i) + Math.floor(Math.random() * 250)
            console.warn(`[${label}] attempt ${i + 1} failed (${err.status || err.message}), retrying in ${wait}ms`)
            await sleep(wait)
        }
    }
    throw lastErr
}

// ---- Cache -------------------------------------------------------
export function cacheKey(endpoint, parts) {
    const h = crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 48)
    return endpoint + ":" + h
}

export async function cacheGet(key) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return null
    try {
        const { data } = await svc().from("ai_cache").select("payload, hits").eq("cache_key", key).maybeSingle()
        if (data && data.payload) {
            // Bump the hit counter without making the user wait on it.
            svc().from("ai_cache").update({ hits: (data.hits || 0) + 1 }).eq("cache_key", key).then(() => {}, () => {})
            return data.payload
        }
    } catch (e) { /* cache is best-effort */ }
    return null
}

export async function cacheSet(key, endpoint, payload) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return
    try {
        await svc().from("ai_cache").upsert({ cache_key: key, endpoint, payload })
    } catch (e) { /* best-effort */ }
}

// ---- JSON handling ----------------------------------------------
// Pull a JSON object out of model output, tolerating code fences / stray prose.
export function parseJson(text) {
    const t = String(text || "").trim()
    const cleaned = t.replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim()
    const a = cleaned.indexOf("{"), b = cleaned.lastIndexOf("}")
    if (a === -1 || b === -1) throw new Error("No JSON object in model output")
    return JSON.parse(cleaned.slice(a, b + 1))
}

// One call that asks for JSON and guarantees you get an object back (or throws).
// Retries once more with a blunt "JSON only" nudge if the first parse fails.
export async function askJson({ model, instructions, input, tools, label = "askJson" }) {
    const run = async (extra) => {
        const resp = await withRetry(
            () => ai().responses.create({
                model: model || MODELS.smart,
                instructions: instructions + (extra || ""),
                input,
                ...(tools ? { tools } : {}),
            }),
            { label }
        )
        return resp
    }

    let resp = await run("")
    try {
        return { data: parseJson(resp.output_text), raw: resp }
    } catch (e) {
        console.warn(`[${label}] JSON parse failed, retrying with strict nudge`)
        resp = await run("\n\nCRITICAL: Respond with ONE valid JSON object and nothing else. No prose, no markdown, no code fences.")
        return { data: parseJson(resp.output_text), raw: resp }
    }
}
