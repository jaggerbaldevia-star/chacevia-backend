// api/stripe.js
//
// One-time "Pro" purchase via Stripe Checkout. Behaviors split by
// ?action=, same pattern as schedule-extract.js, to stay under Vercel's
// serverless function cap:
//
//   ?action=checkout  (POST) — creates a Checkout Session for the caller
//   ?action=webhook   (POST) — Stripe calls this; verifies the signature,
//                     grants Pro via redeem_pro_purchase() (see pro-setup.sql)
//   ?action=status    (GET)  — { isPro, proSince, coins } for the caller
//
// The webhook needs Stripe's raw request body to verify the signature, so
// Vercel's body parser is disabled for the whole file (see `config`
// below). None of the three actions need a parsed JSON body anyway —
// checkout/status only read the Authorization header, webhook only reads
// raw bytes + a header.
//
// Price and grant are server-side constants on purpose. Never accept
// either from the client — a request could just lie about the amount.

import Stripe from "stripe"
import { svc, getUserId, tokenFrom } from "./_coins.js"
import {
    PRODUCT_TRIAL,
    TRIAL_DAYS,
    TRIAL_WARN_DAYS_LEFT,
    applyRevenueCatEvent,
    founderSaleOpen,
    founderUntilISO,
    readEntitlement,
    resolvePremium,
} from "./_premium.js"
import { setCors } from "./_cors.js"

export const config = { api: { bodyParser: false } }

// Legacy Stripe "Pro" — the web-only $9.99 lifetime unlock. Superseded by the
// App Store products in 1.1 ($2.99/mo, $12.99 founder, $0 7-day trial); kept
// working for the people who already bought it, who are now Founding Members.
// Do not add new prices here — App Store prices come from the store itself.
const PRO_PRICE_CENTS = 999
// Zero on purpose. The app tells users coins can only be earned by showing up
// ("not now, not later"), so Pro sells features, never currency. The RPC still
// takes a coin count, so pass 0 rather than skipping the argument.
const PRO_BONUS_COINS = 0
const PRO_NAME = "Chacevia Pro — Lifetime"
const PRO_BLURB = "Every Pro feature we add later, free. One payment, forever."

let _stripe = null
function stripe() {
    if (!_stripe) _stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
    return _stripe
}

function setCorsHeaders(req, res) {
    // Allowlisted origins only — see api/_cors.js.
    setCors(req, res, "GET, POST, OPTIONS", "Content-Type, Authorization")
}

async function readRawBody(req) {
    const chunks = []
    for await (const chunk of req) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
    }
    return Buffer.concat(chunks)
}

// ---------------------------------------------------------------------
// checkout — create a Checkout Session for the logged-in caller
// ---------------------------------------------------------------------
async function handleCheckout(req, res) {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed. Use POST." })
    if (!process.env.STRIPE_SECRET_KEY) return res.status(500).json({ error: "Server is missing STRIPE_SECRET_KEY." })

    // Never accept a user id from the request body — the client could
    // send anyone's. The only identity that counts is whoever's JWT is
    // on the Authorization header.
    const userId = await getUserId(tokenFrom(req, null))
    if (!userId) return res.status(401).json({ error: "Please log in to use Chacevia." })

    try {
        const { data: wallet } = await svc()
            .from("wallets")
            .select("is_pro")
            .eq("user_id", userId)
            .maybeSingle()

        if (wallet && wallet.is_pro) {
            return res.status(200).json({ alreadyPro: true })
        }

        const session = await stripe().checkout.sessions.create({
            mode: "payment",
            line_items: [
                {
                    price_data: {
                        currency: "usd",
                        unit_amount: PRO_PRICE_CENTS,
                        product_data: { name: PRO_NAME, description: PRO_BLURB },
                    },
                    quantity: 1,
                },
            ],
            client_reference_id: userId,
            metadata: { user_id: userId, kind: "pro" },
            success_url: `${process.env.SITE_URL}/?pro=success&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.SITE_URL}/?pro=cancelled`,
            allow_promotion_codes: true,
        })

        return res.status(200).json({ url: session.url })
    } catch (err) {
        console.error("stripe checkout error:", err)
        return res.status(500).json({ error: "Couldn't start checkout. Try again." })
    }
}

