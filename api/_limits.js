// api/_limits.js
// Per-user caps so no single account (or script) can run up the OpenAI bill.
// Coins already limit paid usage — this is the backstop against abuse,
// bugs, and retry loops. Not an API route (leading underscore).

import { svc } from "./_coins.js"

// Calls allowed per user, per hour, per endpoint.
// Generous for real people, tight enough to stop a script.
// WARNING — these only apply to endpoints that call requireCoins() with an
// endpoint name. Four AI endpoints currently do NOT, so their entries here are
// aspirational, not protection:
//
//   rocco-voice     — OpenAI TTS, no login gate, no metering. The live frontend
//                     calls it on every spoken reply WITHOUT a token, so adding
//                     requireCoins here would 401 every user the second it
//                     deploys. The web component now sends the token (see the
//                     voiceEndpoint fetch); once that's published, gating this
//                     is a one-line change and the 80/hour below goes live.
//   notes-pdf       — in pdf.js, no guard
//   direction-pdf   — in pdf.js, no guard
//   creative-deck / fill-form — call OpenAI directly, no guard
//
// Until then those five are reachable by anyone with the URL: CORS stops other
// websites, but nothing stops curl. Flagged rather than fixed, because every
// one of them is live traffic tonight.
const LIMITS = {
    "rocco-chat": 60,
    "rocco-voice": 80,
    "creative-ai": 30,
    "research-deck": 10,
    "scan-answer": 20,
    "voice-notes": 20,
    "study-set": 10,
    "direction-pdf": 40,
    "schedule-extract": 12,
    "reminder-text": 60,
    // Canvas connect/sync/disconnect. The 30-minute floor in schedule-extract
    // is the real control; this is the backstop against a client looping.
    "canvas-sync": 20,
    // The second model call every Rocco message makes — memory extraction.
    // Metered under its own name so the real call volume is visible in
    // usage_counters instead of hiding behind the chat count.
    "rocco-memory": 60,
    default: 30,
}

// Hard daily ceilings, on top of the hourly ones. Only endpoints listed here
// get a daily cap; everything else is hourly-only as before.
//
// 100 chat messages a day is far more than a student sends and still bounds the
// worst case: without this, 60/hour is 1,440/day per account.
// Free vs Premium, enforced HERE. A cap the client could change is not a cap,
// and the paywall in the UI is a signpost, not a gate.
//
// The premium number is the pre-existing abuse ceiling, deliberately unchanged:
// "unlimited" means no product limit, not no safety limit.
const DAILY_LIMITS = {
    "rocco-chat": 100,
}
const FREE_DAILY_LIMITS = {
    "rocco-chat": 10,
}

// One entitlement read, and only for endpoints whose cap actually differs by
// plan. Expiry is evaluated against now(), so a lapsed trial drops to the free
// cap on its next message without anything having to run on a schedule.
async function isUserPremium(userId) {
    try {
        const { resolvePremium } = await import("./_premium.js")
        const { data } = await svc()
            .from("entitlements")
            .select("is_premium, source, expires_at, will_renew, product_id")
            .eq("user_id", userId)
            .maybeSingle()
        return resolvePremium(data || null).isPremium
    } catch (e) {
        // Could not tell. Fail OPEN to the free cap rather than locking a paying
        // user out of a feature they bought — the free cap still bounds abuse.
        return false
    }
}

// Buckets are UTC, deliberately. The alternative is trusting a timezone sent by
// the client, and a client that can choose its own day boundary can mint a
// fresh quota whenever it likes — a cap you can opt out of is not a cap. The
// cost is that the reset lands mid-evening in US timezones rather than at local
// midnight.
function hourBucket(d = new Date()) {
    return d.toISOString().slice(0, 13) // 2026-09-28T16
}

// 10 chars vs the hour bucket's 13, so the two can never collide. No suffix on
// purpose: if usage_counters.bucket is ever a timestamp rather than text, a
// plain date still casts and "2026-09-28:day" would not.
function dayBucket(d = new Date()) {
    return d.toISOString().slice(0, 10) // 2026-09-28
}

