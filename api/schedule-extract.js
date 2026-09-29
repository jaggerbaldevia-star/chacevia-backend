// api/schedule-extract.js
//
// Turns a class schedule into structured JSON — two ways in, one way out:
//   { image: base64 }  → vision reads a photo/screenshot/handwritten list
//   { audio: base64 }  → transcribed, then read the same way
// Both converge on the identical class array so the confirmation screen
// doesn't care which path the user took.
//
// Nothing here writes to the database. The user confirms first.
//
// Also handles action=reminder-text (merged in to stay under Vercel's
// serverless function cap): writes the reminder push-notification lines
// in Rocco's voice, ahead of time, so whatever eventually delivers them
// (push, email) just reads a string out of the DB. Free — this is part
// of setting up an assignment, not a separate AI feature.

import OpenAI, { toFile } from "openai"
import { requireCoins, svc } from "./_coins.js"
import { MODELS, withRetry, ai } from "./_ai.js"
import { setCors } from "./_cors.js"
import {
    canvasAllowed,
    canvasEnabled,
    CanvasError,
    decryptFeed,
    encryptFeed,
    fetchIcs,
    importItems,
    parseAssignments,
    parseFeedUrl,
    removeCanvasData,
} from "./_canvas.js"

export const config = { maxDuration: 60 }
const COIN_COST = 0 // free; requireCoins still enforces login + rate limit
const TRANSCRIBE_MODEL = "whisper-1"

function setCorsHeaders(req, res) {
    // Allowlisted origins only — see api/_cors.js.
    setCors(req, res, "POST, OPTIONS", "Content-Type, Authorization")
}

const SHARED_RULES = `Extract the student's class schedule AND work out the pattern it follows.

Return ONLY valid JSON — no prose, no markdown, no code fences:
{
  "pattern": {
    "type": "weekly" | "ab" | "rotating" | "other",
    "cycle_labels": ["A","B"],
    "skip_weekends": true,
    "notes": "one short sentence explaining the pattern in plain words"
  },
  "classes": [{"name": "...", "period": "...", "start_time": "...", "end_time": "...", "days": ["A"]}]
}

FIGURING OUT THE PATTERN — do this first, it changes how you read everything else:
- "weekly": the same classes every Monday, every Tuesday, etc. cycle_labels is ["Mon","Tue","Wed","Thu","Fri"].
- "ab": alternating A/B (or Blue/Gold, X/Y, Odd/Even) days. cycle_labels like ["A","B"].
- "rotating": a numbered cycle that keeps rolling regardless of weekday — Day 1 through Day 6, etc. cycle_labels like ["Day 1","Day 2",...]. These are common and easy to misread as weekly — if you see day numbers that go past 5, or the same period holding different classes on different days, it's rotating.
- "other": anything else (college MWF/TTh blocks, flex/seminar days, week A/week B). Explain it in notes.

Signals to look for: a legend or key, columns labelled with letters or day numbers, the same period holding different classes, "drop" or "flex" periods, classes that clearly don't meet daily.

Then set each class's "days" to the cycle labels it meets on — ["A"], ["Day 1","Day 4"], ["Mon","Wed","Fri"] — using the SAME labels you put in cycle_labels. Empty array [] if you can't tell.

Field rules:
- "name": the class as the student would say it ("Algebra 2", "AP Bio", "Chemistry").
- "period": whatever labels the slot — "1st", "3rd", "Block A", "Period 4". null if there isn't one.
- "start_time"/"end_time": 24-hour "HH:MM". null if not stated or not certain.
- "days": array from ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"], OR rotation letters like ["A"], ["B"], ["A","B"] for A/B day schedules. Empty array [] if unknown.

CRITICAL — never guess. If a time or day isn't clearly there, use null (or [] for days).
A null the student fixes in two taps is far better than a wrong time they don't notice.

Keep classes in the order they occur in the day. Include lunch/advisory/study hall if listed.
If you can't find any classes at all, return {"classes": []}.`

const IMAGE_RULES = SHARED_RULES + `

This is a photo or screenshot of a schedule. It might be a grid/table, a portal screenshot, a printed handout, or handwritten. Read carefully:
- In a grid, figure out whether columns are days and rows are periods (or the reverse) before reading off classes.
- Rotating A/B day schedules often repeat the same period with different classes — capture both, using days ["A"] and ["B"].
- Ignore headers, room numbers, teacher names, and logos unless the class name is genuinely part of them.`

