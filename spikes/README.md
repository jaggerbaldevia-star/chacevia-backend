# Spikes — parked, NOT deployed

Code here is deliberately outside `api/`. Vercel only turns `api/*.js` into
serverless functions, so nothing in this folder counts against the Hobby
12-function cap.

## calendar.js

Moved out of `api/` on 2026-09-29. It was untracked, so it had never shipped —
but it sat one `vercel --prod` away from becoming a 13th function and silently
breaking the build.

A read-only iCalendar (`.ics`) feed of a user's homework reminders, so they can
"Add Subscription Calendar" on iPhone and get native lock-screen alerts without
the app. Auth is an opaque per-user token (`?token=...`) rather than a Supabase
session, because Apple's Calendar app can't send one.

Still needs before it can ship:
  - a `public.calendar_tokens` table (does not exist yet)
  - hardening — the file marks itself "SPIKE — not production-hardened"
  - a free function slot, or fold it into an existing route via a `vercel.json`
    rewrite the way the canvas-* and stripe-* actions already are

Note: `api/account.js` already lists `calendar_tokens` in USER_TABLES for
account deletion, and tolerates the table being absent. That stays correct.

To bring it back:  git mv spikes/calendar.js api/calendar.js
