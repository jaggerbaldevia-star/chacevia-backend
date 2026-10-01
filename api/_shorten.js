// api/_shorten.js
// Turns a long assignment title into a 1-3 word name a student recognises at a
// glance: "Environmental Science Unit 8 Quiz - Ecosystems" -> "unit 8 quiz".
// Not an API route (leading underscore).
//
// Generated ONCE, when an assignment is imported or created, and stored in
// assignments.short_title. Never on render: the home screen draws this on every
// square, and paying for a model call per square per app open would be both
// slow and expensive.
//
// Two layers, and the cheap one is the floor rather than the exception:
// ruleShorten() always produces something usable, and the model is asked to do
// better in one batched call. Any title the model fumbles keeps the rule answer.

import { MODELS, askJson, withRetry, ai } from "./_ai.js"

export const SHORT_MAX_WORDS = 3
export const SHORT_MAX_CHARS = 22
// One call per this many titles. Big enough that a 31-item Canvas import is two
// calls, small enough that one bad batch can't cost much or blow the context.
export const SHORT_BATCH = 25

// Leading noise: "Preparation: ", "Reminder - ", "HW #3: ".
const PREFIX_RE =
    /^\s*(preparation|prep|reminder|homework|hw|assignment|task|reading|classwork|cw|due|optional|ungraded)\b[\s:#\-–—]*/i

// Trailing noise Canvas adds: " [SPAN 3]", " (Period 2)".
const TAIL_RE = /\s*[\[(][^\])]*[\])]\s*$/

// The kind of thing it is. Longest first so "lab report" beats "lab".
const TYPES = [
    "lab report",
    "research paper",
    "term paper",
    "final exam",
    "midterm",
    "presentation",
    "portfolio",
    "worksheet",
    "annotate",
    "practice",
    "project",
    "essay",
    "packet",
    "review",
    "quizzes",
    "exam",
    "quiz",
    "test",
    "lab",
    "paper",
    "read",
    "write",
    "watch",
    "notes",
]

