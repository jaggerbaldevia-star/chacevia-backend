// api/_premium.js
//
// Not an API route (leading underscore). One place that decides what "premium"
// means, so the app, the webhook and the trial endpoint can never disagree.
//
// Premium can arrive four ways and they all land in ONE row of public.entitlements:
//
//   apple   — com.chacevia.app.premium.monthly, $2.99/mo auto-renewing
//   founder — com.chacevia.app.founder, $12.99 once, premium forever
//   trial   — com.chacevia.app.trial7, $0, premium for exactly 7 days
//   legacy  — the old $9.99 Stripe lifetime unlock, treated as founder
//
// Expiry is evaluated at READ time against now(), never by a scheduled job, so
// a trial or a lapsed subscription switches off by itself even if nothing runs.

export const PRODUCT_MONTHLY = "com.chacevia.app.premium.monthly"
export const PRODUCT_FOUNDER = "com.chacevia.app.founder"
export const PRODUCT_TRIAL = "com.chacevia.app.trial7"

export const TRIAL_DAYS = 7
// Day 6 is when Rocco gives the heads-up, i.e. 1 day of trial left.
export const TRIAL_WARN_DAYS_LEFT = 1

// 2026-12-31 23:59:59 America/Los_Angeles. December is PST (UTC-8), so that is
// 2027-01-01T07:59:59Z. Written as the UTC instant rather than a local string
// because the server's own timezone must not be able to change the answer.
const FOUNDER_UNTIL_ISO = "2027-01-01T07:59:59.000Z"

/**
 * Is the founder product still on sale?
 *
 * Two gates, as asked: a server flag and a date. FOUNDER_SALE_OPEN=0 closes it
 * early, FOUNDER_SALE_OPEN=1 does NOT extend it past the date — a flag should be
 * able to stop a sale, never to quietly keep selling a limited offer forever.
 */
export function founderSaleOpen(now) {
    if (String(process.env.FOUNDER_SALE_OPEN || "") === "0") return false
    const t = (now instanceof Date ? now : new Date()).getTime()
    return t <= new Date(FOUNDER_UNTIL_ISO).getTime()
}

export function founderUntilISO() {
    return FOUNDER_UNTIL_ISO
}

/** Never expires: the founder purchase and the old lifetime unlock. */
function isForever(source) {
    return source === "founder" || source === "legacy"
}

/**
 * Turn an entitlements row into the answer the client needs. A row with an
 * expires_at in the past is simply not premium any more — no writing required.
 */
export function resolvePremium(row, now) {
    const t = (now instanceof Date ? now : new Date()).getTime()
    if (!row) {
        return {
            isPremium: false,
            isFounder: false,
            source: null,
            productId: null,
            expiresAt: null,
            willRenew: false,
        }
    }
    const forever = isForever(row.source)
    const exp = row.expires_at ? new Date(row.expires_at).getTime() : null
    const live = !!row.is_premium && (forever || exp === null || exp > t)
    return {
        isPremium: live,
        isFounder: forever && !!row.is_premium,
        source: live ? row.source || null : null,
        productId: row.product_id || null,
        expiresAt: row.expires_at || null,
        willRenew: !!row.will_renew,
    }
}

export async function readEntitlement(db, userId) {
    const { data } = await db
        .from("entitlements")
        .select("user_id, is_premium, source, product_id, expires_at, will_renew, last_event_ms")
        .eq("user_id", userId)
        .maybeSingle()
    return data || null
}

// ---------------------------------------------------------------------
// RevenueCat events
// ---------------------------------------------------------------------
// What each type does to access. The rule that matters most: CANCELLATION means
// "will not renew", NOT "access ends now" — Apple has already been paid for the
// period, and taking the app away early would be stealing time the user bought.
// Only EXPIRATION actually ends access.
const GRANTS = [
    "INITIAL_PURCHASE",
    "RENEWAL",
    "UNCANCELLATION",
    "NON_RENEWING_PURCHASE",
    "PRODUCT_CHANGE",
    "SUBSCRIPTION_EXTENDED",
]
const ENDS = ["EXPIRATION"]
// Keep access, stop promising a renewal.
const SOFT = ["CANCELLATION", "BILLING_ISSUE"]

function sourceFor(productId) {
    if (productId === PRODUCT_FOUNDER) return "founder"
    if (productId === PRODUCT_TRIAL) return "trial"
    return "apple"
}

/**
 * Apply one RevenueCat webhook event.
 *
 * Idempotent and order-safe:
 *   - the caller has already inserted the event id as a primary key, so a retry
 *     never reaches here twice
 *   - an event older than the newest one already applied to this row is dropped,
 *     which is what stops a late CANCELLATION from undoing a fresh RENEWAL
 *
 * Returns a short string describing what it did, for the webhook's log line.
 */
export async function applyRevenueCatEvent(db, ev, userId) {
    const type = String(ev.type || "").toUpperCase()
    const productId = ev.product_id || null
    const eventMs = Number(ev.event_timestamp_ms || 0) || 0

    const current = await readEntitlement(db, userId)
    if (current && current.last_event_ms && eventMs && eventMs < current.last_event_ms) {
        return "ignored-stale"
    }

    // The trial is granted by the trial endpoint, which owns its expiry. A
    // RevenueCat event for the $0 product must not be allowed to overwrite that
    // with an Apple expiry (a non-consumable has none), which would make the
    // trial permanent.
    if (productId === PRODUCT_TRIAL) return "ignored-trial-product"

    const patch = {
        user_id: userId,
        rc_app_user_id: ev.app_user_id || (current && current.rc_app_user_id) || null,
        last_event_ms: eventMs || (current && current.last_event_ms) || null,
        updated_at: new Date().toISOString(),
    }

    if (GRANTS.indexOf(type) !== -1) {
        const src = sourceFor(productId)
        patch.is_premium = true
        patch.source = src
        patch.product_id = productId
        // A non-consumable has no expiry. Everything else expires when Apple says.
        patch.expires_at =
            src === "founder"
                ? null
                : ev.expiration_at_ms
                  ? new Date(Number(ev.expiration_at_ms)).toISOString()
                  : null
        patch.will_renew = src !== "founder"
    } else if (ENDS.indexOf(type) !== -1) {
        // Founders and legacy buyers are never switched off by an expiry event.
        if (current && isForever(current.source)) return "ignored-forever"
        patch.is_premium = false
        patch.will_renew = false
        patch.expires_at = ev.expiration_at_ms
            ? new Date(Number(ev.expiration_at_ms)).toISOString()
            : new Date().toISOString()
    } else if (SOFT.indexOf(type) !== -1) {
        if (current && isForever(current.source)) return "ignored-forever"
        patch.will_renew = false
        // expires_at deliberately untouched: access runs to the date already paid for.
    } else {
        return "ignored-type:" + type
    }

    const { error } = await db
        .from("entitlements")
        .upsert(patch, { onConflict: "user_id" })
    if (error) throw error
    return "applied:" + type
}