const SPEECH_RULES = SHARED_RULES + `

This is a student casually describing their day out loud, not reading a form. So:
- ORDER MATTERS MORE THAN TIMES. They'll say "first period", "then", "after that" — preserve the sequence and put it in "period" when they name one.
- They almost never state exact clock times. Leave start_time and end_time null rather than inventing them — the student fills those in on the next screen.
- They may not mention days at all. Leave days as [] unless they actually say it.
- Listen for pattern clues in how they talk: "on A days", "it rotates", "Day 3 I have...", "every other day", "I don't have it Fridays". If they clearly describe a rotation or A/B setup, set the pattern accordingly. If they just list a normal day, use "weekly".
- Strip filler ("um", "I think", "uh") and keep the class names clean.`

function parseClasses(text) {
    const t = String(text || "").trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "")
    const a = t.indexOf("{"), b = t.lastIndexOf("}")
    const obj = JSON.parse(t.slice(a, b + 1))
    const list = Array.isArray(obj.classes) ? obj.classes : []
    const classes = list.slice(0, 24).map((c) => ({
        name: String((c && c.name) || "").slice(0, 60) || "Untitled class",
        period: c && c.period ? String(c.period).slice(0, 20) : null,
        start_time: c && c.start_time ? String(c.start_time).slice(0, 5) : null,
        end_time: c && c.end_time ? String(c.end_time).slice(0, 5) : null,
        days: Array.isArray(c && c.days) ? c.days.map((d) => String(d).slice(0, 12)).filter(Boolean).slice(0, 8) : [],
    })).filter((c) => c.name)

    const p = obj.pattern || {}
    const types = ["weekly", "ab", "rotating", "other"]
    const pattern = {
        type: types.includes(p.type) ? p.type : "weekly",
        cycle_labels: Array.isArray(p.cycle_labels) && p.cycle_labels.length
            ? p.cycle_labels.map((d) => String(d).slice(0, 12)).slice(0, 10)
            : ["Mon", "Tue", "Wed", "Thu", "Fri"],
        skip_weekends: p.skip_weekends !== false,
        notes: p.notes ? String(p.notes).slice(0, 200) : "",
    }
    return { classes, pattern }
}

async function handleScheduleExtract(req, res, body) {
    const image = body && body.image
    const audio = body && body.audio
    if (!image && !audio) return res.status(400).json({ error: "Send a photo of your schedule, or record yourself describing it." })
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "Server is missing OPENAI_API_KEY." })

    try {
        const guard = await requireCoins(req, body, COIN_COST, "schedule-extract")
        if (!guard.ok) return res.status(guard.status).json(guard.payload)

        const model = MODELS.smart
        let resp
        let transcript = ""

        if (image) {
            const dataUri = image.startsWith("data:") ? image : "data:image/jpeg;base64," + image
            resp = await withRetry(
                () => ai().responses.create({
                    model,
                    input: [{
                        role: "user",
                        content: [
                            { type: "input_image", image_url: dataUri },
                            { type: "input_text", text: IMAGE_RULES },
                        ],
                    }],
                }),
                { label: "schedule-image" }
            )
        } else {
            const clean = audio.replace(/^data:[^;]+;base64,/, "")
            const buffer = Buffer.from(clean, "base64")
            try {
                const file = await toFile(buffer, (body && body.filename) || "schedule.m4a")
                const tr = await withRetry(
                    () => ai().audio.transcriptions.create({ file, model: TRANSCRIBE_MODEL }),
                    { label: "schedule-transcribe" }
                )
                transcript = (tr && tr.text) || ""
            } catch (e) {
                console.error("schedule transcription error:", e)
                return res.status(502).json({ error: "Couldn't hear that recording. Try again somewhere quieter." })
            }
            if (!transcript.trim()) {
                return res.status(200).json({ classes: [], transcript: "", message: "I couldn't hear any speech in that.", coins: guard.balance })
            }
            resp = await withRetry(
                () => ai().responses.create({
                    model,
                    instructions: SPEECH_RULES,
                    input: "The student said:\n" + transcript,
                }),
                { label: "schedule-speech" }
            )
        }

        let parsed
        try { parsed = parseClasses(resp.output_text) } catch (e) {
            return res.status(502).json({ error: "Couldn't read that schedule. Try a clearer photo, or just say your classes out loud." })
        }

        // No deduction. Still return the balance so the header pill stays in sync.
        const coins = guard.balance
        return res.status(200).json({ classes: parsed.classes, pattern: parsed.pattern, transcript, coins })
    } catch (err) {
        console.error("schedule-extract error:", err)
        return res.status(500).json({ error: "Something went wrong reading that schedule. Try again." })
    }
}

