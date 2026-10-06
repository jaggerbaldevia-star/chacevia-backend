// api/_schools.js
// School name/region ↔ Canvas host. Not an API route (leading underscore).
//
// What is stored is the school and its Canvas HOST only (e.g.
// lincoln.instructure.com) — never a feed URL, never who connected it, never
// how many students. It lets the next student at the same school skip "which
// Canvas is yours?".

// Must stay identical to the generated column public.schools.match_key:
//   lower(regexp_replace(coalesce(name,''), '[^a-zA-Z0-9]+', '', 'g'))
//   || '|' ||
//   lower(regexp_replace(coalesce(region,''), '[^a-zA-Z0-9]+', '', 'g'))
// so "St. Mary's" and "St Marys" in "Omaha, NE" are one school.
export function keyPart(s) {
    return String(s || "").replace(/[^a-zA-Z0-9]+/g, "").toLowerCase()
}

export function schoolMatchKey(name, region) {
    return keyPart(name) + "|" + keyPart(region)
}

// The search box → up to 4 alphanumeric words, each of which must appear in
// match_key. Alphanumeric only, so nothing typed can become a LIKE wildcard or
// a PostgREST filter fragment.
export function searchTerms(q) {
    return String(q || "")
        .slice(0, 80)
        .split(/\s+/)
        .map(keyPart)
        .filter((w) => w.length >= 2)
        .slice(0, 4)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Validates the optional `school` a client sends with canvas-connect. Returns
// {id} | {name, region} | null. Anything odd is dropped rather than refused:
// remembering the school is a nicety, never a reason to fail a connect.
export function cleanSchool(raw) {
    if (!raw || typeof raw !== "object") return null
    if (typeof raw.id === "string" && UUID.test(raw.id)) return { id: raw.id.toLowerCase() }
    const name = typeof raw.name === "string" ? raw.name.replace(/\s+/g, " ").trim() : ""
    const region = typeof raw.region === "string" ? raw.region.replace(/\s+/g, " ").trim() : ""
    if (name.length < 3 || name.length > 120 || keyPart(name).length < 3) return null
    if (region.length > 80) return null
    return { name, region: region || null }
}

export const SCHOOL_SEARCH_MAX = 8

export async function searchSchools(db, q) {
    const words = searchTerms(q)
    if (!words.length) return []
    let query = db.from("schools").select("id, name, region, canvas_host")
    for (const w of words) query = query.like("match_key", `%${w}%`)
    const { data, error } = await query.order("name").limit(SCHOOL_SEARCH_MAX)
    if (error) throw error
    return (data || []).map((s) => ({ id: s.id, name: s.name, region: s.region, host: s.canvas_host || null }))
}

// Remember which Canvas host a school uses. Only fills an EMPTY host: the first
// working feed wins, so one student can't repoint a school everyone else uses.
export async function rememberSchoolHost(db, school, host) {
    const s = cleanSchool(school)
    if (!s || !host) return false
    const now = new Date().toISOString()
    if (s.id) {
        const { error } = await db
            .from("schools")
            .update({ canvas_host: host, updated_at: now })
            .eq("id", s.id)
            .is("canvas_host", null)
        if (error) throw error
        return true
    }
    const { error: insErr } = await db
        .from("schools")
        .upsert({ name: s.name, region: s.region, canvas_host: host }, { onConflict: "match_key", ignoreDuplicates: true })
    if (insErr) throw insErr
    const { error: updErr } = await db
        .from("schools")
        .update({ canvas_host: host, updated_at: now })
        .eq("match_key", schoolMatchKey(s.name, s.region))
        .is("canvas_host", null)
    if (updErr) throw updErr
    return true
}
