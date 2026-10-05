// node --test test/paper.test.mjs — the Morning Paper's facts, front page rules and news rules. Made-up data.
import test from "node:test"
import assert from "node:assert/strict"
import { paperFacts, marketRows, introText, tickerLines, fallbackFront, checkFront, assemble, firstNameOf } from "../api/_paper.js"
import { parseFeed, safeCandidates, checkPicks, UNSAFE } from "../api/_news.js"

const TZ = "America/Los_Angeles"
const WED_6AM = new Date("2026-10-07T13:00:00Z") // Wed Oct 7, 6:00am Pacific
const SAT_6AM = new Date("2026-10-10T13:00:00Z")
const classes = [
    { id: "c1", name: "Biology", short_name: "Bio", period: "1", start_time: "07:50", end_time: "08:40", days: ["Mon", "Tue", "Wed", "Thu", "Fri"] },
    { id: "c2", name: "Spanish 2", short_name: "Span", period: "7", start_time: "13:35", end_time: "14:25", days: ["Mon", "Wed", "Fri"] },
]
const R = (id, title, class_id, due_date, extra = {}) => ({ id, title, class_id, due_date, done: false, dropped_at: null, kind: null, due_at: null, ...extra })
const rows = [
    R("a1", "Lab report", "c1", "2026-10-07"),
    R("a2", "Vocab 4", "c2", "2026-10-08"),
    R("a3", "Essay draft", "c2", "2026-10-09"),
    R("a4", "Quiz corrections", "c1", "2026-10-09"),
    R("a5", "Unit test", "c1", "2026-10-09"),
    R("a6", "Done thing", "c1", "2026-10-07", { done: true }),
]
const facts = (over = {}) => paperFacts({ now: WED_6AM, tz: TZ, name: "Jagger", signupAt: "2026-08-20T18:00:00Z", classes, pattern: null, rows, yesterday: null, ...over })

test("a school day: schedule, due today, week strip, heaviest day, issue number", () => {
    const f = facts()
    assert.equal(f.dateLabel, "WED, OCT 7, 2026")
    assert.equal(f.issue, 49)
    assert.deepEqual(f.schedule, [{ label: "1 bio", time: "7:50" }, { label: "7 span", time: "1:35" }])
    assert.deepEqual(f.dueToday.map((x) => x.title), ["Lab report"])
    assert.deepEqual(f.week.map((w) => w.d + w.n + (w.today ? "*" : "") + (w.heavy ? "!" : "")), ["MON0", "TUE0", "WED1*", "THU1", "FRI3!"])
    assert.equal(f.heavy.d, "FRI"); assert.equal(f.heavy.n, 3)
    assert.deepEqual(f.next.map((x) => x.day + " " + x.title), ["TODAY lab report", "THU vocab 4", "FRI essay draft"])
    assert.equal(f.raw.stress, "MED")
})

test("market arrows compare with yesterday's paper, and only then", () => {
    assert.deepEqual(marketRows(facts()).map((r) => r.delta), ["", "", "", ""])
    const m = marketRows(facts({ yesterday: { homework: 3, freeMin: 180, stress: "HIGH", heavyIso: "2026-10-09", heavyN: 2 } }))
    assert.deepEqual(m.map((r) => [r.label, r.value, r.delta]), [
        ["HOMEWORK", "1", "▼ 2"], ["FREE TIME", "6H", "▲ 3H"], ["STRESS", "MED", "▼"], ["FRI OUTLOOK", "STORMY", "▲ 1"],
    ])
})

test("no classes saved: nothing is said about school either way", () => {
    const f = paperFacts({ now: WED_6AM, tz: TZ, name: null, signupAt: null, classes: [], pattern: null, rows: [], yesterday: null })
    assert.equal(f.hasSchedule, false)
    assert.match(fallbackFront(f).headline, /NOTHING DUE TODAY/)
    assert.equal(introText(f), "Nothing is due today.")
    assert.deepEqual(tickerLines(f, []), ["YOUR WEDNESDAY: LIGHT"])
})