// A unit/chapter/page reference, which is usually the one detail worth keeping.
const NUMBERED = [
    { re: /\bunit\s*#?\s*(\d+[a-z]?)\b/i, as: (n) => "unit " + n },
    { re: /\bchapter\s*#?\s*(\d+[a-z]?)\b/i, as: (n) => "ch " + n },
    { re: /\bch\.?\s*#?\s*(\d+[a-z]?)\b/i, as: (n) => "ch " + n },
    { re: /\blesson\s*#?\s*(\d+[a-z]?)\b/i, as: (n) => "lesson " + n },
    { re: /\bmodule\s*#?\s*(\d+[a-z]?)\b/i, as: (n) => "module " + n },
    { re: /\bweek\s*#?\s*(\d+[a-z]?)\b/i, as: (n) => "week " + n },
    { re: /\bsection\s*#?\s*(\d+[a-z.]*)\b/i, as: (n) => "sec " + n },
]

// Short course codes that ARE the distinguishing detail: "Quiz F3", "CHEM GA1",
// "FD01 HW". A teacher who sets Quiz F1, F2 and F3 has given you the only thing
// that tells them apart, and dropping it leaves three squares all saying "quiz".
// One to three letters followed by one to three digits, so "unit"/"bc" and
// decimals like "1.2" are left alone.
const CODE_RE = /\b([a-z]{1,3}\d{1,3})\b/i

// Words a name should never end on. Without this, "CHEM GA1 on 1.1, 1.2" keeps
// its first three words and lands on "chem ga1 on".
const STOPWORDS = new Set([
    "on", "of", "and", "the", "a", "an", "for", "to", "in", "at", "with",
    "due", "from", "by", "is", "are", "vs",
])

// Page ranges: "pg. 52-70", "pp 52–70", "page 52".
const PAGES_RE =
    /\b(?:pgs?|pp|pages?|p)\.?\s*(\d+)\s*(?:[-–—]\s*(\d+))?/i

function tidy(raw) {
    return String(raw == null ? "" : raw)
        .replace(/\s+/g, " ")
        .trim()
}

/** Strips the class name out of a title that repeats it. */
function dropClassName(title, className) {
    const cls = tidy(className)
    if (!cls) return title
    // Canvas class names are often "Spanish 3 - Period 4"; the useful part is
    // the bit before the dash.
    const head = cls.split(/\s[-–—]\s/)[0].trim()
    if (head.length < 4) return title
    const esc = head.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    return title.replace(new RegExp(esc, "ig"), " ")
}

/**
 * The deterministic shortener. Always returns something non-empty.
 *
 * This is the fallback, but it is also the thing that runs when OpenAI is down,
 * out of credit or slow, so it has to be good enough to ship on its own.
 */
export function ruleShorten(title, className) {
    let t = tidy(title)
    if (!t) return "untitled"

    t = t.replace(TAIL_RE, " ")
    t = t.replace(PREFIX_RE, " ")
    t = dropClassName(t, className)
    // Everything after a dash is usually the topic gloss: "... Quiz - Ecosystems".
    const dash = t.split(/\s[-–—:]\s/)
    const head = tidy(dash[0]) || tidy(t)
    const hay = " " + head.toLowerCase().replace(/[^a-z0-9.\-–— ]+/g, " ") + " "
    const full = " " + t.toLowerCase().replace(/[^a-z0-9.\-–— ]+/g, " ") + " "

    let type = ""
    for (const w of TYPES) {
        if (hay.indexOf(" " + w + " ") !== -1 || hay.indexOf(" " + w + "s ") !== -1) {
            type = w === "quizzes" ? "quiz" : w
            break
        }
    }
    if (!type) {
        for (const w of TYPES) {
            if (full.indexOf(" " + w + " ") !== -1 || full.indexOf(" " + w + "s ") !== -1) {
                type = w === "quizzes" ? "quiz" : w
                break
            }
        }
    }
    if (type === "annotate") type = "read"

    let numbered = ""
    for (const n of NUMBERED) {
        const m = t.match(n.re)
        if (m) {
            numbered = n.as(m[1].toLowerCase())
            break
        }
    }

    const pm = t.match(PAGES_RE)
    const pages = pm ? "pg " + pm[1] + (pm[2] ? "-" + pm[2] : "") : ""

    // Only consulted when there is no unit/chapter/page to use instead, so
    // "unit 8 quiz" never becomes "unit 8 quiz f3".
    let code = ""
    if (type && !numbered && !pages) {
        const cm = head.match(CODE_RE)
        if (cm && cm[1].toLowerCase() !== type) code = cm[1].toLowerCase()
    }

    // Compose, most useful detail first.
    let out = ""
    if (numbered && type) out = numbered + " " + type
    else if (type && pages) out = type + " " + pages
    else if (numbered) out = numbered
    else if (pages) out = (type || "read") + " " + pages
    else if (type) out = code ? type + " " + code : type
    else {
        // Nothing recognisable: keep the first few real words of the title.
        const words = head
            .toLowerCase()
            .replace(/[^a-z0-9 .\-]+/g, " ")
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, SHORT_MAX_WORDS)
        while (words.length > 1 && STOPWORDS.has(words[words.length - 1])) words.pop()
        out = words.join(" ")
    }

    out = tidy(out).toLowerCase().split(/\s+/).slice(0, SHORT_MAX_WORDS).join(" ")
    if (!out) out = "untitled"
    if (out.length > SHORT_MAX_CHARS) out = tidy(out.slice(0, SHORT_MAX_CHARS))
    return out
}

const RULES = `You name school assignments for a student's home screen.

For each numbered item, write a SHORT name: 1 to 3 words, max ${SHORT_MAX_CHARS} characters, all lowercase.

Keep the most useful detail — the TYPE of work plus its number or topic.
Drop course names, teacher names, dates, period numbers, and filler like
"Preparation:", "Reminder:", "ungraded".

Examples:
"Environmental Science Unit 8 Quiz - Ecosystems" -> "unit 8 quiz"
"Preparation: Read & Annotate pg. 52-70 of Purple Hibiscus" -> "read pg 52-70"
"AP Calculus BC - Chapter 4 Test (Derivatives)" -> "ch 4 test"
"Spanish 3 Vocabulary Quiz #12" -> "vocab quiz 12"
"Final Research Paper: Industrialisation" -> "research paper"

Reply with ONE JSON object only:
{"names":{"1":"unit 8 quiz","2":"read pg 52-70"}}

Every number you were given must appear as a key. Never invent detail that is
not in the title.`

function cleanName(v) {
    let s = tidy(v).toLowerCase()
    s = s.replace(/^["'`]+|["'`]+$/g, "")
    s = s.replace(/[^a-z0-9 .\-#]+/g, " ")
    s = tidy(s).split(/\s+/).slice(0, SHORT_MAX_WORDS).join(" ")
    if (s.length > SHORT_MAX_CHARS) s = tidy(s.slice(0, SHORT_MAX_CHARS))
    return s
}

/**
 * Short names for many assignments in as few model calls as possible.
 *
 * `items` is [{ title, className }]. Returns an array of the same length, in the
 * same order — never shorter, never with a gap, because the caller writes these
 * straight onto rows by index.
 */
export async function shortenBatch(items) {
    const list = Array.isArray(items) ? items : []
    // The floor. Every slot already has a usable answer before the model is asked.
    const out = list.map((it) => ruleShorten(it && it.title, it && it.className))
    if (!list.length || !process.env.OPENAI_API_KEY) return out

    for (let start = 0; start < list.length; start += SHORT_BATCH) {
        const slice = list.slice(start, start + SHORT_BATCH)
        const lines = slice
            .map((it, i) => {
                const cls = tidy(it && it.className)
                return (
                    i + 1 + '. "' + tidy(it && it.title) + '"' +
                    (cls ? " (class: " + cls + ")" : "")
                )
            })
            .join("\n")
        try {
            const { data } = await askJson({
                model: MODELS.cheap,
                instructions: RULES,
                input: lines,
                label: "shorten",
            })
            const names = (data && data.names) || {}
            for (let i = 0; i < slice.length; i++) {
                const got = cleanName(names[String(i + 1)])
                // Only take the model's answer if it actually produced one.
                if (got) out[start + i] = got
            }
        } catch (e) {
            // Keep the rule-based names for this batch and carry on with the next.
            console.warn("[shorten] batch failed, keeping rule names:", e && e.message)
        }
    }
    return out
}

// =====================  CLASS NAMES  =====================
// "Sustainable Fashion Design" -> "fashion". Eight characters at most, because
// this sits in the corner of a square in a dotted display font.
//
// Subject-dictionary first, model second, and only for the ones the dictionary
// cannot place. A school timetable is a small, stable vocabulary: guessing
// "chemistry" -> "chem" needs no intelligence, and the names have to be stable
// because the same class must read the same on every square.

export const CLASS_MAX_CHARS = 8

// Level and framing words that are never the subject.
const CLASS_NOISE = [
    "accelerated", "advanced", "honors", "honours", "ap", "ib", "intro",
    "introduction", "foundations", "intermediate", "beginning", "beginner",
    "general", "basic", "elementary", "fundamentals", "principles", "topics",
    "survey", "seminar", "studies", "study", "course", "period", "block",
    "sustainable", "applied", "modern", "contemporary", "creative", "and",
    "with", "in", "of", "to", "the", "for", "a", "an",
]

// Ordered by specificity: the FIRST match wins, so "fashion" beats "design" in
// "Sustainable Fashion Design" while "Graphic Design and Typography" still
// lands on "design".
const SUBJECTS = [
    ["fashion", ["fashion", "apparel", "textile"]],
    ["chem", ["chemistry", "chemical", "chem"]],
    ["physics", ["physics"]],
    ["bio", ["biology", "anatomy", "physiology"]],
    ["science", ["environmental science", "earth science", "science"]],
    ["spanish", ["spanish"]],
    ["french", ["french"]],
    ["latin", ["latin"]],
    ["mandarin", ["mandarin", "chinese"]],
    ["german", ["german"]],
    ["history", ["history", "civics", "government"]],
    ["english", ["english", "literature", "composition", "writing"]],
    ["precalc", ["pre-calculus", "precalculus", "pre calculus"]],
    ["calculus", ["calculus"]],
    ["algebra", ["algebra"]],
    ["geometry", ["geometry"]],
    ["stats", ["statistics", "stats", "probability"]],
    ["math", ["mathematics", "math"]],
    ["religion", ["christian", "believer", "theology", "bible", "religion"]],
    ["finance", ["financial", "finance", "economics", "econ", "business"]],
    ["coding", ["computational", "computer", "programming", "coding", "software"]],
    ["wood", ["woodworking", "woodwork", "carpentry"]],
    ["film", ["film", "cinema", "video"]],
    ["dance", ["dance"]],
    ["debate", ["debate", "rhetoric", "forensics"]],
    ["theater", ["theater", "theatre", "drama"]],
    ["music", ["music", "band", "orchestra", "choir"]],
    ["art", ["studio art", "studio arts", "ceramics", "painting", "drawing", "art"]],
    ["design", ["typography", "graphic design", "design"]],
    ["pe", ["physical education", "gym", "athletics"]],
    ["health", ["health", "wellness"]],
    ["psych", ["psychology", "sociology"]],
]

/**
 * Short class name by dictionary.
 *
 * `confident` is what decides whether the model gets asked: a dictionary hit is
 * as good as it gets, and a generic truncation is where a model earns its keep.
 */
export function ruleShortClass(name) {
    const raw = tidy(name)
    if (!raw) return { short: "class", confident: false }

    // Canvas names are often "History 10 - Deveau"; the subject is before the dash.
    const head = raw.split(/\s[-–—]\s/)[0]
    const hay = " " + head.toLowerCase().replace(/[^a-z0-9+#]+/g, " ").trim() + " "

    for (const [short, words] of SUBJECTS) {
        for (const w of words) {
            if (hay.indexOf(" " + w + " ") !== -1) return { short, confident: true }
        }
    }

    // No known subject: drop the framing words and numbers, keep the first real
    // word. Usable, but flagged so the model gets a look.
    const words = hay
        .trim()
        .split(/\s+/)
        .filter((w) => w && !CLASS_NOISE.includes(w) && !/^\d+$/.test(w))
    const pick = words[0] || tidy(head).toLowerCase().split(/\s+/)[0] || "class"
    return { short: pick.slice(0, CLASS_MAX_CHARS), confident: false }
}

const CLASS_RULES = `You shorten school class names for a tiny label on a square.

For each numbered class, reply with ONE word: the SUBJECT, lowercase, at most
${CLASS_MAX_CHARS} characters. Drop level words (Honors, AP, Accelerated,
Intermediate, Introduction to, Foundations in), course numbers, and teacher names.

Examples:
"Algebra 2" -> "algebra"
"Spanish 3" -> "spanish"
"Chemistry" -> "chem"
"Environmental Science" -> "science"
"History 10" -> "history"
"English 10" -> "english"
"Sustainable Fashion Design" -> "fashion"
"Graphic Design and Typography" -> "design"

Reply with ONE JSON object only:
{"names":{"1":"algebra","2":"fashion"}}

Every number you were given must appear as a key.`

/**
 * Short names for many classes. Same contract as shortenBatch: same length, same
 * order, never a gap.
 *
 * The model is only asked about the ones the dictionary could not place, so a
 * normal timetable costs nothing at all.
 */
export async function shortenClassBatch(names) {
    const list = Array.isArray(names) ? names : []
    const ruled = list.map((n) => ruleShortClass(n))
    const out = ruled.map((r) => r.short)
    if (!list.length || !process.env.OPENAI_API_KEY) return out

    const unsure = []
    ruled.forEach((r, i) => {
        if (!r.confident) unsure.push(i)
    })
    if (!unsure.length) return out

    for (let start = 0; start < unsure.length; start += SHORT_BATCH) {
        const idxs = unsure.slice(start, start + SHORT_BATCH)
        const lines = idxs
            .map((idx, i) => i + 1 + '. "' + tidy(list[idx]) + '"')
            .join("\n")
        try {
            const { data } = await askJson({
                model: MODELS.cheap,
                instructions: CLASS_RULES,
                input: lines,
                label: "shorten-class",
            })
            const got = (data && data.names) || {}
            idxs.forEach((idx, i) => {
                let v = tidy(got[String(i + 1)]).toLowerCase()
                v = v.replace(/[^a-z0-9+#]+/g, "")
                if (v) out[idx] = v.slice(0, CLASS_MAX_CHARS)
            })
        } catch (e) {
            console.warn("[shorten-class] batch failed, keeping rule names:", e && e.message)
        }
    }
    return out
}
