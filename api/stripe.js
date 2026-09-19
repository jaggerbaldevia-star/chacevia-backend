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

export const config = { api: { bodyParser: false } }

const PRO_PRICE_CENTS = 999 // founding price. Change to 1499 later.
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

function setCorsHeaders(res) {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")
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
export default async function handler(req, res) {
    setCorsHeaders(res)
    if (req.method === "OPTIONS") return res.status(204).end()

    const action = req.query && req.query.action

    if (action === "webhook") return handleWebhook(req, res)
    if (action === "status") return handleStatus(req, res)
    if (action === "checkout") return handleCheckout(req, res)

    return res.status(404).json({ error: "Unknown action." })
}