test("a Saturday with no school: free-day front page, no invented classes", () => {
    const f = paperFacts({ now: SAT_6AM, tz: TZ, name: null, signupAt: null, classes, pattern: null, rows: [], yesterday: null })
    assert.equal(f.schoolDay, false); assert.deepEqual(f.schedule, [])
    const front = fallbackFront(f)
    assert.match(front.headline, /DAY OFF/); assert.match(front.deck, /^Sources confirm/)
    assert.equal(introText(f), "No classes today. Nothing is due today.")
    assert.deepEqual(tickerLines(f, []), ["YOUR SATURDAY: FREE"])
    assert.deepEqual(f.week.map((w) => w.d), ["MON", "TUE", "WED", "THU", "FRI"], "next week's strip on a weekend")
})

test("the front page check: off-limits words, invented numbers and names are refused", () => {
    const f = facts()
    const ok = JSON.stringify({ headline: "LOCAL STUDENT HAS JUST ONE THING DUE TODAY", highlight: "ONE", deck: "Sources close to Jagger confirm the lab report is the only threat.", forecast: "Friday is stormy with 3 due. Start the essay tonight." })
    assert.equal(checkFront(ok, f).highlight, "ONE")
    assert.equal(checkFront(ok.replace("only threat", "only threat to the GPA"), f), null)
    assert.equal(checkFront(ok.replace("3 due", "12 due"), f), null, "12 is not a fact")
    assert.equal(checkFront(ok.replace("Jagger", "Jagger"), { ...f, name: null }), null, "no name was given")
    assert.equal(checkFront("not json", f), null)
    assert.equal(checkFront(ok.replace('"ONE"', '"BANANA"'), f).highlight, "", "highlight must be in the headline")
})

test("assembled paper has every section, and the ticker ends with their own line", () => {
    const f = facts()
    const p = assemble(f, fallbackFront(f), [{ headline: "Turtles nest in California", ticker: "Turtles nest in California", summary: "x", source: "NOAA", url: "https://www.noaa.gov/x" }])
    assert.deepEqual(Object.keys(p), ["v", "date", "dateLabel", "issue", "name", "front", "market", "marketRaw", "intro", "schedule", "hasSchedule", "ticker", "news", "week", "next", "forecast"])
    assert.deepEqual(p.ticker, ["TURTLES NEST IN CALIFORNIA", "YOUR FRIDAY: HEAVY"])
})

test("first names: only a real-looking first name, never the email", () => {
    assert.equal(firstNameOf({ display_name: "Jagger B" }, {}), "Jagger")
    assert.equal(firstNameOf(null, { name: "maría josé" }), "maría")
    assert.equal(firstNameOf(null, { name: "jaggerbaldevia@gmail.com" }), null)
    assert.equal(firstNameOf(null, {}), null)
})

test("news: feed parsing, the word filter, and the model's picks are policed", () => {
    const xml = `<rss><channel><item><title><![CDATA[Turtles nest in California for the first time]]></title><link>https://www.noaa.gov/a</link><description>&lt;p&gt;Olive ridley sea turtles nested.&lt;/p&gt;</description><pubDate>Wed, 30 Sep 2026 13:21:42 +0000</pubDate></item><item><title>Storm kills two</title><link>https://example.gov/b</link><description>x</description></item></channel></rss>`
    const items = parseFeed(xml)
    assert.equal(items.length, 2); assert.equal(items[0].text, "Olive ridley sea turtles nested.")
    const safe = safeCandidates(items.map((i) => ({ ...i, source: "NOAA", topic: "nature" })))
    assert.deepEqual(safe.map((s) => s.title), ["Turtles nest in California for the first time"])
    const picks = checkPicks(JSON.stringify({ stories: [
        { n: 1, headline: "Sea turtles nest in California", ticker: "TURTLES NEST IN CA", summary: "Olive ridley sea turtles nested in California.", picture: "a sea turtle on a beach" },
        { n: 1, headline: "duplicate", summary: "dup" },
        { n: 9, headline: "not in the list", summary: "made up" },
    ] }), safe)
    assert.equal(picks.length, 1); assert.equal(picks[0].url, "https://www.noaa.gov/a"); assert.equal(picks[0].source, "NOAA")
    assert.equal(checkPicks(JSON.stringify({ stories: [{ n: 1, headline: "Turtles survive war", summary: "x" }] }), safe).length, 0)
    assert.ok(UNSAFE.test("Senator votes on budget") && !UNSAFE.test("Rocket lands on a ship at sea"))
})
