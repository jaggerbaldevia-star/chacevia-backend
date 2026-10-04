// api/_rocco_lines.js
//
// Rocco's reminder lines. EDIT FREELY — this file is the whole pool.
//
// Every line MUST contain all three placeholders, because a reminder that
// doesn't name the work is one students ignore:
//
//   {title}  the assignment, e.g. "Ch. 4 reading"
//   {class}  the class, e.g. "Chem"
//   {when}   when it's due, e.g. "3rd period tomorrow", "tomorrow", "Friday"
//
// Tone rules (checked by test/rocco-lines.test.mjs):
//   - Teasing is fine. Shame isn't.
//   - No guilt, no "quitter", no disappointment about missed days.
//   - Rocco is never sad, hurt, lonely, sick or dying.
//   - No emoji (they clash with the pixel font). Keep it under ~110 characters.
//
// A user never gets the same line twice within 14 days. At the default cap of
// 4 a day that's at most 56 sends, so keep at least 56 lines here (there are
// 60). Someone who raises their cap can run the pool dry; then the line used
// longest ago is picked.
//
// Changing or removing a line is safe. Lines are tracked by their text, so an
// edited line just counts as a new one.

export const REMINDER_LINES = [
    "{title} for {class}. Due {when}. I'm just the messenger. A very small, very loud messenger.",
    "Psst. {title}. {class}. {when}. That's the whole message. Okay bye.",
    "{class} wants {title} {when}. I said I'd pass it on. Passing it on.",
    "Knock knock. It's {title}. For {class}. Due {when}. Not a great joke, very real deadline.",
    "Reminder from your favorite blob: {title} for {class} is due {when}.",
    "{title} ({class}) is due {when}. I believe in you a normal, healthy amount.",
    "Small blob, big news: {title} for {class}, due {when}.",
    "Me again! {title} for {class} is due {when}. I'll stop when you stop being so busy.",
    "{when}: {title} for {class}. Write it on your hand if you have to. I'm not judging.",
    "Hey hey hey. {title}. {class}. Due {when}. That's three heys, it's important.",
    "{title} is due {when} in {class}. Ten minutes now makes later-you very smug.",
    "Plot twist: {title} for {class} is due {when}. Okay not really a twist. Still due.",
    "{class} homework alert: {title}, due {when}. I'll be over here cheering. Quietly. Ish.",
    "Rocco's official notice: {title}, {class}, due {when}. This notice is extremely official.",
    "{title} for {class} is due {when}. Start with the easiest part. I'll allow it.",
    "Beep boop. {title}. {class}. {when}. I'm not a robot, I just like saying beep boop.",
    "You + {title} + {class} + {when}. Math says you've got this. I checked twice.",
    "Quick one: {title} for {class}, due {when}. Open it, read the first line, that's a start.",
    "{title}? For {class}? Due {when}? Asking for a friend. The friend is me.",
    "I put {title} for {class} on my tiny calendar. It says {when}. My calendar is never wrong.",
    "{class} called. Okay, it didn't. But {title} is still due {when}.",
    "Heads up: {title} for {class} is due {when}. Snacks recommended, not required.",
    "{title} for {class}, due {when}. Five minutes counts. I'm counting.",
    "Your daily dose of Rocco: {title} for {class} is due {when}.",
    "{title} is waiting for you in {class} land. Due {when}. It's a patient assignment.",
    "Tiny reminder, big energy: {title} for {class}, due {when}.",
    "{title} for {class} is due {when}. Phone down, pencil up. Then phone back up, obviously.",
    "Not to be dramatic, but {title} for {class} is due {when}. Okay, slightly dramatic.",
    "{class} check: {title} is due {when}. Want a timer? Tap me.",
    "I keep thinking about {title}. For {class}. Due {when}. Is that weird? It's my job.",
    "{title} ({class}, due {when}). Chip away at it. I'll hold the snacks.",
    "Ding! {title} for {class} is due {when}. That was the official ding.",
    "{when} is when {title} for {class} is due. I rearranged the sentence to keep it fresh.",
    "{title} for {class} is due {when}. If you already did it, tap Done and I'll go away happy.",
    "Breaking news from Rocco HQ: {title} for {class} is due {when}. More at eleven.",
    "{title}. {class}. {when}. I'd write a longer note but my arms are very short.",
    "Fun fact: {title} for {class} is due {when}. Okay, it's more of a regular fact.",
    "{class} has entered the chat: {title}, due {when}.",
    "Hi! It's me. {title} for {class}, due {when}. That's it, that's the reminder.",
    "{title} for {class} is due {when}. Future you just sent a thank-you note. I read it.",
    "Pop quiz: when is {title} for {class} due? Answer: {when}. You passed.",
    "{title} ({class}) is due {when}. One small step for you, one giant nap for me after.",
    "Rocco's to-do list: 1. remind you about {title} for {class}, due {when}. 2. Snacks.",
    "{when} is coming for {title} in {class}. Gently. Like a polite train.",
    "{title} for {class} is due {when}. Headphones in, tab open, go get it.",
    "This is your friendly neighborhood blob. {title} for {class} is due {when}.",
    "{title} for {class}, due {when}. Even a messy first try counts. Especially a messy one.",
    "{class} memo: {title} is due {when}. I stamped it. With my face.",
    "Guess who remembered {title} for {class}? Me. It's due {when}. I'm very proud of me.",
    "{title} for {class} is due {when}. Do the part you know first. Momentum is real.",
    "{title}, {class}, {when}. Three things. You can carry three things.",
    "Rocco here, reporting for duty: {title} for {class} is due {when}.",
    "{title} for {class} is due {when}. I made you a tiny cheer: go, go, go. That was it.",
    "{class} reminder with extra sprinkles: {title}, due {when}.",
    "{title} for {class} lands {when}. Want to knock out the first bit now? I'll wait. Ish.",
    "Scheduled interruption: {title} for {class}, due {when}. Resume your day.",
    "{title} for {class} is due {when}. Set a 15-minute timer and see what happens.",
    "Somebody has {title} for {class} due {when}. It's you. Hi.",
    "{title} for {class}, due {when}. I'll be extremely annoying about this, but nicely.",
    "Your {class} sidekick checking in: {title} is due {when}.",
]

