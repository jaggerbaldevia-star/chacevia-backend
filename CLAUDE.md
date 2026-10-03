# Chacevia backend

## How to work with Jagger

Jagger describes what he wants in plain words. You handle it end to end: code,
Supabase, Vercel, EAS builds, testing, and copying the Framer component to the
clipboard (UTF-8 safe — `pbcopy` with a UTF-8 locale, never `echo` through a
pipeline that mangles emoji or curly quotes).

**Never ask him to paste SQL or run a command himself.** If a tool blocks you,
say so plainly and say what you need — don't hand him the work.

**Stop and ask for exactly three things:**

1. **Deleting or changing another real user's data.** One-line summary, he says
   yes or no. His own account is not in this category — if he asked for it, do it.
2. **Submitting to Apple, or anything that costs money.** Builds are free to run;
   submissions, paid services and purchases are not.
3. **Publishing in Framer.** He presses that button himself. Copy the component
   to his clipboard and stop there.

Everything else — schema changes, migrations, fixing his own data, deploys,
preview builds, running tests — just do it.

**Answer in 2–3 short sentences.** He is a beginner and often tired. Lead with
the result, not the reasoning. No walls of text, no options menus, no SQL dumps
unless he asks. If something went wrong, say what broke and what you did about
it, in plain words.

Report honestly: if a step failed or was skipped, say so. Never claim something
ran when it didn't.

## Keep the status log

After every task, append a short entry to `~/Desktop/chacevia-status.md`. Append
to the end so it reads oldest-first; never rewrite or reorder old entries.

Each entry covers:

- **Date and time** (the real local time, not a guess)
- **What you did**
- **What is live vs not** — be specific about which of the three moving parts:
  the Framer site (published or only pushed), the Vercel backend (deployed or
  only committed), and the iOS app (built, on TestFlight, or neither)
- **What you need from Jagger**, or "nothing" when that is true
- **Secrets he must paste somewhere**

**Never write a secret value into this file.** Write `secret shown in chat` and
nothing more. The file sits on the Desktop in plain text and gets opened,
screenshotted and shared; the chat is where a value belongs. This applies to
RevenueCat webhook secrets, `CRON_SECRET`, API keys and tokens alike.

Keep each entry to a few lines. It is a log Jagger skims to remember where
things stand, not a changelog or a report.

## Apple and RevenueCat accounts

Direct access to App Store Connect and RevenueCat means some actions are no
longer reversible by editing code. These are **never** done without an explicit
yes, even when a task seems to imply them:

- **Submitting anything for review.** Not an app version, not an in-app purchase,
  not a metadata change that triggers review. Saving a draft is fine; pressing
  submit is not.
- **Signing or accepting any agreement.** Paid Apps, tax forms, developer terms.
- **Changing bank, tax or payout details.** Read them if a diagnosis needs it;
  never edit them.
- **Deleting or disabling live products, offerings or entitlements.** Creating
  and correcting is fine; removing something customers can already buy is not.

Price, availability, localization and review-screenshot edits on a product that
has never shipped are ordinary work — but **show the list of changes first** and
apply them only once he has seen it.

## Credentials

- Keys live outside every repo. `.p8` files go in `~/.appstoreconnect/`, `chmod
  600`, directory `chmod 700`.
- API keys go in env or MCP config, never in a repo, never in
  `~/Desktop/chacevia-status.md`, never in a commit message.
- Never print a key's contents — not to the terminal, not into a file, not in a
  reply. Identify keys by filename and id only.
- Two different Apple `.p8` types exist and are not interchangeable:
  `AuthKey_<id>.p8` is an **App Store Connect API** key (the one that carries a
  role like App Manager), `SubscriptionKey_<id>.p8` is an **In-App Purchase** key
  for StoreKit. Check which one is in hand before wiring anything up.

## Supabase is production, with real users

Five accounts, real data. `canvas_links` has RLS on with zero policies by
design — only the service role reads it.

Bulk deletes across users always need a yes first (see rule 1 above).
