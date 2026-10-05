// api/_canvas.js
// Canvas Calendar Feed import. Not an API route (leading underscore) — the
// three actions live on schedule-extract.js to stay under Vercel's 12-function
// cap.
//
// The feed link is a bearer credential: anyone holding it can read that
// student's entire assignment calendar, forever, with no login. It is treated
// like a password throughout — encrypted at rest with a key the database never
// sees, never returned to the client, never written to a log line.

import crypto from "crypto"
import dns from "dns"
import https from "https"
import net from "net"
import ICAL from "ical.js"
import { shortenBatch, ruleShorten, ruleShortClass } from "./_shorten.js"

// Feature flag. Absent or not "1" and every Canvas action 404s, so while this
// is hidden the endpoints do not exist as far as the outside world is
// concerned. Turn on in Vercel for the 1.1 review.
export function canvasEnabled() {
    return String(process.env.CANVAS_ENABLED || "") === "1"
}

// Beta allowlist. CANVAS_BETA_USERS is a comma-separated list of Supabase user
// ids; only those accounts can see or use Canvas.
//
// An empty or missing list means NOBODY, not everybody. The other reading is
// how a feature flag turns into an accidental launch: someone sets
// CANVAS_ENABLED=1 to test, forgets the list, and it's live for every user at
// once. Opening this to everyone should take a deliberate edit, which is what
// CANVAS_BETA_USERS=* is for.
export function canvasAllowed(userId) {
    if (!canvasEnabled()) return false
    const raw = String(process.env.CANVAS_BETA_USERS || "").trim()
    if (!raw) return false
    if (raw === "*") return true
    return raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .includes(String(userId))
}

// ---------------------------------------------------------------------
// Encryption — AES-256-GCM
// ---------------------------------------------------------------------
// CANVAS_FEED_KEY is 32 random bytes, base64. Generate with:
//     openssl rand -base64 32
// Rotating it makes every stored link undecryptable, which is a disconnect for
// every user rather than a data loss — they re-paste and carry on.
function feedKey() {
    const raw = process.env.CANVAS_FEED_KEY || ""
    if (!raw) throw new Error("CANVAS_FEED_KEY is not set")
    const key = Buffer.from(raw, "base64")
    if (key.length !== 32) {
        throw new Error("CANVAS_FEED_KEY must be 32 bytes, base64-encoded")
    }
    return key
}

export function encryptFeed(url) {
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv("aes-256-gcm", feedKey(), iv)
    const ct = Buffer.concat([cipher.update(String(url), "utf8"), cipher.final()])
    return {
        feed_ciphertext: ct.toString("base64"),
        feed_iv: iv.toString("base64"),
        feed_tag: cipher.getAuthTag().toString("base64"),
    }
}

export function decryptFeed(row) {
    const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        feedKey(),
        Buffer.from(row.feed_iv, "base64")
    )
    decipher.setAuthTag(Buffer.from(row.feed_tag, "base64"))
    return Buffer.concat([
        decipher.update(Buffer.from(row.feed_ciphertext, "base64")),
        decipher.final(),
    ]).toString("utf8")
}

// ---------------------------------------------------------------------
// SSRF defence
// ---------------------------------------------------------------------
// This URL comes from a text box, so it is hostile input pointed at our own
// outbound network. Everything below assumes someone will try
// http://169.254.169.254/ or a hostname that resolves to 127.0.0.1.

const FEED_PATH = /^\/feeds\/calendars\/[A-Za-z0-9._-]+\.ics$/

function ipv4IsPrivate(ip) {
    const p = ip.split(".").map(Number)
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
    const [a, b] = p
    if (a === 0) return true // "this network"
    if (a === 10) return true // private
    if (a === 127) return true // loopback
    if (a === 169 && b === 254) return true // link-local, incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true // private
    if (a === 192 && b === 168) return true // private
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
    if (a === 192 && b === 0) return true // IETF protocol assignments
    if (a >= 224) return true // multicast + reserved
    return false
}

