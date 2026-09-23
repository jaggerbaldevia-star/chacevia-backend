// api/account.js
//
// Account lifecycle. Behaviors split by ?action=, same pattern as stripe.js
// and schedule-extract.js, to stay under Vercel's serverless function cap:
//
//   ?action=delete  (POST) — permanently deletes the caller's account
//
// THIS FILE IS THE 12TH AND LAST FUNCTION. Vercel Hobby caps serverless
// functions at 12, counting every api/*.js that does not start with "_".
// Crossing 12 makes the build fail SILENTLY: Vercel keeps serving the last
// good deployment and new endpoints 404 forever. Any future endpoint must be
// another ?action= on an existing file, never a new one.
//
// The caller is resolved from the Authorization header alone. A user_id in
// the body is never read — the client could send anyone's, and this is a
// destructive operation.

import { svc, getUserId } from "./_coins.js"

// Every table holding rows owned by a user, children before parents so the
// explicit deletes don't depend on cascade ordering.
//
// Not listed on purpose:
//   ai_cache   — keyed on a content hash, no user_id, shared between users
//   cosmetics  — the shop catalog, not user data
//   push_sends — keyed on a pg_net request id, no user_id
//   purchases  — deliberately KEPT and anonymized instead; see below
const USER_TABLES = [
    "reminders", // -> assignments
    "assignments", // -> classes
    "classes",
    "schedule_meta",
    "rocco", // the drawn pixel Rocco
    "rocco_profile",
    "rocco_memory",
    "user_cosmetics",
    "streaks",
    "daily_claims",
    "usage_counters",
    "push_tokens",
    "calendar_tokens",
    "wallets",
]

function setCorsHeaders(res) {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")
}

// A table named here but absent in this database is not a failure — the
// schema has grown in stages and not every install has every table. Anything
// else (permissions, constraints, connectivity) is fatal: a half-deleted
// account is worse than a failed delete, so we stop and say which step broke.
function isMissingTable(error) {
    if (!error) return false
    const code = error.code || ""
    if (code === "42P01" || code === "PGRST205" || code === "PGRST204") return true
    return /does not exist|could not find the table/i.test(error.message || "")
}

// ---------------------------------------------------------------------
// delete — wipe the caller's account and data
// ---------------------------------------------------------------------
async function handleDelete(req, res) {
    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed. Use POST." })
    }
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        return res.status(500).json({ error: "Server is missing Supabase credentials." })
    }

    // Authorization header only. Never a body field.
    const h = req.headers && (req.headers.authorization || req.headers.Authorization)
    const token = typeof h === "string" && h.startsWith("Bearer ") ? h.slice(7) : ""
    const userId = await getUserId(token)
    if (!userId) {
        return res.status(401).json({ error: "Please log in." })
    }

    const db = svc()
    const done = []

    // Purchases come first, and on purpose. The foreign key to auth.users was
    // created `on delete cascade` (pro-setup.sql), so deleting the auth user
    // would take the payment records with it — records the privacy policy says
    // we retain for accounting. Detaching them here means they survive even if
    // the constraint hasn't been migrated yet.
    //
    // Only user_id is cleared. stripe_session_id is `unique not null` so it
    // cannot be nulled, and the Stripe references are what make a refund or
    // chargeback reconcilable later; severing the link to a person is the
    // point, not erasing the transaction.
    {
        const { error } = await db
            .from("purchases")
            .update({ user_id: null })
            .eq("user_id", userId)
        if (error && !isMissingTable(error)) {
            return res.status(500).json({
                error: "Couldn't detach purchase records. Nothing was deleted.",
                step: "anonymize:purchases",
                detail: error.message,
                completed: done,
            })
        }
        done.push("anonymize:purchases")
    }

    for (const table of USER_TABLES) {
        const { error } = await db.from(table).delete().eq("user_id", userId)
        if (error && !isMissingTable(error)) {
            return res.status(500).json({
                error: `Couldn't delete your ${table}. Your account still exists — try again.`,
                step: `delete:${table}`,
                detail: error.message,
                completed: done,
            })
        }
        done.push(`delete:${table}`)
    }

    // Last, because until this succeeds the user can still log in and retry.
    // Doing it first would leave orphaned rows with no way to authenticate
    // back in and clear them.
    {
        const { error } = await db.auth.admin.deleteUser(userId)
        if (error) {
            return res.status(500).json({
                error: "Your data was removed but the login itself could not be deleted. Contact support.",
                step: "auth.admin.deleteUser",
                detail: error.message,
                completed: done,
            })
        }
        done.push("auth.admin.deleteUser")
    }

    return res.status(200).json({ ok: true, completed: done })
}

export default async function handler(req, res) {
    setCorsHeaders(res)
    if (req.method === "OPTIONS") return res.status(200).end()

    const action = (req.query && req.query.action) || ""
    if (action === "delete") return handleDelete(req, res)

    return res.status(400).json({ error: "Unknown action. Use ?action=delete." })
}