// ---------------------------------------------------------------------
// webhook — Stripe's server calls this. Never trust an unverified event:
// without the signature check, anyone who knows the URL could POST
// themselves a free Pro.
// ---------------------------------------------------------------------
async function handleWebhook(req, res) {
    if (req.method !== "POST") return res.status(405).end()
    if (!process.env.STRIPE_WEBHOOK_SECRET) return res.status(500).json({ error: "Server is missing STRIPE_WEBHOOK_SECRET." })

    let event
    try {
        const rawBody = await readRawBody(req)
        event = stripe().webhooks.constructEvent(
            rawBody,
            req.headers["stripe-signature"],
            process.env.STRIPE_WEBHOOK_SECRET
        )
    } catch (err) {
        console.error("stripe webhook signature verification failed:", err && err.message)
        return res.status(400).json({ error: "Invalid signature." })
    }

    // Service role for every DB call here — there's no user JWT on a
    // webhook request, it's Stripe's server calling us.
    try {
        if (event.type === "checkout.session.completed") {
            const session = event.data.object
            const userId = session.metadata && session.metadata.user_id
            const kind = session.metadata && session.metadata.kind

            if (userId && kind === "pro") {
                const { data: granted, error } = await svc().rpc("redeem_pro_purchase", {
                    p_user_id: userId,
                    p_session_id: session.id,
                    p_payment_intent: session.payment_intent,
                    p_amount_cents: session.amount_total,
                    p_currency: session.currency,
                    p_coins: PRO_BONUS_COINS,
                })
                if (error) {
                    console.error("redeem_pro_purchase error:", error)
                } else {
                    // false just means this session was already redeemed
                    // (Stripe retried the webhook) — not an error.
                    console.log(
                        granted
                            ? `Pro granted — session ${session.id}, user ${userId}`
                            : `Session ${session.id} already redeemed, skipping`
                    )
                }
            }
        } else if (event.type === "charge.refunded") {
            const charge = event.data.object
            const { data: refunded, error } = await svc().rpc("refund_pro_purchase", {
                p_payment_intent: charge.payment_intent,
            })
            if (error) {
                console.error("refund_pro_purchase error:", error)
            } else {
                console.log(
                    refunded
                        ? `Pro revoked — payment_intent ${charge.payment_intent}`
                        : `No matching purchase for payment_intent ${charge.payment_intent}`
                )
            }
        }
        // Every other event type: no-op. Still 200, so Stripe doesn't
        // retry an event we were never going to handle.
        return res.status(200).json({ received: true })
    } catch (err) {
        // The event was genuinely valid but something on our side failed —
        // 500 so Stripe retries this one instead of losing it.
        console.error("stripe webhook handling error:", err)
        return res.status(500).json({ error: "Webhook handling failed." })
    }
}

// ---------------------------------------------------------------------
// status — { isPro, proSince, coins } for the logged-in caller. The
// frontend calls this right after returning from checkout so the UI
// updates without racing the webhook.
// ---------------------------------------------------------------------
async function handleStatus(req, res) {
    if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed. Use GET." })

    const userId = await getUserId(tokenFrom(req, null))
    if (!userId) return res.status(401).json({ error: "Please log in to use Chacevia." })

    try {
        const { data } = await svc()
            .from("wallets")
            .select("is_pro, pro_since, coins")
            .eq("user_id", userId)
            .maybeSingle()

        return res.status(200).json({
            isPro: !!(data && data.is_pro),
            proSince: (data && data.pro_since) || null,
            coins: data ? data.coins : 0,
        })
    } catch (err) {
        console.error("stripe status error:", err)
        return res.status(500).json({ error: "Couldn't load status." })
    }
}

