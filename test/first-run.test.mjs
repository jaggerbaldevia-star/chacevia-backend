// node --test test/first-run.test.mjs — Canvas host memory, Apple client secret,
// tutorial allowance. No network, no real keys: the Apple key is generated here.
import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import { cleanCanvasHost, rememberCanvasHost } from "../api/_schools.js"
import { appleConfig, appleClientSecret, exchangeCode, revokeToken } from "../api/_apple.js"
import { tutorialIsFree, TUTORIAL_FREE_MESSAGES } from "../api/_limits.js"
import { clipWords, TUTORIAL_MAX_WORDS } from "../api/rocco-chat.js"
import { sealSecret, openSecret } from "../api/_canvas.js"

// ---- Canvas host (from the feed link) --------------------------------------

test("cleanCanvasHost keeps real hosts only", () => {
    assert.equal(cleanCanvasHost("Lincoln.Instructure.com"), "lincoln.instructure.com")
    assert.equal(cleanCanvasHost("canvas.myschool.k12.ca.us"), "canvas.myschool.k12.ca.us")
    for (const bad of ["", "localhost", "a b.com", "x.instructure.com/feeds", "-x.com", "x..com", null]) assert.equal(cleanCanvasHost(bad), "")
})

function fakeDb({ schoolRows = [], appMeta = {} } = {}) {
    const log = []
    const chain = (table) => {
        const q = { table, ops: [] }
        const self = new Proxy(q, {
            get(t, k) {
                if (k === "then") return (ok) => ok({ data: t.ops[0][0] === "select" ? schoolRows : null, error: null })
                return (...args) => { t.ops.push([k, ...args]); return self }
            },
        })
        log.push(q)
        return self
    }
    const admin = {
        getUserById: async () => ({ data: { user: { app_metadata: appMeta } }, error: null }),
        updateUserById: async (id, attrs) => { log.push({ update: [id, attrs] }); return { error: null } },
    }
    return { db: { from: chain, auth: { admin } }, log }
}

test("rememberCanvasHost: new host → school row + account, merging app_metadata", async () => {
    const { db, log } = fakeDb({ appMeta: { provider: "apple" } })
    assert.equal(await rememberCanvasHost(db, "u1", "Lincoln.instructure.com"), true)
    const ups = log.find((q) => q.ops && q.ops[0][0] === "upsert")
    assert.deepEqual(ups.ops[0][1], { name: "lincoln.instructure.com", canvas_host: "lincoln.instructure.com" })
    assert.deepEqual(ups.ops[0][2], { onConflict: "match_key", ignoreDuplicates: true })
    const upd = log.find((x) => x.update)
    assert.deepEqual(upd.update, ["u1", { app_metadata: { provider: "apple", canvas_host: "lincoln.instructure.com" } }])
})

test("rememberCanvasHost: known host, same account host → no writes", async () => {
    const { db, log } = fakeDb({ schoolRows: [{ id: "s1" }], appMeta: { canvas_host: "lincoln.instructure.com" } })
    assert.equal(await rememberCanvasHost(db, "u1", "lincoln.instructure.com"), true)
    assert.equal(log.some((q) => q.ops && q.ops[0][0] === "upsert"), false)
    assert.equal(log.some((x) => x.update), false)
    assert.equal(await rememberCanvasHost(db, "u1", "not a host"), false)
})

// ---- Apple --------------------------------------------------------------------

const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" })
const pem = privateKey.export({ type: "pkcs8", format: "pem" })
const env = {
    APPLE_SIWA_KEY_ID: "TESTKEY123",
    APPLE_TEAM_ID: "VJMDU2ZCT5",
    APPLE_SIWA_PRIVATE_KEY: pem.replace(/\n/g, "\\n"), // as pasted into Vercel on one line
    APPLE_CLIENT_ID: "com.chacevia.app",
}

test("appleConfig is null unless all four env vars are set", () => {
    assert.equal(appleConfig({}), null)
    assert.equal(appleConfig({ ...env, APPLE_CLIENT_ID: "" }), null)
    assert.ok(appleConfig(env).privateKey.includes("\n-----END PRIVATE KEY-----"))
})