// One counter increment. Throws on failure so callers can decide — which for
// AI endpoints means refusing the request.
async function bump(userId, bucket, endpoint) {
    const { data, error } = await svc().rpc("bump_usage", {
        p_user_id: userId,
        p_bucket: bucket,
        p_endpoint: endpoint,
    })
    if (error) throw new Error(error.message || "bump_usage failed")
    return typeof data === "number" ? data : 0
}

/**
 * Meter one call and say whether it's allowed.
 *
 * Returns { ok: true, messagesLeftToday, ... } or
 *         { ok: false, status, payload } ready to send.
 *
 * FAILS CLOSED. If the counter can't be read or written, the request is
 * refused with a 503 rather than waved through. This is the opposite of the
 * old behaviour, and it's deliberate: metering is the only thing standing
 * between a retry loop and an unbounded OpenAI bill, so a broken meter has to
 * stop spending, not permit it. The user gets a "try again in a moment"
 * message, which is true — the failure mode is transient.
 */
export async function checkLimit(userId, endpoint) {
    // Not a metering failure: Supabase isn't configured at all, which is a
    // local-dev state. In production these are always set, and requireCoins
    // has already refused the request without a logged-in user.
    if (!userId || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        return { ok: true, metering: "unconfigured" }
    }

    const now = new Date()
    const hourCap = LIMITS[endpoint] || LIMITS.default
    const planned = FREE_DAILY_LIMITS[endpoint] !== undefined
    const premium = planned ? await isUserPremium(userId) : false
    const dayCap = planned
        ? premium
            ? DAILY_LIMITS[endpoint]
            : FREE_DAILY_LIMITS[endpoint]
        : DAILY_LIMITS[endpoint] || null

    let hourUsed
    let dayUsed = null
    try {
        hourUsed = await bump(userId, hourBucket(now), endpoint)
        if (dayCap) dayUsed = await bump(userId, dayBucket(now), endpoint)
    } catch (e) {
        console.error(`[limits] metering failed for ${endpoint}:`, e && e.message)
        return {
            ok: false,
            status: 503,
            payload: {
                error: "Rocco can't count right now, so he's sitting this one out. Try again in a moment!",
                meteringDown: true,
            },
        }
    }

    const messagesLeftToday = dayCap ? Math.max(0, dayCap - dayUsed) : null

    // Daily first: it's the more informative refusal. Being told "come back
    // tomorrow" beats "wait an hour" when an hour won't be enough.
    if (dayCap && dayUsed > dayCap) {
        return {
            ok: false,
            status: 429,
            payload: {
                error: premium
                    ? `That's ${dayCap} messages today — I'm all talked out! I'll be back tomorrow. Everything else still works.`
                    : `That's your ${dayCap} messages for today! Premium makes Rocco unlimited — or come back tomorrow. Everything else still works.`,
                rateLimited: true,
                dailyLimit: true,
                messagesLeftToday: 0,
                // Lets the UI offer the paywall instead of just a dead end.
                upgradeable: !premium,
            },
        }
    }

    if (hourUsed > hourCap) {
        return {
            ok: false,
            status: 429,
            payload: {
                error: "Whoa, slow down! You've hit the hourly limit for this tool. Try again in a bit.",
                rateLimited: true,
                messagesLeftToday,
            },
        }
    }

    return { ok: true, hourUsed, hourCap, dayUsed, dayCap, messagesLeftToday, premium }
}

/**
 * Meter a call that must never block the user's request — the memory
 * extraction behind every chat message.
 *
 * Returns { over: true } when the caller should skip the work. Skipping is the
 * right failure mode here: memory extraction is best-effort, so dropping it
 * saves a model call without costing the user their reply. A metering failure
 * also returns over: true, keeping the fail-closed rule for anything that
 * spends money.
 */
export async function noteUsage(userId, endpoint) {
    if (!userId || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        return { over: false, metering: "unconfigured" }
    }
    const cap = LIMITS[endpoint] || LIMITS.default
    try {
        const used = await bump(userId, hourBucket(), endpoint)
        return { over: used > cap, used, cap }
    } catch (e) {
        console.error(`[limits] metering failed for ${endpoint}:`, e && e.message)
        return { over: true, meteringDown: true }
    }
}
