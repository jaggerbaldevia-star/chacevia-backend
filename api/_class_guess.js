// api/_class_guess.js
//
// "Cover → start now": the web page can start a class recording before anyone
// knows which class it is (classId "auto"), or on a scheduled guess, and the
// student can relabel it mid-recording. This file decides which class a
// recording really was, for the class-recap handler in api/_recap.js:
//
//   - the student's own label (auth user_metadata.ae_label) when it applies
//   - otherwise a word-count guess from the transcript against the student's
//     own classes, their subjects and their open assignment titles
//
// Everything here is pure except loadClassData / loadLabel / clearUsedLabel,
// which take the service-role client. Nothing here logs; the transcript and
// class names are never written anywhere.

// ---- Text -------------------------------------------------------------------

/** Pure. Lowercase, accents stripped, a light plural fold ("cells" → "cell"). */
export function normWord(w) {
    const s = String(w || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    return s.length > 4 && s.endsWith("s") && !/(ss|us|is)$/.test(s) ? s.slice(0, -1) : s
}

/** Pure. Word → how many times it was said (normalised words). */
export function wordCounts(text) {
    const counts = new Map()
    const toks = String(text || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().match(/[a-z0-9]+/g) || []
    for (const t of toks) {
        const k = normWord(t)
        counts.set(k, (counts.get(k) || 0) + 1)
    }
    return counts
}

// Common English words (4+ letters) that say nothing about a subject.
const STOP = new Set(`about above after again against also although always among another anyone anything around away back because been before being below best better between both bring came cannot come could does doing done down during each either else enough even ever every first from front gave give goes going gone good got great have having here high into just keep kind know last least left less like little long look made make many maybe more most much must need never next nice none nothing only open other over part please pretty real really right same said says should show side since some something soon still such sure take than thank thanks that their them then there these they thing things think this those though through time today together tomorrow told took turn under until upon used very want well went were what when where whether which while whole will with within without work would yeah year years your yours okay alright actually basically everyone everybody guys people somebody someone`.split(/\s+/))

// Words in class names that don't name the subject.
const NAME_NOISE = new Set(`ap ib cp honors honor hon adv advanced accelerated intro introduction to of and the general regular dual enrollment college prep period class course grade level semester sem year world language arts studies study topics topic special seminar lab i ii iii iv v vi 1 2 3 4 5 6 7 8 9 10 11 12 a b c x`.split(/\s+/))

// Words in assignment titles that every class shares.
const ASSIGNMENT_NOISE = new Set(`homework worksheet quiz test exam final midterm chapter unit review assignment project reading notes note practice lesson section part week page pages question questions discussion due draft submission submit packet activity warmup warm task check study guide slides presentation journal response reflection entry extra credit makeup make late period`.split(/\s+/))

// ---- Subjects -----------------------------------------------------------------

const kw = (s) => s.trim().split(/\s+/)

// Checked in order: the first pattern that matches the class name wins.
// "Physical Education" must be seen before physics, languages before English.
export const SUBJECTS = [
    {
        id: "spanish", match: /spanish|espa[nñ]ol/,
        words: kw(`spanish espanol conjugate conjugation preterite imperfect subjunctive vocabulario ser estar tener hacer
            usted ustedes nosotros hola gracias senor senora profesor profesora bueno buenos dias muy bien el los las que por para pero
            como esta estan tengo tiene yo tu es una con del donde cuando porque hay mas verdad entonces vamos clase`),
    },
    {
        id: "french", match: /french|fran[cç]ais/,
        words: kw(`french francais conjugate conjugation passe compose imparfait subjonctif bonjour merci oui madame monsieur
            je tu il elle nous vous ils elles le les des du une est et sont avec pour dans pas tres bien qu quoi alors voila ca aussi
            mais avoir etre faire aller`),
    },
    {
        id: "german", match: /german|deutsch/,
        words: kw(`german deutsch ich du wir ihr sie und ist nicht ein eine einen mit auf das der den dem ja nein danke bitte
            guten morgen herr frau haben sein wie gut sehr auch aber oder noch heute schon akkusativ dativ umlaut accusative dative
            nominative genitive`),
    },
    {
        id: "latin", match: /\blatin\b(?!\s+america)/,
        words: kw(`latin declension conjugation nominative accusative genitive dative ablative vocative noun verb caesar cicero
            virgil aeneid ovid roman rome romans puella agricola amo amas amat sum esse perfect imperfect pluperfect infinitive participle
            translate translation derivative et est non cum ad sunt quod qui quae sed ego nos vos`),
    },
    {
        id: "chinese", match: /chinese|mandarin/,
        words: kw(`chinese mandarin pinyin tone tones stroke strokes radical hanzi ni hao nihao wo shi bu ma xie xiexie zaijian
            laoshi hen dui zhongguo zhongwen shenme nar ge mei nimen tamen pengyou jiao jintian mingtian`),
    },
    {
        id: "health", match: /\bhealth\b|\bpe\b|p\.e\.|physical education|\bgym\b|fitness|wellness|athletic|weight/,
        words: kw(`health nutrition exercise fitness workout warm stretch stretching muscle muscles heart cardio calories diet sleep
            stress mental wellness drugs alcohol vaping tobacco sport sports team ball game running lap laps gym basketball soccer
            volleyball football baseball mile pushups situps teamwork warmup drill drills jog sprint sprints locker whistle`),
    },
    {
        id: "physics", match: /\bphysics\b/,
        words: kw(`physics force velocity acceleration momentum newton newtons mass gravity friction energy kinetic potential motion
            displacement vector wave frequency wavelength amplitude circuit voltage current resistance ohm magnetic electric joule
            joules watt torque projectile inertia speed lens thermodynamics quantum`),
    },
    {
        id: "chemistry", match: /chem/,
        words: kw(`chemistry chemical atom atoms atomic molecule molecules molecular element elements periodic electron electrons proton
            neutron ion ions ionic covalent bond bonds mole moles molar molarity reaction reactions reactant compound solution solvent
            solute acid acids base ph isotope valence oxidation stoichiometry titration equilibrium enthalpy catalyst beaker orbital
            electronegativity`),
    },
    {
        id: "biology", match: /\bbio|life science|anatomy|physiology/,
        words: kw(`biology cell cells organism organisms dna rna gene genes genetic genetics protein proteins enzyme enzymes mitosis
            meiosis chromosome chromosomes evolution selection species ecosystem photosynthesis respiration mitochondria nucleus
            membrane bacteria virus organ tissue allele dominant recessive heredity ecology mutation cellular darwin microscope
            anatomy homeostasis`),
    },
    {
        id: "earth", match: /earth|environment|\benv\b|\bapes\b|geolog|ecolog|marine|astronomy/,
        words: kw(`earth geology rock rocks mineral minerals plate plates tectonic tectonics earthquake volcano erosion weathering
            sediment sedimentary igneous metamorphic atmosphere climate weather ocean cycle glacier fossil fossils ecosystem pollution
            renewable carbon emissions greenhouse sustainability biodiversity environment environmental watershed soil habitat`),
    },
    {
        id: "psychology", match: /psych/,
        words: kw(`psychology psychologist brain behavior behaviour cognitive cognition memory conditioning pavlov freud skinner
            piaget neuron neurons neurotransmitter dopamine serotonin emotion emotions motivation perception sensation personality
            disorder therapy developmental unconscious consciousness stimulus reinforcement hypothesis bias nurture schema`),
    },
    {
        id: "computer", match: /computer|coding|programming|\bcs\b|software|robotics|web design|\bapcsp?\b/,
        words: kw(`computer coding code program programming python java javascript variable function loop loops array list string
            boolean algorithm debug bug syntax compile compiler object method binary data database software hardware html css input
            output conditional recursion iteration integer print terminal github scratch`),
    },
    {
        id: "math", match: /math|algebra|geometry|calc|statistic|\bstats?\b|trig|pre-?calc/,
        words: kw(`math equation equations variable solve slope graph function functions linear quadratic polynomial exponent
            exponential logarithm derivative integral limit angle angles triangle theorem proof pythagorean perimeter area volume radius
            circle parallel perpendicular probability mean median deviation sine cosine tangent trig trigonometry fraction factor
            coefficient intercept inequality matrix calculus algebra geometry statistics precalculus`),
    },
    {
        id: "english", match: /english|literature|\blit\b|\bela\b|language arts|writing|composition|rhetoric/,
        words: kw(`english literature novel poem poetry poet author character characters protagonist antagonist theme symbolism
            metaphor simile imagery narrator narrative plot setting conflict essay thesis paragraph quote quotation rhetoric rhetorical
            analysis annotate shakespeare stanza sonnet tone irony foreshadowing grammar claim evidence`),
    },
    {
        id: "art", match: /\bart\b|\barts\b|drawing|painting|ceramics|sculpture|studio|photography|design/,
        words: kw(`art artist artwork painting paint drawing draw sketch color colour palette brush shading perspective composition
            contrast texture shape value hue saturation sculpture clay ceramics portrait landscape abstract gallery museum critique
            collage watercolor acrylic charcoal pencil`),
    },
    {
        id: "music", match: /music|band|choir|chorus|orchestra|jazz|guitar|piano|vocal/,
        words: kw(`music musical band choir orchestra song sing singing note notes rhythm tempo beat measure melody harmony chord
            scale pitch instrument trumpet clarinet flute saxophone trombone drum drums percussion violin cello piano conductor
            rehearsal concert soprano alto tenor bass forte crescendo staccato`),
    },
    {
        id: "government", match: /government|\bgov\b|civics|politic/,
        words: kw(`government constitution constitutional amendment congress senate senator representative legislative executive
            judicial branch supreme court president democracy democratic republican republic election vote voting ballot federal
            federalism bill law citizen citizenship rights policy veto impeachment campaign political politics civic civics`),
    },
    {
        id: "economics", match: /econ/,
        words: kw(`economics economy economic supply demand market price inflation recession gdp tax taxes budget money bank interest
            scarcity opportunity cost trade profit revenue consumer producer elasticity equilibrium monopoly competition investment
            stock unemployment fiscal monetary incentive goods services entrepreneur`),
    },
    {
        id: "history", match: /histor|social studies|\bapush\b|\bapwh\b|geography|world cultures|humanities/,
        words: kw(`history historical century centuries empire emperor dynasty revolution war colonies colonial colonization treaty
            ancient medieval renaissance civilization independence king monarchy feudal feudalism industrial imperialism slavery civil
            reconstruction ottoman roman greek greece rome egypt mesopotamia declaration archaeology era timeline reign conquest crusade
            nationalism bce geography map primary source culture society army battle soldier colonist settler pharaoh`),
    },
]

const NON_ACADEMIC = /study hall|free period|\blunch\b|advisory|homeroom|\bbreak\b/i

/** Pure. "World History - Ortiz" → "World History" (the teacher tail dropped). */
export function subjectName(name) {
    return String(name || "").split(/\s+[-–—]\s+/)[0].replace(/\s+/g, " ").trim()
}

/** Pure. Which built-in subject list a class name belongs to, or null. */
export function subjectFor(name) {
    const n = subjectName(name).toLowerCase()
    if (!n) return null
    return SUBJECTS.find((s) => s.match.test(n)) || null
}

export const isNonAcademic = (name) => NON_ACADEMIC.test(String(name || ""))

function nameWords(name) {
    const toks = subjectName(name).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().match(/[a-z0-9]+/g) || []
    return toks.filter((t) => t.length >= 3 && !NAME_NOISE.has(t) && !STOP.has(t) && !/^\d+$/.test(t))
}

function titleWords(title) {
    const toks = String(title || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().match(/[a-z0-9]+/g) || []
    return toks.filter((t) => t.length >= 4 && !/\d/.test(t) && !STOP.has(t) && !ASSIGNMENT_NOISE.has(t))
}

// One word said ten times is still one clue: each word counts at most this
// many hits, so a long transcript can't swamp the score with repetition.
export const HIT_CAP = 3
export const CONFIDENT_HITS = 6
export const CONFIDENT_RATIO = 1.6

// ---- The classifier -------------------------------------------------------------

/**
 * Pure. Which of the student's classes this transcript most sounds like.
 *   classes:     [{ id, name, short_name?, source? }]
 *   assignments: [{ title, class_id }] (the student's not-done work)
 * Returns { classId, className, score, runnerUp, confident } or null when no
 * academic class scores above zero. Duplicate classes (a Canvas copy of the
 * student's own class: same name before " - Teacher") are scored as one, kept
 * as the student's own row.
 */
export function guessClassFromTranscript(transcript, classes, assignments) {
    const list = (Array.isArray(classes) ? classes : []).filter((c) => c && c.id != null && String(c.name || "").trim() && !isNonAcademic(c.name) && !isNonAcademic(c.short_name))
    if (!list.length) return null

    // Merge duplicates by name key; the student's own (non-Canvas) row wins.
    const groups = new Map()
    for (const c of list) {
        const key = subjectName(c.name).toLowerCase()
        const g = groups.get(key)
        if (!g) groups.set(key, { keep: c, ids: new Set([String(c.id)]), names: [c.name, c.short_name] })
        else {
            g.ids.add(String(c.id))
            g.names.push(c.name, c.short_name)
            if (g.keep.source === "canvas" && c.source !== "canvas") g.keep = c
        }
    }

    const byClass = new Map()
    for (const a of Array.isArray(assignments) ? assignments : []) {
        if (!a || a.class_id == null) continue
        const id = String(a.class_id)
        if (!byClass.has(id)) byClass.set(id, [])
        byClass.get(id).push(a.title)
    }

    const counts = wordCounts(transcript)
    if (!counts.size) return null

    const scored = []
    for (const g of groups.values()) {
        const words = new Set()
        for (const n of g.names) for (const w of nameWords(n)) words.add(normWord(w))
        const subj = subjectFor(g.keep.name) || subjectFor(g.keep.short_name)
        if (subj) for (const w of subj.words) words.add(normWord(w))
        for (const id of g.ids) for (const t of byClass.get(id) || []) for (const w of titleWords(t)) words.add(normWord(w))
        let score = 0
        for (const w of words) score += Math.min(counts.get(w) || 0, HIT_CAP)
        scored.push({ c: g.keep, score })
    }
    scored.sort((a, b) => b.score - a.score) // stable: ties keep the schedule's order
    const best = scored[0]
    if (!best || best.score <= 0) return null
    const runnerUp = scored[1] ? scored[1].score : 0
    return {
        classId: String(best.c.id),
        className: String(best.c.name).replace(/\s+/g, " ").trim().slice(0, 80),
        score: best.score,
        runnerUp,
        confident: best.score >= CONFIDENT_HITS && best.score >= CONFIDENT_RATIO * runnerUp,
    }
}

// ---- The student's own label -----------------------------------------------------

export const LABEL_GRACE_MIN = 240

/** Pure. A well-formed ae_label, tidied, or null. */
export function cleanLabel(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
    const startedMs = typeof raw.startedAt === "string" ? Date.parse(raw.startedAt) : NaN
    if (!Number.isFinite(startedMs)) return null
    const classId = typeof raw.classId === "string" ? raw.classId.trim() : ""
    if (!classId || classId.length > 64) return null
    const className = typeof raw.className === "string" ? raw.className.replace(/[\u0000-\u001f\u007f<>]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) : ""
    if (!className) return null
    return { startedAt: raw.startedAt, startedMs, classId, className, picked: raw.picked === true }
}

/**
 * Pure. The label, if it belongs to this recap: started within
 * [now - (minutes + 240) min, now] (a recap can be retried hours later when the
 * phone was offline) and either for the same class or explicitly picked.
 */
export function applicableLabel(raw, { classId, minutes, now }) {
    const l = cleanLabel(raw)
    if (!l) return null
    const nowMs = now instanceof Date ? now.getTime() : Number(now)
    const span = ((Number.isFinite(minutes) && minutes > 0 ? minutes : 0) + LABEL_GRACE_MIN) * 60000
    if (l.startedMs > nowMs || l.startedMs < nowMs - span) return null
    if (l.classId !== String(classId) && !l.picked) return null
    return l
}

/**
 * Pure. The class this recap is about.
 *   body:  { classId, className, teacher } as the phone sent them
 *   label: applicableLabel(...) or null
 *   guess: guessClassFromTranscript(...) or null
 * Returns { classId, className, teacher, classNote, changed }.
 */
export function decideClassLabel(body, label, guess) {
    const keep = { classId: body.classId, className: body.className, teacher: body.teacher || null, classNote: null, changed: false }
    const to = (id, name) => {
        const same = String(id) === String(body.classId)
        return { classId: String(id), className: name, teacher: same ? body.teacher || null : null, changed: !same || name !== body.className }
    }
    // The student said which class it was: that wins, no second-guessing.
    if (label && label.picked) return { ...to(label.classId, label.className), classNote: null }
    // Nobody knew: take the best guess, and say it's a guess.
    if (body.classId === "auto" || (label && label.classId === "auto")) {
        if (!guess) return keep
        return { ...to(guess.classId, guess.className), classNote: `we think this was ${subjectName(guess.className)}` }
    }
    // A scheduled guess from "start now" (it always leaves a label): only
    // overruled when the transcript clearly says otherwise. Recordings with no
    // label (auto-start, the record screen, app builds that never show the
    // note) keep their class.
    if (label && guess && guess.confident && String(guess.classId) !== String(body.classId))
        return { ...to(guess.classId, guess.className), classNote: `we think this was ${subjectName(guess.className)}` }
    return keep
}

// ---- Supabase (service role) -----------------------------------------------------

/** The student's classes and not-done assignment titles, their rows only. */
export async function loadClassData(db, userId) {
    const [c, a] = await Promise.all([
        db.from("classes").select("id, name, short_name, source").eq("user_id", userId).order("sort_order"),
        db.from("assignments").select("title, class_id").eq("user_id", userId).eq("done", false).is("dropped_at", null).limit(500),
    ])
    if (c.error) throw c.error
    if (a.error) throw a.error
    return { classes: c.data || [], assignments: a.data || [] }
}

/** The raw ae_label from auth user_metadata, read fresh (not from the JWT). */
export async function loadLabel(db, userId) {
    const { data, error } = await db.auth.admin.getUserById(userId)
    if (error) throw error
    const meta = (data && data.user && data.user.user_metadata) || {}
    return meta.ae_label == null ? null : meta.ae_label
}

/**
 * Sets user_metadata.ae_label to null once it has been used, merged into the
 * rest of the metadata (age_confirmed_13, name, …). Re-read first: if the web
 * page has already written a newer label (a new recording), it is left alone.
 */
export async function clearUsedLabel(db, userId, used) {
    const { data, error } = await db.auth.admin.getUserById(userId)
    if (error) throw error
    const meta = (data && data.user && data.user.user_metadata) || {}
    const cur = meta.ae_label
    if (!cur || typeof cur !== "object") return false
    if (cur.startedAt !== used.startedAt) return false
    const { error: upErr } = await db.auth.admin.updateUserById(userId, { user_metadata: { ...meta, ae_label: null } })
    if (upErr) throw upErr
    return true
}
