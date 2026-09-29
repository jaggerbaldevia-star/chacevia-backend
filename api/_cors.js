// api/_cors.js
// One CORS allowlist for every endpoint. Not an API route (leading underscore).
//
// This replaced `Access-Control-Allow-Origin: *`, which let any website on the
// internet drive Chacevia's paid endpoints from a visitor's browser. Every call
// still needs a valid Supabase JWT, so `*` was never a way to read someone
// else's data — but it did mean a third-party page could spend OpenAI budget
// through its own logged-in users, and it made the API a free backend for
// anyone who wanted one.
//
// A browser only honours an allowlist it is told about, so the header is echoed
// back per-request: matched origin => that exact origin, plus `Vary: Origin` so
// no shared cache serves one site's header to another.
//
// Non-browser callers (the iOS shell's own fetches, curl, Stripe's webhook)
// send no Origin header at all. They get no CORS header and are unaffected —
// CORS is enforced by browsers, not by servers.

// The live site IS the Framer domain: the iOS app's WebView loads it, so
// removing it would break every real user instantly. chacevia.com is listed
// ready for the custom domain.
const ALLOWED = [
    "https://adored-powerpoint-102797.framer.app",
    "https://chacevia.com",
    "https://www.chacevia.com",
]

// Extra origins without a deploy: set ALLOWED_ORIGINS in Vercel to a
// comma-separated list. Needed if you ever test from Framer's editor preview,
// which runs on its own origin.
function allowlist() {
    const extra = String(process.env.ALLOWED_ORIGINS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    return ALLOWED.concat(extra)
}

/**
 * Sets the CORS headers for one request.
 *
 * @param req      the incoming request (read for its Origin header)
 * @param res      the response to write headers onto
 * @param methods  e.g. "POST, OPTIONS" — what this endpoint accepts
 * @param headers  e.g. "Content-Type, Authorization"
 */
export function setCors(req, res, methods = "POST, OPTIONS", headers = "Content-Type, Authorization") {
    const origin = (req && req.headers && (req.headers.origin || req.headers.Origin)) || ""
    res.setHeader("Vary", "Origin")
    res.setHeader("Access-Control-Allow-Methods", methods)
    res.setHeader("Access-Control-Allow-Headers", headers)
    // An origin we don't know gets no allow header, which is what makes the
    // browser refuse the response. Deliberately not echoed back — echoing an
    // arbitrary origin is the same as allowing everything.
    if (origin && allowlist().includes(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin)
    }
}