// ---------------------------------------------------------------------
// rc-webhook — RevenueCat calls this
// ---------------------------------------------------------------------
async function handleRcWebhook(req, res) {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed. Use POST." })

    // RevenueCat sends whatever Authorization header you configure in the
    // dashboard. Without a secret configured we refuse rather than accept
    // anonymous entitlement changes.
    const want = process.env.REVENUECAT_WEBHOOK_SECRET || ""
    const got = (req.headers && req.headers.authorization) || ""
    if (!want || got !== want) return res.status(401).json({ error: "Unauthorized." })

    let body
    try {
        body = JSON.parse((await readRawBody(req)).toString("utf8") || "{}")
    } catch (e) {
        return res.status(400).json({ error: "Body must be valid JSON." })
    }
    const ev = body.event || body
    const eventId = ev && ev.id
    if (!eventId) return res.status(400).json({ error: "Missing event id." })

    // RevenueCat's app_user_id IS the Supabase user id, because the app logs in
    // to RevenueCat with it. original_app_user_id covers an aliased subscriber.
    const userId = ev.app_user_id || ev.original_app_user_id || null
    const db = svc()

    // Idempotency first: the event id is the primary key, so a retry conflicts
    // and we stop here instead of applying anything twice.
    const { error: insErr } = await db.from("billing_events").insert({
        event_id: String(eventId),
        user_id: userId,
        type: ev.type || null,
        event_ms: Number(ev.event_timestamp_ms || 0) || null,
        payload: ev,
    })
    if (insErr) {
        // 23505 = unique violation = we have seen this event already.
        if (insErr.code === "23505") return res.status(200).json({ ok: true, duplicate: true })
        console.error("billing_events insert failed:", insErr)
        return res.status(500).json({ error: "Could not record event." })
    }

    if (!userId) return res.status(200).json({ ok: true, skipped: "no app_user_id" })

    try {
        const result = await applyRevenueCatEvent(db, ev, userId)
        // 200 even when ignored: a non-2xx makes RevenueCat retry an event we
        // have already decided about.
        return res.status(200).json({ ok: true, result })
    } catch (err) {
        console.error("revenuecat apply error:", err)
        // A real failure DOES deserve a retry.
        return res.status(500).json({ error: "Could not apply event." })
    }
}

// ---------------------------------------------------------------------
// premium — the single status read for the app and the web
// ---------------------------------------------------------------------
async function handlePremium(req, res) {
    if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed. Use GET." })

    const userId = await getUserId(tokenFrom(req, null))
    if (!userId) return res.status(401).json({ error: "Please log in to use Chacevia." })

    try {
        const db = svc()
        const row = await readEntitlement(db, userId)
        const now = new Date()
        const state = resolvePremium(row, now)

        const { data: claim } = await db
            .from("trial_claims")
            .select("claimed_at, expires_at, warned_at")
            .eq("user_id", userId)
            .maybeSingle()

        let trial = { claimed: false, eligible: true }
        if (claim) {
            const ms = new Date(claim.expires_at).getTime() - now.getTime()
            const daysLeft = Math.max(0, Math.ceil(ms / 86400000))
            trial = {
                claimed: true,
                eligible: false,
                expiresAt: claim.expires_at,
                daysLeft,
                active: ms > 0,
                // Day 6 of 7: one day left, and Rocco has not said so yet.
                needsWarning: ms > 0 && daysLeft <= TRIAL_WARN_DAYS_LEFT && !claim.warned_at,
            }
        }

        return res.status(200).json({
            ...state,
            trial,
            trialDays: TRIAL_DAYS,
            founderSaleOpen: founderSaleOpen(now),
            founderUntil: founderUntilISO(),
        })
    } catch (err) {
        console.error("premium status error:", err)
        return res.status(500).json({ error: "Couldn't load your plan." })
    }
}