const REMINDER_INSTRUCTIONS = `You are Rocco, a tiny raspy pixel buddy who lives in a study app. Write push notification lines nudging a student about homework.

Return ONLY valid JSON: {"messages": ["...", "..."]} — one string per reminder, in the order given.

Rules for every line:
- Under 90 characters. It's a lock-screen notification, not a paragraph.
- Sound like a funny friend who remembered, not an app. Warm, a bit goofy, light sarcasm is fine.
- Natural slang is welcome but at most one per line, and never forced.
- Match the urgency to the timing: days ahead is a casual heads-up, night before is "ok actually", morning of is "IT'S TODAY".
- Use the class and assignment name so it's obviously about their real work.
- Never guilt-trip, shame, or catastrophize. No "you're going to fail". Encouraging, even when it's urgent.
- No emoji spam — one, sometimes, max.`

async function handleReminderText(req, res, body) {
    const title = body && body.title
    const className = (body && body.className) || ""
    const dueDate = (body && body.dueDate) || ""
    const reminders = Array.isArray(body && body.reminders) ? body.reminders.slice(0, 5) : []
    if (!title || !reminders.length) return res.status(400).json({ error: "Missing assignment or reminders." })

    // Fallback lines so reminders always exist even if the AI call fails.
    const fallback = reminders.map((r) => {
        const d = Number(r.days_before) || 0
        if (d === 0) return `Today's the day — "${title}" is due! You got this.`
        if (d === 1) return `Heads up: "${title}" is due tomorrow.`
        return `"${title}" is due in ${d} days — might be worth a look.`
    })

    if (!process.env.OPENAI_API_KEY) return res.status(200).json({ messages: fallback })

    try {
        // Must be logged in, but no coin charge for this.
        const guard = await requireCoins(req, body, 0, "reminder-text")
        if (!guard.ok) return res.status(guard.status).json(guard.payload)

        const lines = reminders.map((r) => {
            const d = Number(r.days_before) || 0
            const when = d === 0 ? "the morning it's due" : d === 1 ? "the night before" : d + " days before it's due"
            return "- a reminder sent " + when + " at " + (r.time_of_day || "17:00")
        }).join("\n")

        const resp = await withRetry(
            () => ai().responses.create({
                model: MODELS.fast,
                instructions: REMINDER_INSTRUCTIONS,
                input: `Assignment: "${title}"${className ? "\nClass: " + className : ""}${dueDate ? "\nDue: " + dueDate : ""}\n\nWrite one line for each of these reminders, in order:\n${lines}`,
            }),
            { label: "reminder-text", tries: 2 }
        )

        let messages = fallback
        try {
            const t = String(resp.output_text || "").trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "")
            const a = t.indexOf("{"), b = t.lastIndexOf("}")
            const obj = JSON.parse(t.slice(a, b + 1))
            if (Array.isArray(obj.messages) && obj.messages.length) {
                messages = reminders.map((_, i) => String(obj.messages[i] || fallback[i]).slice(0, 140))
            }
        } catch (e) { /* keep fallback */ }

        return res.status(200).json({ messages })
    } catch (err) {
        console.error("reminder-text error:", err)
        return res.status(200).json({ messages: fallback })
    }
}

// =====================================================================
// Canvas Calendar Feed import  (v1.1, hidden behind CANVAS_ENABLED)
// =====================================================================
// Three actions live here rather than in a new api/canvas.js because Vercel
// Hobby caps serverless functions at 12 and we are at 12. This file already
// owns classes and assignments, so it is also where they belong.

// How stale a sync has to be before "open the app" triggers another one. The
// client asks on every open; the server decides. Putting the floor here means a
// tampered-with client still can't hammer a school's Canvas on our behalf.
const SYNC_MIN_AGE_MS = 30 * 60 * 1000

async function canvasUser(req, body, res) {
    if (!canvasEnabled()) {
        // Not "forbidden" — as far as the outside world is concerned this
        // endpoint does not exist until the flag is on.
        res.status(404).json({ error: "Not found." })
        return null
    }
    // Login is resolved BEFORE the allowlist, because the allowlist is keyed on
    // the user id and the id has to come from a verified token — never from
    // anything the caller sends.
    const guard = await requireCoins(req, body, 0, "canvas-sync")
    if (!guard.ok) {
        res.status(guard.status).json(guard.payload)
        return null
    }
    if (!canvasAllowed(guard.userId)) {
        // The same 404 a disabled flag gives. A user outside the beta learns
        // nothing about whether the feature exists.
        res.status(404).json({ error: "Not found." })
        return null
    }
    return guard.userId
}

