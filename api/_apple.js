// api/_apple.js
// Sign in with Apple, server side: turn the app's one-time authorizationCode
// into a refresh token, and revoke it when the account is deleted (Apple
// requires revocation for apps that offer account deletion). Not an API route.
//
// Env (all four or nothing):
//   APPLE_SIWA_KEY_ID       — the SIWA key's id
//   APPLE_TEAM_ID           — VJMDU2ZCT5
//   APPLE_SIWA_PRIVATE_KEY  — contents of the SIWA .p8 (PEM). Never logged.
//   APPLE_CLIENT_ID         — com.chacevia.app
//
// Refresh tokens are stored sealed (api/_canvas.js sealSecret) and never logged.

import crypto from "crypto"

const APPLE = "https://appleid.apple.com"

export function appleConfig(env = process.env) {
    const keyId = env.APPLE_SIWA_KEY_ID || ""
    const teamId = env.APPLE_TEAM_ID || ""
    // Vercel env values pasted on one line arrive with literal "\n".
    const privateKey = String(env.APPLE_SIWA_PRIVATE_KEY || "").replace(/\\n/g, "\n")
    const clientId = env.APPLE_CLIENT_ID || ""
    if (!keyId || !teamId || !privateKey.trim() || !clientId) return null
    return { keyId, teamId, privateKey, clientId }
}

const b64url = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url")

// Apple's client_secret: an ES256 JWT, iss = team, sub = client id. Five
// minutes is plenty for one request; Apple allows up to six months.
export function appleClientSecret(cfg, nowSec = Math.floor(Date.now() / 1000)) {
    const header = { alg: "ES256", kid: cfg.keyId, typ: "JWT" }
    const payload = { iss: cfg.teamId, iat: nowSec, exp: nowSec + 300, aud: APPLE, sub: cfg.clientId }
    const input = b64url(header) + "." + b64url(payload)
    // JWS wants the raw r||s signature (64 bytes), not DER.
    const sig = crypto.sign("sha256", Buffer.from(input), { key: cfg.privateKey, dsaEncoding: "ieee-p1363" })
    return input + "." + sig.toString("base64url")
}

async function post(path, params, fetchImpl) {
    const r = await fetchImpl(APPLE + path, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(params).toString(),
    })
    let json = null
    try { json = await r.json() } catch { /* revoke returns an empty body */ }
    return { ok: r.ok, status: r.status, json }
}

// Returns the refresh token string, or null. Throws nothing the caller has to
// handle specially; the reason is returned for logging (never the token).
export async function exchangeCode(cfg, code, fetchImpl = fetch) {
    const r = await post(
        "/auth/token",
        {
            client_id: cfg.clientId,
            client_secret: appleClientSecret(cfg),
            code: String(code),
            grant_type: "authorization_code",
        },
        fetchImpl
    )
    if (!r.ok) return { refreshToken: null, reason: (r.json && r.json.error) || `http-${r.status}` }
    const t = r.json && r.json.refresh_token
    return t ? { refreshToken: t, reason: null } : { refreshToken: null, reason: "no-refresh-token" }
}

export async function revokeToken(cfg, refreshToken, fetchImpl = fetch) {
    const r = await post(
        "/auth/revoke",
        {
            client_id: cfg.clientId,
            client_secret: appleClientSecret(cfg),
            token: refreshToken,
            token_type_hint: "refresh_token",
        },
        fetchImpl
    )
    return { ok: r.ok, status: r.status }
}
