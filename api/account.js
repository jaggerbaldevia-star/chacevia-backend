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
import { setCors } from "./_cors.js"

// Every table holding rows owned by a user, children before parents so the
// explicit deletes don't depend on cascade ordering.
//
// Not listed on purpose:
//   ai_cache   — keyed on a content hash, no user_id, shared between users
//   cosmetics  — the shop catalog, not user data
//   push_sends — has no user_id, but DOES hold the device push token, so it is
//                cleared separately and EARLIER; see clearPushSends below
//   purchases  — deliberately KEPT and anonymized instead; see below
//
//   calendar_tokens does not exist in the database yet (api/calendar.js has
//   never been deployed). It stays listed because isMissingTable() tolerates an
//   absent table, and the day calendar ships this list is already right.
const USER_TABLES = [
    "reminders", // -> assignments
    "assignments", // -> classes
    "classes",
    "schedule_meta",
    "rocco", // the drawn pixel Rocco
    "rocco_profile",
    "rocco_memory",
    // Legacy: the tool output the pre-18-Sep web app saved (kind, title,
    // content jsonb). Nothing writes it any more, which is exactly why it was
    // missed here — it still holds real users' generated content.
    "history",
    "user_cosmetics",
    "streaks",
    "daily_claims",
    "usage_counters",
    "push_tokens",
    "calendar_tokens",
    "wallets",
]

function setCorsHeaders(req, res) {
    // Allowlisted origins only — see api/_cors.js.
    setCors(req, res, "POST, OPTIONS", "Content-Type, Authorization")
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

// push_sends is the reminder cron's delivery log: request_id, token,
// reminder_id, created_at. No user_id — which is why it was excluded — but
// `token` is the user's device push token, the same value stored in
// push_tokens. A deleted account leaving its device token behind in a log is
// still their data.
//
// ORDER MATTERS. The only way to find these rows is by the tokens in
// push_tokens, so this MUST run before push_tokens is deleted. Once those rows
// are gone the link is unrecoverable and the log strands forever. That is why
// this is its own step ahead of the loop rather than another name in the list.
async function clearPushSends(db, userId) {
    const { data, error } = await db.from("push_tokens").select("token").eq("user_id", userId)
    if (error) {
        // No push_tokens table at all — then there are no sends to match.
        if (isMissingTable(error)) return null
        return error
    }
    const tokens = (data || []).map((r) => r.token).filter(Boolean)
    if (!tokens.length) return null

    const { error: delErr } = await db.from("push_sends").delete().in("token", tokens)
    if (delErr && !isMissingTable(delErr)) return delErr
    return null
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

    // Before the loop, because the loop deletes push_tokens.
    {
        const error = await clearPushSends(db, userId)
        if (error) {
            return res.status(500).json({
                error: "Couldn't clear your notification history. Nothing was deleted.",
                step: "delete:push_sends",
                detail: error.message,
                completed: done,
            })
        }
        done.push("delete:push_sends")
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
    setCorsHeaders(req, res)
    if (req.method === "OPTIONS") return res.status(200).end()

    const action = (req.query && req.query.action) || ""
    if (action === "delete") return handleDelete(req, res)

    return res.status(400).json({ error: "Unknown action. Use ?action=delete." })
}