// ---------------------------------------------------------------------
// trial — claim the 7-day free trial
// ---------------------------------------------------------------------
// The client proves the $0 purchase happened by sending Apple's
// original_transaction_id for it. The SERVER sets the expiry; a client that
// asks for a longer trial is ignored, because it is never asked.
async function handleTrial(req, res) {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed. Use POST." })

    const userId = await getUserId(tokenFrom(req, null))
    if (!userId) return res.status(401).json({ error: "Please log in to use Chacevia." })

    let body = {}
    try {
        body = JSON.parse((await readRawBody(req)).toString("utf8") || "{}")
    } catch (e) {
        return res.status(400).json({ error: "Body must be valid JSON." })
    }
    const appleTxn = body.appleOriginalTransactionId
        ? String(body.appleOriginalTransactionId).slice(0, 120)
        : null

    const db = svc()
    const now = new Date()

    try {
        const existing = await readEntitlement(db, userId)
        const state = resolvePremium(existing, now)
        // Already premium by a route that is better than a trial — nothing to do,
        // and definitely nothing to downgrade.
        if (state.isPremium && state.source !== "trial") {
            return res.status(200).json({ ok: true, alreadyPremium: true, source: state.source })
        }

        const expires = new Date(now.getTime() + TRIAL_DAYS * 86400000).toISOString()
        const { error } = await db.from("trial_claims").insert({
            user_id: userId,
            apple_original_transaction_id: appleTxn,
            claimed_at: now.toISOString(),
            expires_at: expires,
        })
        if (error) {
            // Both "one per user" and "one per Apple ID" are unique indexes, so
            // a second attempt lands here rather than in a race.
            if (error.code === "23505") {
                return res.status(409).json({
                    error: "That free trial has already been used.",
                    alreadyUsed: true,
                })
            }
            throw error
        }

        await db.from("entitlements").upsert(
            {
                user_id: userId,
                is_premium: true,
                source: "trial",
                product_id: PRODUCT_TRIAL,
                expires_at: expires,
                will_renew: false,
                updated_at: now.toISOString(),
            },
            { onConflict: "user_id" }
        )

        return res.status(200).json({ ok: true, expiresAt: expires, daysLeft: TRIAL_DAYS })
    } catch (err) {
        console.error("trial claim error:", err)
        return res.status(500).json({ error: "Couldn't start your trial. Try again." })
    }
}

// ---------------------------------------------------------------------
// trial-warned — record that Rocco has given the day-6 heads-up
// ---------------------------------------------------------------------
// Stamped server-side so the warning is given once per trial, not once per app
// launch. The client cannot choose the timestamp; it only reports that it said
// the thing.
async function handleTrialWarned(req, res) {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed. Use POST." })

    const userId = await getUserId(tokenFrom(req, null))
    if (!userId) return res.status(401).json({ error: "Please log in to use Chacevia." })

    try {
        await svc()
            .from("trial_claims")
            .update({ warned_at: new Date().toISOString() })
            .eq("user_id", userId)
            .is("warned_at", null)
        return res.status(200).json({ ok: true })
    } catch (err) {
        console.error("trial warned error:", err)
        // Not worth an error to the user — the worst case is one extra reminder.
        return res.status(200).json({ ok: false })
    }
}

// ---------------------------------------------------------------------
export default async function handler(req, res) {
    setCorsHeaders(req, res)
    if (req.method === "OPTIONS") return res.status(204).end()

    const action = req.query && req.query.action

    if (action === "webhook") return handleWebhook(req, res)
    if (action === "rc-webhook") return handleRcWebhook(req, res)
    if (action === "premium") return handlePremium(req, res)
    if (action === "trial") return handleTrial(req, res)
    if (action === "trial-warned") return handleTrialWarned(req, res)
    if (action === "status") return handleStatus(req, res)
    if (action === "checkout") return handleCheckout(req, res)

    return res.status(404).json({ error: "Unknown action." })
}
