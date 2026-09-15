// api/_coins.js
// Shared coin helpers used by the AI endpoints.
// Uses the Supabase SERVICE ROLE key, which bypasses row-level security,
// so ONLY the backend can read/modify coin balances.
// (Files starting with "_" are not deployed as their own API routes.)

import { createClient } from "@supabase/supabase-js"

let _client = null
export function svc() {
    if (!_client) {
        _client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
            auth: { persistSession: false, autoRefreshToken: false },
        })
    }
    return _client
}

// Pull the logged-in user's access token from the request
export function tokenFrom(req, body) {
    const h = req.headers && (req.headers.authorization || req.headers.Authorization)
    if (typeof h === "string" && h.startsWith("Bearer ")) return h.slice(7)
    if (body && body.accessToken) return body.accessToken
    return ""
}

// Verify the token and return the user's id (or null)
export async function getUserId(token) {
    if (!token) return null
    try {
        const { data, error } = await svc().auth.getUser(token)
        if (error || !data || !data.user) return null
        return data.user.id
    } catch {
        return null
    }
}

export async function getBalance(userId) {
    try {
        const { data } = await svc().from("wallets").select("coins").eq("user_id", userId).single()
        return data ? data.coins : 0
    } catch {
        return 0
    }
}

// Spend coins atomically. Returns the new balance, or -1 if too few.
export async function spend(userId, amount) {
    const { data, error } = await svc().rpc("spend_coins", { p_user_id: userId, p_amount: amount })
    if (error) throw error
    return typeof data === "number" ? data : -1
}

// A single guard for endpoints: require login + rate limit + enough coins
// BEFORE doing work. Pass `endpoint` (e.g. "rocco-chat") to meter it.
// Returns { ok:true, userId, balance } or { ok:false, status, payload }.
export async function requireCoins(req, body, cost, endpoint) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        // Coins not configured yet — let the request through (no charge).
        return { ok: true, userId: null, balance: null, cost: 0, skip: true }
    }
    const userId = await getUserId(tokenFrom(req, body))
    if (!userId) return { ok: false, status: 401, payload: { error: "Please log in to use Chacevia." } }

    if (endpoint) {
        const { checkLimit } = await import("./_limits.js")
        const limit = await checkLimit(userId, endpoint)
        if (!limit.ok) return limit
    }

    const balance = await getBalance(userId)
    if (balance < cost) return { ok: false, status: 402, payload: { error: "Not enough coins.", needCoins: true, coins: balance } }
    return { ok: true, userId, balance, cost }
}

// Call AFTER the work succeeds. Deducts and returns the remaining balance.
export async function chargeAfter(guard) {
    if (!guard || guard.skip || !guard.userId) return guard ? guard.balance : null
    try {
        const nb = await spend(guard.userId, guard.cost)
        return nb >= 0 ? nb : guard.balance - guard.cost
    } catch {
        return guard.balance
    }
}