// The one line sent when someone has ignored reminders for 5 days in a row.
// After this, Rocco only sends reminders the student set up themselves.
export const SIGN_OFF_LINE = "I'll stop bugging you. I'm here when you need me."

// "Ask me after each class" prompts. {class} only; there's no assignment yet.
export const AFTER_CLASS_LINES = [
    "{class}'s done. Anything to log?",
    "{class} just ended. Got homework? Tap Add.",
    "That's {class}. Anything due? I've got a pocket for it.",
    "{class} over. Homework? Quick add, three taps.",
    "{class} wrapped. Did they assign anything?",
    "Out of {class}! Anything I should remember for you?",
    "{class}'s a wrap. Homework to log?",
    "Bye, {class}. Anything to write down before it escapes?",
    "{class} finished. Tap Add if something's due.",
    "{class} done and dusted. Any homework?",
]

// After-school-only mode: one prompt for the whole day.
export const AFTER_SCHOOL_LINES = [
    "School's out. Anything to log from today?",
    "Done for the day? Tell me what got assigned.",
    "Bell rang. Any homework I should know about?",
    "School's over! Anything due that I should hold onto?",
    "Free at last. Quick: any homework from today?",
    "Day's done. Anything to add before you forget?",
]

// Words that must never appear in any line above (case-insensitive).
export const BANNED_WORDS = [
    "quitter", "quit on", "disappoint", "ashamed", "shame", "guilt", "lazy",
    "sad", "cry", "crying", "hurt", "dying", "die", "dead", "lonely",
    "abandon", "you failed", "fail", "missed you", "where were you",
]
