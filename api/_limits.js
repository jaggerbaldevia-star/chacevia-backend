// api/_limits.js
// Per-user hourly caps so no single account (or script) can run up the bill.
// Coins already limit paid usage — this is the backstop against abuse,
// bugs, and retry loops. Not an API route (leading underscore).

import { svc } from "./_coins.js"

// Calls allowed per user, per hour, per endpoint.
// Generous for real people, tight enough to stop a script.
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
    default: 30,
}

function hourBucket(d = new Date()) {
    return d.toISOString().slice(0, 13) // 2026-09-14T16
}

// Returns { ok: true } or { ok: false, status, payload }.
export async function checkLimit(userId, endpoint) {
    // No user (coins not configured) or no DB — nothing to meter against.
    if (!userId || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return { ok: true }

    const cap = LIMITS[endpoint] || LIMITS.default
    try {
        const { data, error } = await svc().rpc("bump_usage", {
            p_user_id: userId,
            p_bucket: hourBucket(),
            p_endpoint: endpoint,
        })
        if (error) return { ok: true } // never block users on a metering failure
        const calls = typeof data === "number" ? data : 0
        if (calls > cap) {
            return {
                ok: false,
                status: 429,
                payload: {
                    error: "Whoa, slow down! You've hit the hourly limit for this tool. Try again in a bit.",
                    rateLimited: true,
                },
            }
        }
        return { ok: true, calls, cap }
    } catch (e) {
        return { ok: true }
    }
}