test("client secret is an ES256 JWT Apple accepts the shape of, and verifies", () => {
    const now = 1_790_000_000
    const jwt = appleClientSecret(appleConfig(env), now)
    const [h, p, s] = jwt.split(".")
    const header = JSON.parse(Buffer.from(h, "base64url"))
    const payload = JSON.parse(Buffer.from(p, "base64url"))
    assert.deepEqual(header, { alg: "ES256", kid: "TESTKEY123", typ: "JWT" })
    assert.deepEqual(payload, {
        iss: "VJMDU2ZCT5", iat: now, exp: now + 300, aud: "https://appleid.apple.com", sub: "com.chacevia.app",
    })
    const sig = Buffer.from(s, "base64url")
    assert.equal(sig.length, 64, "raw r||s, not DER")
    assert.ok(crypto.verify("sha256", Buffer.from(h + "." + p), { key: publicKey, dsaEncoding: "ieee-p1363" }, sig))
})

test("exchange and revoke send the right form fields", async () => {
    const sent = []
    const fake = (body) => async (url, init) => {
        sent.push({ url, params: Object.fromEntries(new URLSearchParams(init.body)) })
        return { ok: true, status: 200, json: async () => body }
    }
    const cfg = appleConfig(env)
    const r = await exchangeCode(cfg, "code-1", fake({ refresh_token: "rt-1" }))
    assert.equal(r.refreshToken, "rt-1")
    assert.equal(sent[0].url, "https://appleid.apple.com/auth/token")
    assert.equal(sent[0].params.grant_type, "authorization_code")
    assert.equal(sent[0].params.code, "code-1")
    assert.equal(sent[0].params.client_id, "com.chacevia.app")
    assert.equal((await exchangeCode(cfg, "c", fake({}))).refreshToken, null)

    const v = await revokeToken(cfg, "rt-1", fake(null))
    assert.ok(v.ok)
    assert.equal(sent[2].url, "https://appleid.apple.com/auth/revoke")
    assert.equal(sent[2].params.token_type_hint, "refresh_token")
    assert.equal(sent[2].params.token, "rt-1")
})

test("sealed secrets round-trip with the Canvas key and are not plaintext", () => {
    const prev = process.env.CANVAS_FEED_KEY
    process.env.CANVAS_FEED_KEY = crypto.randomBytes(32).toString("base64")
    try {
        const sealed = sealSecret("refresh-token-value")
        assert.ok(sealed.startsWith("v1.") && !sealed.includes("refresh-token-value"))
        assert.equal(openSecret(sealed), "refresh-token-value")
        assert.throws(() => openSecret("garbage"))
    } finally {
        if (prev === undefined) delete process.env.CANVAS_FEED_KEY
        else process.env.CANVAS_FEED_KEY = prev
    }
})

// ---- Rocco tutorial -----------------------------------------------------------

test("first two tutorial messages are free, then normal; a broken counter is never free", () => {
    assert.equal(TUTORIAL_FREE_MESSAGES, 2)
    assert.equal(tutorialIsFree(1), true)
    assert.equal(tutorialIsFree(2), true)
    assert.equal(tutorialIsFree(3), false)
    assert.equal(tutorialIsFree(null), false)
    assert.equal(tutorialIsFree(0), false)
})

test("tutorial replies are clipped to 60 words", () => {
    const short = "Hi! I'm Rocco."
    assert.equal(clipWords(short), short)
    const long = Array.from({ length: 90 }, (_, i) => (i === 40 ? "end." : "word")).join(" ")
    const clipped = clipWords(long)
    assert.ok(clipped.split(/\s+/).length <= TUTORIAL_MAX_WORDS)
    assert.ok(clipped.endsWith("end."), "cuts at a sentence end when there is one")
    const noStop = Array.from({ length: 80 }, () => "word").join(" ")
    assert.equal(clipWords(noStop).split(/\s+/).length, 60)
    assert.ok(clipWords(noStop).endsWith("…"))
})
