// api/_schools.js
// Which Canvas hosts we've seen, and each account's own Canvas host. Not an
// API route (leading underscore).
//
// We no longer ask for the school by name: the host comes from the Calendar
// Feed link itself (e.g. lincoln.instructure.com). Stored is the HOST only —
// never the feed URL, never who connected it, never how many students.
//   - public.schools: one row per host. Until something knows the school's real
//     name, the row is named after its host.
//   - the account: auth app_metadata.canvas_host (server-written, read-only to
//     the student, and kept after a Canvas disconnect).

const HOST = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

export function cleanCanvasHost(host) {
    const h = String(host || "").trim().toLowerCase()
    return HOST.test(h) ? h : ""
}

// Best-effort: callers log failures, a connect never fails because of this.
export async function rememberCanvasHost(db, userId, host) {
    const h = cleanCanvasHost(host)
    if (!h) return false

    const { data: have, error: findErr } = await db.from("schools").select("id").eq("canvas_host", h).limit(1)
    if (findErr) throw findErr
    if (!have || !have.length) {
        const { error } = await db
            .from("schools")
            .upsert({ name: h, canvas_host: h }, { onConflict: "match_key", ignoreDuplicates: true })
        if (error) throw error
    }

    // app_metadata is replaced as a whole on update, so merge into what's there.
    const { data: got, error: getErr } = await db.auth.admin.getUserById(userId)
    if (getErr) throw getErr
    const meta = (got && got.user && got.user.app_metadata) || {}
    if (meta.canvas_host !== h) {
        const { error } = await db.auth.admin.updateUserById(userId, { app_metadata: { ...meta, canvas_host: h } })
        if (error) throw error
    }
    return true
}