function canvasFailure(res, err, step) {
    if (err instanceof CanvasError) {
        // Log the code, never the URL — the link is the credential.
        console.warn(`[canvas] ${step} failed: ${err.code}`)
        return res.status(400).json({ error: err.friendly, canvasError: err.code })
    }
    console.error(`[canvas] ${step} error:`, err && err.message)
    return res.status(500).json({ error: "Something went wrong talking to Canvas. Try again in a moment." })
}

async function runSync(db, userId, feedUrl, timeZone) {
    const ics = await fetchIcs(feedUrl)
    // timeZone decides which calendar day a late-evening deadline lands on.
    const { items, stats } = parseAssignments(ics, timeZone)
    if (!items.length) {
        throw new CanvasError(
            "no-assignments",
            stats.events
                ? "I read that calendar but couldn't find any assignments in it. If your school puts homework somewhere other than the Canvas calendar, this won't pick it up."
                : "That calendar came back empty. If you just made the link, give Canvas a minute and try again."
        )
    }
    const result = await importItems(db, userId, items)
    return { ...result, stats }
}

async function handleCanvasConnect(req, res, body) {
    const userId = await canvasUser(req, body, res)
    if (!userId) return

    let feedUrl
    try {
        feedUrl = parseFeedUrl(body && body.feedUrl)
    } catch (err) {
        return canvasFailure(res, err, "parse-url")
    }

    const db = svc()
    let result
    try {
        // Import BEFORE storing. A link that doesn't work shouldn't be saved,
        // and a user who pastes a bad one should find out now rather than
        // discovering an empty homework screen later.
        result = await runSync(db, userId, feedUrl, body && body.tz)
    } catch (err) {
        return canvasFailure(res, err, "connect")
    }

    try {
        const enc = encryptFeed(feedUrl.toString())
        const { error } = await db.from("canvas_links").upsert(
            {
                user_id: userId,
                ...enc,
                feed_host: feedUrl.hostname,
                // Kept so the nightly cron, which has no client to ask, files due
                // dates on the same day the student sees in the app.
                tz: (body && body.tz) || null,
                last_sync_at: new Date().toISOString(),
                last_status: "ok",
                last_error: null,
                updated_at: new Date().toISOString(),
            },
            { onConflict: "user_id" }
        )
        if (error) throw error
    } catch (err) {
        return canvasFailure(res, err, "store")
    }

    return res.status(200).json({
        connected: true,
        host: feedUrl.hostname,
        imported: result.imported,
        classes: result.classes,
        lastSyncAt: new Date().toISOString(),
    })
}

async function handleCanvasSync(req, res, body) {
    const userId = await canvasUser(req, body, res)
    if (!userId) return

    const db = svc()
    const { data: link } = await db
        .from("canvas_links")
        .select("feed_ciphertext, feed_iv, feed_tag, feed_host, last_sync_at")
        .eq("user_id", userId)
        .maybeSingle()

    if (!link) {
        return res.status(200).json({ connected: false, synced: false })
    }

    const age = link.last_sync_at ? Date.now() - new Date(link.last_sync_at).getTime() : Infinity
    if (age < SYNC_MIN_AGE_MS && !(body && body.force)) {
        return res.status(200).json({
            connected: true,
            synced: false,
            reason: "recent",
            host: link.feed_host,
            lastSyncAt: link.last_sync_at,
        })
    }

    let result
    try {
        const feedUrl = parseFeedUrl(decryptFeed(link))
        result = await runSync(db, userId, feedUrl, body && body.tz)
    } catch (err) {
        // A failed sync is recorded and reported, but the stored link is kept:
        // a school's Canvas being down for an afternoon is not a reason to make
        // someone paste their link again.
        await db
            .from("canvas_links")
            .update({
                last_status: err instanceof CanvasError ? err.code : "error",
                last_error: err instanceof CanvasError ? err.friendly : "Sync failed",
                updated_at: new Date().toISOString(),
            })
            .eq("user_id", userId)
        return canvasFailure(res, err, "sync")
    }

    const now = new Date().toISOString()
    await db
        .from("canvas_links")
        .update({
            last_sync_at: now,
            last_status: "ok",
            last_error: null,
            tz: (body && body.tz) || undefined,
            updated_at: now,
        })
        .eq("user_id", userId)

    return res.status(200).json({
        connected: true,
        synced: true,
        imported: result.imported,
        classes: result.classes,
        host: link.feed_host,
        lastSyncAt: now,
    })
}