// Expands any IPv6 text form to its eight 16-bit groups. Needed because the
// same address has several spellings and the URL parser picks its own: pass
// https://[::ffff:127.0.0.1]/ through `new URL()` and the hostname comes back
// as ::ffff:7f00:1. Matching on text alone misses that, so everything is
// compared numerically after expansion.
function expandIPv6(ip) {
    let s = ip.toLowerCase()
    // A trailing dotted quad (::ffff:127.0.0.1) becomes two hex groups.
    const dotted = s.match(/(\d+\.\d+\.\d+\.\d+)$/)
    if (dotted) {
        const p = dotted[1].split(".").map(Number)
        if (p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
        const hex = ((p[0] << 8) | p[1]).toString(16) + ":" + ((p[2] << 8) | p[3]).toString(16)
        s = s.slice(0, -dotted[1].length) + hex
    }
    const halves = s.split("::")
    if (halves.length > 2) return null
    const head = halves[0] ? halves[0].split(":").filter(Boolean) : []
    const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":").filter(Boolean) : []) : []
    const fill = 8 - head.length - tail.length
    if (halves.length === 1) {
        if (head.length !== 8) return null
        return head.map((h) => parseInt(h, 16))
    }
    if (fill < 0) return null
    return head
        .concat(new Array(fill).fill("0"))
        .concat(tail)
        .map((h) => parseInt(h, 16))
}