async function handleCanvasStatus(req, res, body) {
    const userId = await canvasUser(req, body, res)
    if (!userId) return
    const { data: link } = await svc()
        .from("canvas_links")
        // Never the ciphertext. The client has no use for it and no business
        // holding it.
        .select("feed_host, last_sync_at, last_status, last_error")
        .eq("user_id", userId)
        .maybeSingle()
    if (!link) return res.status(200).json({ enabled: true, connected: false })
    return res.status(200).json({
        enabled: true,
        connected: true,
        host: link.feed_host,
        lastSyncAt: link.last_sync_at,
        lastStatus: link.last_status,
        lastError: link.last_error,
    })
}

async function handleCanvasDisconnect(req, res, body) {
    const userId = await canvasUser(req, body, res)
    if (!userId) return
    const db = svc()
    try {
        // Their data goes first. If the link row survived a failure here the
        // user could retry; an orphaned pile of Canvas assignments with no way
        // to remove them is the worse end state.
        await removeCanvasData(db, userId)
        await db.from("canvas_links").delete().eq("user_id", userId)
    } catch (err) {
        return canvasFailure(res, err, "disconnect")
    }
    return res.status(200).json({ connected: false, removed: true })
}

// Daily sweep, called by pg_cron via pg_net. Authenticated by a shared secret
// rather than a user token, and deliberately batched: this file's maxDuration
// is 60s and each user costs one outbound fetch to their school.
async function handleCanvasCron(req, res) {
    if (!canvasEnabled()) return res.status(404).json({ error: "Not found." })
    const secret = process.env.CRON_SECRET || ""
    const given = (req.headers && (req.headers["x-cron-secret"] || req.headers["X-Cron-Secret"])) || ""
    if (!secret || given !== secret) return res.status(401).json({ error: "Unauthorized." })

    const db = svc()
    const cutoff = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString()
    const { data: due } = await db
        .from("canvas_links")
        .select("user_id, feed_ciphertext, feed_iv, feed_tag, tz")
        .or(`last_sync_at.is.null,last_sync_at.lt.${cutoff}`)
        .order("last_sync_at", { ascending: true, nullsFirst: true })
        .limit(10)

    let ok = 0
    let failed = 0
    for (const link of due || []) {
        const now = new Date().toISOString()
        try {
            const feedUrl = parseFeedUrl(decryptFeed(link))
            await runSync(db, link.user_id, feedUrl, link.tz)
            await db
                .from("canvas_links")
                .update({ last_sync_at: now, last_status: "ok", last_error: null, updated_at: now })
                .eq("user_id", link.user_id)
            ok++
        } catch (err) {
            failed++
            await db
                .from("canvas_links")
                .update({
                    // Stamped even on failure, so one permanently broken link
                    // can't monopolise every run for the next month.
                    last_sync_at: now,
                    last_status: err instanceof CanvasError ? err.code : "error",
                    last_error: err instanceof CanvasError ? err.friendly : "Sync failed",
                    updated_at: now,
                })
                .eq("user_id", link.user_id)
        }
    }
    return res.status(200).json({ ok, failed, considered: (due || []).length })
}

export default async function handler(req, res) {
    setCorsHeaders(req, res)
    if (req.method === "OPTIONS") return res.status(204).end()
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed. Use POST." })

    let body = req.body
    if (typeof body === "string") {
        try { body = JSON.parse(body) } catch { return res.status(400).json({ error: "Body must be valid JSON." }) }
    }

    const action = (req.query && req.query.action) || (body && body.action)
    if (action === "reminder-text") return handleReminderText(req, res, body)
    if (action === "canvas-connect") return handleCanvasConnect(req, res, body)
    if (action === "canvas-sync") return handleCanvasSync(req, res, body)
    if (action === "canvas-status") return handleCanvasStatus(req, res, body)
    if (action === "canvas-disconnect") return handleCanvasDisconnect(req, res, body)
    if (action === "canvas-cron") return handleCanvasCron(req, res)
    return handleScheduleExtract(req, res, body)
}