function ipIsPrivate(ip) {
    if (net.isIPv4(ip)) return ipv4IsPrivate(ip)
    if (!net.isIPv6(ip)) return true
    const g = expandIPv6(ip)
    if (!g || g.some((n) => !Number.isInteger(n))) return true // unparseable = refuse

    // IPv4-mapped (::ffff:a.b.c.d, however it's spelled) — the classic way past
    // a check that only understands v6.
    if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
        return ipv4IsPrivate([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join("."))
    }
    // IPv4-compatible (::a.b.c.d) — deprecated, same trick.
    if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0) {
        if (g[6] !== 0 || g[7] !== 0) {
            return ipv4IsPrivate([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join("."))
        }
        return true // :: unspecified
    }
    if (g.every((n, i) => (i < 7 ? n === 0 : n === 1))) return true // ::1 loopback
    if ((g[0] & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
    if ((g[0] & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
    if ((g[0] & 0xff00) === 0xff00) return true // ff00::/8 multicast
    return false
}

/**
 * Validates the URL's shape. Throws a CanvasError with a friendly message.
 *
 * Deliberately NOT restricted to *.instructure.com: plenty of universities
 * self-host Canvas on their own domain, and an allowlist would turn "your
 * school is unusual" into "this feature is broken".
 */
export function parseFeedUrl(raw) {
    let u
    try {
        u = new URL(String(raw || "").trim())
    } catch (e) {
        throw new CanvasError("bad-link", "That doesn't look like a link. Copy the whole thing from Canvas, starting with https://")
    }
    if (u.protocol !== "https:") {
        throw new CanvasError("bad-link", "The link has to start with https:// — copy it straight from Canvas.")
    }
    if (u.username || u.password) {
        throw new CanvasError("bad-link", "That link has a username in it, which Canvas feeds don't use. Copy it again from Canvas.")
    }
    if (!FEED_PATH.test(u.pathname)) {
        throw new CanvasError("bad-link", "That's not a Calendar Feed link. In Canvas go to Calendar, click Calendar Feed, and copy the link that ends in .ics")
    }
    return u
}

export class CanvasError extends Error {
    constructor(code, friendly) {
        super(friendly)
        this.code = code
        this.friendly = friendly
    }
}

const MAX_BYTES = 5 * 1024 * 1024
const TIMEOUT_MS = 10000
const MAX_REDIRECTS = 2

/**
 * Fetches the .ics over a connection pinned to an IP address WE resolved and
 * checked.
 *
 * The ordinary approach — validate the hostname, then hand the hostname to
 * fetch() — has a hole: the attacker's DNS can answer publicly for our check
 * and privately a millisecond later for the real connection (DNS rebinding).
 * Passing our own `lookup` to https.request removes the second resolution
 * entirely; the socket goes to the address we vetted. TLS still verifies the
 * certificate against the real hostname (servername + the Host header), so a
 * pinned IP does not weaken the transport.
 */
async function fetchOnce(u, redirectsLeft) {
    // A hostname that is already an IP literal never reaches a resolver, so
    // check it directly. Without this, https://[::1]/... fell through to the
    // "can't find that server" branch — blocked either way, but by accident of
    // a DNS quirk rather than by the rule that's supposed to catch it.
    const literal = u.hostname.replace(/^\[|\]$/g, "")
    if (net.isIP(literal)) {
        if (ipIsPrivate(literal)) {
            throw new CanvasError("blocked", "That link points somewhere I'm not allowed to go.")
        }
    }

    const addrs = net.isIP(literal)
        ? [{ address: literal, family: net.isIPv6(literal) ? 6 : 4 }]
        : await dns.promises.lookup(u.hostname, { all: true, verbatim: true }).catch(() => [])
    if (!addrs.length) {
        throw new CanvasError("dns", "I can't find that school's server. Check the link, or your school may be blocking calendar feeds.")
    }
    // If ANY answer is private, treat the whole name as hostile rather than
    // cherry-picking a public one — a mixed answer is not a thing a real
    // school's DNS does.
    for (const a of addrs) {
        if (ipIsPrivate(a.address)) {
            throw new CanvasError("blocked", "That link points somewhere I'm not allowed to go.")
        }
    }
    const pinned = addrs[0]
    // Every address in `addrs` has already been checked public above, so any of
    // them is safe to hand back. Returning all of them keeps IPv4/IPv6 fallback
    // working instead of betting the whole request on addrs[0].
    const vetted = addrs.map((a) => ({ address: a.address, family: a.family }))

    return await new Promise((resolve, reject) => {
        const req = https.request(
            {
                protocol: "https:",
                host: u.hostname, // Host header + cert verification
                servername: u.hostname, // SNI
                path: u.pathname + u.search,
                method: "GET",
                // A private agent, not the global one. The global agent pools
                // sockets by host name, so a connection opened by some earlier
                // request could be reused and our pinned lookup never called —
                // which would quietly reopen the rebinding hole this closes.
                agent: new https.Agent({ keepAlive: false, maxSockets: 1 }),
                // The whole point: no second DNS resolution.
                //
                // MUST honour opts.all. Since Node 20, net.connect enables
                // Happy Eyeballs (autoSelectFamily) by default and calls a
                // custom lookup with { all: true }, expecting an ARRAY of
                // { address, family }. Answering with the legacy
                // cb(null, address, family) form made Node read `address` as
                // undefined and every connect failed with
                // ERR_INVALID_IP_ADDRESS — before TLS, so it surfaced as
                // "I couldn't reach that server" for every school.
                lookup: (hostname, opts, cb) =>
                    opts && opts.all
                        ? cb(null, vetted)
                        : cb(null, pinned.address, pinned.family),
                headers: {
                    Accept: "text/calendar, text/plain;q=0.8, */*;q=0.5",
                    "User-Agent": "Chacevia/1.1 (+https://chacevia.com)",
                },
                timeout: TIMEOUT_MS,
            },
            (res) => {
                const status = res.statusCode || 0

                if (status >= 300 && status < 400 && res.headers.location) {
                    res.resume()
                    if (redirectsLeft <= 0) {
                        return reject(new CanvasError("redirect", "That link keeps bouncing around. Copy a fresh Calendar Feed link from Canvas."))
                    }
                    let next
                    try {
                        next = new URL(res.headers.location, u)
                    } catch (e) {
                        return reject(new CanvasError("redirect", "That link redirects somewhere I can't follow."))
                    }
                    // Same host only, and the destination gets the full
                    // validation again — a redirect is just as untrusted as
                    // the URL the user typed.
                    if (next.hostname !== u.hostname) {
                        return reject(new CanvasError("redirect", "That link redirects to a different site, so I stopped."))
                    }
                    let validated
                    try {
                        validated = parseFeedUrl(next.toString())
                    } catch (e) {
                        return reject(e)
                    }
                    return resolve(fetchOnce(validated, redirectsLeft - 1))
                }

                if (status === 401 || status === 403) {
                    res.resume()
                    return reject(new CanvasError("expired", "Canvas turned that link down. It was probably reset — get a fresh Calendar Feed link and paste it again."))
                }
                if (status === 404) {
                    res.resume()
                    return reject(new CanvasError("not-found", "Canvas says that feed doesn't exist any more. Copy a new Calendar Feed link."))
                }
                if (status >= 500) {
                    res.resume()
                    return reject(new CanvasError("canvas-down", "Canvas isn't answering right now. Try again in a bit — nothing's lost."))
                }
                if (status !== 200) {
                    res.resume()
                    return reject(new CanvasError("http", "Canvas gave me an answer I didn't understand. Try again in a bit."))
                }

                let size = 0
                const chunks = []
                res.on("data", (c) => {
                    size += c.length
                    if (size > MAX_BYTES) {
                        req.destroy()
                        return reject(new CanvasError("too-big", "That calendar is enormous — bigger than I can read. Tell me and I'll raise the limit."))
                    }
                    chunks.push(c)
                })
                res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
                res.on("error", () => reject(new CanvasError("network", "I lost the connection to Canvas. Try again in a moment.")))
            }
        )

        req.on("timeout", () => {
            req.destroy()
            reject(new CanvasError("timeout", "Canvas took too long to answer. Your school may be blocking calendar feeds from outside."))
        })
        req.on("error", (err) => {
            if (err instanceof CanvasError) return reject(err)
            reject(new CanvasError("network", "I couldn't reach that server. Check the link, or your school may be blocking calendar feeds."))
        })
        req.end()
    })
}

export async function fetchIcs(u) {
    return await fetchOnce(u, MAX_REDIRECTS)
}

// ---------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------

// Canvas titles read "Essay 1 [ENG 101]" — the bracketed tail is the course.
const TITLE_COURSE = /^(.*?)\s*\[([^\]]+)\]\s*$/

// An assignment is identified by BOTH signals, not either: the UID Canvas mints
// for assignment events, and an assignment id in the URL. Personal calendar
// entries, office hours and school-wide events carry neither, and requiring
// both keeps someone's dentist appointment out of their homework.
//
// The URL shape was WRONG in the first version of this file, and a real feed is
// what caught it. I assumed a path of /courses/<id>/assignments/<id>; Canvas
// actually emits the calendar page with the assignment in the FRAGMENT:
//   https://saas.instructure.com/calendar?include_contexts=course_3228&...#assignment_23040
// Requiring a /assignments/<id> path meant all 36 events in the test feed were
// rejected and the import silently did nothing. Both spellings are accepted now.
const UID_ASSIGNMENT = /assignment/i
const URL_ASSIGNMENT = /(#assignment_(\d+))|(\/assignments\/(\d+))/i

// The stable identity of an assignment, used for dedupe. The UID is not it:
// Canvas mints a separate "event-assignment-override-<n>" for a section with
// its own due date, so a student who sees both the base event and an override
// would get two rows for one piece of homework. The assignment id in the URL is
// the same in both. The test feed happened to contain no such pair — 36 events,
// 36 distinct ids — so this is defence against a case I could not reproduce
// rather than one I observed.
function assignmentIdFrom(url) {
    const m = String(url || "").match(URL_ASSIGNMENT)
    if (!m) return null
    return m[2] || m[4] || null
}

// Strips a trailing parenthetical that just repeats the course, so
//   "Reading #1 (History 10 - Deveau - (HIST1001-20)) [History 10 - Deveau]"
// becomes "Reading #1" rather than keeping the noise the bracket already said.
// Counts depth from the end because the tail nests: (Course - (CODE)).
function stripCourseTail(title, course) {
    if (!course || !title.endsWith(")")) return title
    let depth = 0
    for (let i = title.length - 1; i >= 0; i--) {
        const ch = title[i]
        if (ch === ")") depth++
        else if (ch === "(") {
            depth--
            if (depth === 0) {
                const inner = title.slice(i + 1, -1).trim()
                const head = course.split(" - ")[0].trim().toLowerCase()
                // Only strip when it really is the course repeated — a title
                // that legitimately ends in brackets keeps them.
                if (
                    head &&
                    (inner.toLowerCase().startsWith(course.toLowerCase()) ||
                        inner.toLowerCase().startsWith(head))
                ) {
                    return title.slice(0, i).trim()
                }
                return title
            }
        }
    }
    return title
}

// ---------------------------------------------------------------------
// The teacher's instructions (v1.2)
// ---------------------------------------------------------------------
// Text written by someone else, so it is only ever plain text: tags gone,
// entities decoded, whitespace collapsed, capped. It is rendered as text in
// the app (never HTML) and is never logged here or anywhere else.
export const DETAILS_MAX = 4000
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-", hellip: "...", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"' }
export function plainText(raw, isHtml) {
    let t = String(raw == null ? "" : raw)
    if (isHtml) {
        t = t
            .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
            .replace(/<li[^>]*>/gi, "- ")
            .replace(/<[^>]+>/g, " ")
    }
    t = t
        .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
            if (e[0] === "#") {
                const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
                return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : " "
            }
            return ENTITIES[e.toLowerCase()] != null ? ENTITIES[e.toLowerCase()] : m
        })
        // Control characters (keep newlines) and zero-width junk.
        .replace(/[\u0000-\u0009\u000B-\u001F\u007F\u200B-\u200D\uFEFF]/g, " ")
        .replace(/[ \t\u00A0]+/g, " ")
        .replace(/ *\n */g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
    if (t.length > DETAILS_MAX) {
        const cut = t.slice(0, DETAILS_MAX)
        const sp = cut.lastIndexOf(" ")
        t = (sp > DETAILS_MAX - 200 ? cut.slice(0, sp) : cut).trimEnd() + "..."
    }
    return t
}

/** DESCRIPTION if there is one, else X-ALT-DESC (HTML) as plain text. */
function detailsOf(ve) {
    const d = plainText(ve.getFirstPropertyValue("description"), false)
    if (d) return d
    const alt = plainText(ve.getFirstPropertyValue("x-alt-desc"), true)
    return alt || null
}

/**
 * Turns an .ics body into importable rows.
 * Returns { items, stats } — stats is for diagnosing a feed that imports
 * nothing, which is the failure mode users actually hit.
 */
export function parseAssignments(icsText, timeZone) {
    let comp
    try {
        comp = new ICAL.Component(ICAL.parse(icsText))
    } catch (e) {
        throw new CanvasError("parse", "That link didn't give me a calendar I can read. Make sure you copied the Calendar Feed link, not the Canvas web address.")
    }

    const vevents = comp.getAllSubcomponents("vevent")
    const stats = { events: vevents.length, assignments: 0, skippedNoDate: 0, skippedNotAssignment: 0 }
    const items = []

    for (const ve of vevents) {
        let ev
        try {
            ev = new ICAL.Event(ve)
        } catch (e) {
            continue
        }
        const uid = String(ev.uid || "")
        const url = String(ve.getFirstPropertyValue("url") || "")
        const assignmentId = assignmentIdFrom(url)
        if (!UID_ASSIGNMENT.test(uid) || !assignmentId) {
            stats.skippedNotAssignment++
            continue
        }

        // No due date means nothing for Focus Mode to key on, and nothing to
        // sort by on the homework screen.
        const start = ev.startDate ? ev.startDate.toJSDate() : null
        if (!start || isNaN(start.getTime())) {
            stats.skippedNoDate++
            continue
        }

        // All-day events (DTSTART;VALUE=DATE) have no real time of day, so
        // they keep due_at null rather than inventing midnight.
        const allDay = !!(ev.startDate && ev.startDate.isDate)

        const summary = String(ev.summary || "").trim()
        const m = summary.match(TITLE_COURSE)
        const course = (m ? m[2] : "").trim()
        const title = stripCourseTail((m ? m[1] : summary).trim(), course) || "Untitled assignment"

        // A section with its own due date gets an override event for the same
        // assignment. If a feed ever carries both, keep ONE row (the override:
        // it's the date for this student's section). Two rows with one key in
        // a single upsert would make Postgres reject the whole sync.
        const key = "canvas:assignment:" + (assignmentId || uid)
        const isOverride = /override/i.test(uid)
        const prev = items.findIndex((x) => x.external_id === key)
        if (prev !== -1) {
            if (!isOverride) continue
            items.splice(prev, 1)
            stats.assignments--
        }

        stats.assignments++
        items.push({
            // Keyed on the assignment, not the calendar event — see
            // assignmentIdFrom. Falls back to the UID only if Canvas ever emits
            // an assignment event without one.
            external_id: "canvas:assignment:" + (assignmentId || uid),
            title: title.slice(0, 200),
            course: course.slice(0, 120),
            due_date: toLocalISODate(start, timeZone),
            due_at: allDay ? null : start.toISOString(),
            details: detailsOf(ve),
            url: url.slice(0, 500),
        })
    }

    return { items, stats }
}

// The calendar gives an instant; due_date is a date, and which date it is
// depends on where the student is standing.
//
// Canvas emits DTSTART as a UTC timestamp, so an 11:59pm Eastern deadline
// arrives as 03:59Z the NEXT day. Formatting that with UTC parts would file the
// work under tomorrow — the homework screen would show the wrong day and Focus
// Mode would stop blocking a night early. The test feed didn't expose this (its
// latest due time is 23:00Z, comfortably inside the same Eastern day), which is
// exactly why it's worth fixing on principle rather than on symptom.
//
// timeZone comes from the client's own Intl lookup, the same way claim_daily
// already does it. Falling back to UTC keeps the old behaviour when it's absent.
function toLocalISODate(d, timeZone) {
    try {
        // en-CA formats as YYYY-MM-DD, which is the shape the date column wants.
        return new Intl.DateTimeFormat("en-CA", {
            timeZone: timeZone || "UTC",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
        }).format(d)
    } catch (e) {
        // An unrecognised zone from a client shouldn't fail the whole import.
        return d.toISOString().slice(0, 10)
    }
}

// ---------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------

/**
 * Writes parsed items into classes + assignments for one user.
 *
 * Never writes `done`. A sync that un-ticked somebody's finished homework every
 * 30 minutes would be worse than no sync at all, so the upsert lists the
 * columns Canvas owns and leaves the rest of the row alone.
 */
// "Chemistry - Schwartz" -> "chemistry". Canvas names a course the way the
// registrar does, teacher and section included; a student names it the way they
// say it out loud. Matching on the raw string means the import files homework
// under a second copy of a class they already have.
export function classKey(name) {
    return String(name || "")
        .split(" - ")[0]
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase()
}

/**
 * The deep link we are willing to store and later hand a browser.
 *
 * The ICS feed is a school's, but it is still input: a URL from it ends up as
 * an href, so `javascript:` or a link to somewhere else entirely must not
 * survive. Two rules — https only, and the host has to be the SAME Canvas the
 * feed came from. Anything else is dropped rather than rejected, because one
 * odd event should not fail a whole sync.
 */
export function safeCanvasUrl(raw, feedHost) {
    if (!raw || !feedHost) return null
    let u
    try {
        u = new URL(String(raw))
    } catch (e) {
        return null
    }
    if (u.protocol !== "https:") return null
    if (u.hostname.toLowerCase() !== String(feedHost).toLowerCase()) return null
    return u.toString().slice(0, 500)
}

export async function importItems(db, userId, items, feedHost) {
    const courses = [...new Set(items.map((i) => i.course).filter(Boolean))]
    const classIdByName = {}

    // One read of the user's classes instead of two queries per course. A
    // student has a handful of classes, and doing the comparison here rather
    // than in a filter avoids PostgREST's escaping rules entirely — a course
    // called "Physics, Honors" or one containing % would otherwise need care.
    const { data: existing, error: listErr } = await db
        .from("classes")
        .select("id, name, external_id, source")
        .eq("user_id", userId)
    if (listErr) throw listErr
    const mine = existing || []

    for (const name of courses) {
        const externalId = "canvas:course:" + name.toLowerCase()

        // In order: the id we stamped on a previous sync, then the exact name
        // (case- and space-insensitive), then the name with Canvas's
        // " - Teacher" tail removed. That last step is what was missing: the
        // feed says "History 10 - Deveau" and the student's own class is
        // "History 10", so an exact match never fired and every course arrived
        // as a duplicate.
        let found =
            mine.find((c) => c.external_id && c.external_id === externalId) ||
            mine.find(
                (c) =>
                    String(c.name || "").replace(/\s+/g, " ").trim().toLowerCase() ===
                    String(name).replace(/\s+/g, " ").trim().toLowerCase()
            ) ||
            mine.find((c) => classKey(c.name) === classKey(name))

        if (found) {
            classIdByName[name] = found.id
            // Adopt it: stamping the external id means the next sync matches on
            // the first test and never depends on name-shaped guesswork again.
            // source is left alone, so a class the student made stays theirs and
            // survives Disconnect.
            if (!found.external_id) {
                await db
                    .from("classes")
                    .update({ external_id: externalId })
                    .eq("id", found.id)
                found.external_id = externalId
            }
            continue
        }

        const { data: created, error } = await db
            .from("classes")
            .insert({
                user_id: userId,
                name,
                external_id: externalId,
                source: "canvas",
                sort_order: 999,
                days: [],
                // Named as it is created, so a class Canvas has just invented
                // already has its corner label the first time a square using it
                // is drawn. The dictionary places almost every real subject, so
                // this is free in practice.
                short_name: ruleShortClass(name).short,
            })
            .select("id, name, external_id, source")
            .single()
        if (error) throw error
        // Added to the local list so two Canvas courses that reduce to the same
        // key — "Chemistry - Schwartz" and "Chemistry - Jones", if a student
        // ever takes both — land in one class rather than racing to create two.
        mine.push(created)
        classIdByName[name] = created.id
    }

    // Short, friendly names for the squares. Generated ONCE per assignment:
    // anything we have already named keeps its name, so the six-hourly cron
    // re-sync costs nothing instead of re-paying to rename all 31 items every
    // time. Every row carries a value because PostgREST needs one shape for the
    // whole chunk, and an absent key on an upsert would blank the column.
    const shortByIdx = {}
    try {
        const { data: already } = await db
            .from("assignments")
            .select("external_id, short_title")
            .eq("user_id", userId)
            .eq("source", "canvas")
        const have = {}
        for (const r of already || []) {
            if (r.external_id && r.short_title) have[r.external_id] = r.short_title
        }

        const todo = []
        items.forEach((i, idx) => {
            const kept = have[i.external_id]
            if (kept) shortByIdx[idx] = kept
            else todo.push(idx)
        })

        if (todo.length) {
            const named = await shortenBatch(
                todo.map((idx) => ({
                    title: items[idx].title,
                    className: items[idx].course,
                }))
            )
            todo.forEach((idx, k) => {
                shortByIdx[idx] = named[k] || ruleShorten(items[idx].title, items[idx].course)
            })
        }
    } catch (e) {
        // Naming is a nicety; importing the work is not. Fall back to the
        // deterministic shortener rather than failing the whole sync.
        console.warn("[canvas] short names unavailable:", e && e.message)
    }

    const rows = items.map((i, idx) => ({
        user_id: userId,
        class_id: i.course ? classIdByName[i.course] || null : null,
        title: i.title,
        due_date: i.due_date,
        // Every row carries both keys (null when absent): PostgREST needs one
        // shape per upsert chunk, and a missing key would leave a stale value.
        due_at: i.due_at || null,
        details: i.details || null,
        external_id: i.external_id,
        source: "canvas",
        // Canvas puts the assignment's own page in the event's URL property, so
        // "open in canvas" can land on the assignment instead of the dashboard.
        url: safeCanvasUrl(i.url, feedHost),
        short_title: shortByIdx[idx] || ruleShorten(i.title, i.course),
    }))

    let imported = 0
    // Chunked so one enormous feed can't blow the request body limit.
    //
    // onConflict names a PLAIN unique constraint on (user_id, external_id), not
    // a partial one. PostgREST emits `ON CONFLICT (user_id, external_id)` with
    // no predicate, and Postgres will not infer a partial index from that — a
    // `where external_id is not null` index would make every sync fail with
    // "no unique or exclusion constraint matching". The plain constraint is
    // safe here because NULLs are distinct in a unique index, so every
    // hand-made assignment (external_id null) still coexists.
    for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200)
        const { error } = await db
            .from("assignments")
            .upsert(chunk, { onConflict: "user_id,external_id", ignoreDuplicates: false })
        if (error) throw error
        imported += chunk.length
    }

    // Work the teacher deleted. The feed is the whole truth for canvas-sourced
    // assignments, so anything of ours that is no longer in it no longer exists.
    //
    // Guarded on a NON-EMPTY feed: a parse that yields zero assignments is far
    // more likely a broken fetch than a teacher deleting an entire term, and
    // without this guard that one bad sync would wipe every assignment the
    // student has. Hand-made work is never touched — the filter is on
    // source=canvas.
    let removed = 0
    if (rows.length) {
        const keep = rows.map((r) => r.external_id).filter(Boolean)
        if (keep.length) {
            const { data: gone, error: delErr } = await db
                .from("assignments")
                .delete()
                .eq("user_id", userId)
                .eq("source", "canvas")
                .not("external_id", "in", "(" + keep.map((k) => '"' + k + '"').join(",") + ")")
                .select("id")
            if (delErr) {
                // Never fail a sync over tidying up.
                console.warn("[canvas] could not reconcile deletions:", delErr.message)
            } else {
                removed = (gone || []).length
            }
        }
    }

    return { imported, classes: courses.length, removed }
}

/** Everything Canvas put there, and nothing the user made themselves. */
export async function removeCanvasData(db, userId) {
    await db.from("assignments").delete().eq("user_id", userId).eq("source", "canvas")
    await db.from("classes").delete().eq("user_id", userId).eq("source", "canvas")
}
