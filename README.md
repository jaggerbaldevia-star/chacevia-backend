# Chacevia Backend — AI Creative Director Endpoint

A tiny, focused Vercel backend that powers Chacevia's AI creative director.
Your Framer site sends a creative idea to this backend, the backend safely
calls OpenAI using a **hidden** API key, and the polished creative direction
comes back to your site.

---

## 1. What this backend does

- Exposes a single endpoint: **`/api/creative-ai`**
- Accepts a `POST` request with a creative idea
- Calls OpenAI with Chacevia's custom "creative director" instructions
- Returns clean JSON with the AI's creative direction
- **Keeps your OpenAI API key secret** — it lives only on the server, never in Framer

It deliberately does **not** include accounts, payments, databases, saved
history, or image generation. Just one reliable endpoint.

**Request shape (what your site sends):**

```json
{ "input": "Create an avant-garde logo direction for Chacevia." }
```

**Response shape (what your site gets back):**

```json
{ "output": "AI-generated creative direction goes here" }
```

If something is wrong, you instead get a clean error like:

```json
{ "error": "Missing or invalid 'input'. It must be a non-empty string." }
```

---

## 2. Folder structure

```
chacevia-backend/
├── api/
│   └── creative-ai.js     # The serverless endpoint (the actual logic)
├── package.json           # Project name + dependencies (the openai SDK)
├── .gitignore             # Files git should ignore (node_modules, secrets)
├── .env.example           # Example env file with FAKE placeholder values
└── README.md              # This file
```

When you create your `.env.local` for local testing, it sits in the project
root next to `package.json`. It is ignored by git, so it never gets uploaded.

---

## 3. Install dependencies locally

You need **Node.js 20 or newer** installed. Check with:

```bash
node -v
```

Then, inside the project folder, install the OpenAI SDK:

```bash
npm install
```

That reads `package.json` and downloads the `openai` package into
`node_modules/`.

---

## 4. Create a `.env.local` file for local testing

In the project root, make a file called `.env.local`. The easiest way is to
copy the example:

```bash
# Mac / Linux
cp .env.example .env.local

# Windows PowerShell
Copy-Item .env.example .env.local
```

Then open `.env.local` and replace the placeholders with real values. It
should look like this (with your real key):

```
OPENAI_API_KEY=sk-your-real-key-here
OPENAI_MODEL=gpt-5.5
```

**Never commit this file.** `.gitignore` already excludes it.

---

## 5. Environment variables needed

| Variable         | Required? | What it is                                                    |
| ---------------- | --------- | ------------------------------------------------------------- |
| `OPENAI_API_KEY` | **Yes**   | Your secret OpenAI key. Get it at platform.openai.com.        |
| `OPENAI_MODEL`   | No        | Which model to use. Defaults to `gpt-5.5` if you leave it out. |

Cheaper model option for `OPENAI_MODEL`: `gpt-5.4-mini`.

---

## 6. Run / test the endpoint locally (optional)

The cleanest way to run this locally is with the Vercel CLI, which mimics the
real Vercel environment and reads your `.env.local` automatically:

```bash
npm install -g vercel   # one-time install
vercel dev
```

This usually serves your endpoint at:

```
http://localhost:3000/api/creative-ai
```

Test it in a second terminal:

```bash
curl -X POST http://localhost:3000/api/creative-ai ^
  -H "Content-Type: application/json" ^
  -d "{\"input\":\"Create an avant-garde logo direction for Chacevia.\"}"
```

> Local testing is optional. If it gives you trouble, skip it and test the
> deployed version instead (Step 10 below) — that's the one that actually
> matters for your live site.

---

## 7. Deploy to Vercel

The easiest path is GitHub → Vercel:

1. Push this project to a GitHub repository (see the checklist at the bottom).
2. Go to **vercel.com** and sign in (you can sign in with GitHub).
3. Click **Add New… → Project**.
4. **Import** your `chacevia-backend` GitHub repository.
5. Leave the framework preset as **Other** (this is just an API, no framework).
6. Click **Deploy**.

Vercel automatically treats every file in the `api/` folder as a serverless
function, so `/api/creative-ai` just works — no extra config needed.

---

## 8. Where to add `OPENAI_API_KEY` inside Vercel

1. Open your project on Vercel.
2. Go to **Settings → Environment Variables**.
3. Add a new variable:
   - **Name:** `OPENAI_API_KEY`
   - **Value:** your real secret key
   - **Environments:** check **Production**, **Preview**, and **Development**
4. (Optional) Add a second variable:
   - **Name:** `OPENAI_MODEL`
   - **Value:** `gpt-5.5` (or `gpt-5.4-mini` to save money)
5. Click **Save**.

---

## 9. Redeploy after adding environment variables

Environment variables only take effect on the **next** deploy. After adding
the key:

1. Go to the **Deployments** tab.
2. Click the **•••** menu on the most recent deployment.
3. Click **Redeploy**.

(Or just push any small change to GitHub — Vercel redeploys automatically.)

---

## 10. Test the deployed endpoint

Replace `YOUR-PROJECT` with your real Vercel project URL.

**curl (Mac/Linux, or Windows if you have curl):**

```bash
curl -X POST https://YOUR-PROJECT.vercel.app/api/creative-ai ^
  -H "Content-Type: application/json" ^
  -d "{\"input\":\"Create an avant-garde logo direction for Chacevia.\"}"
```

**Windows PowerShell:**

```powershell
Invoke-RestMethod `
  -Uri "https://YOUR-PROJECT.vercel.app/api/creative-ai" `
  -Method Post `
  -ContentType "application/json" `
  -Body '{"input":"Create an avant-garde logo direction for Chacevia."}'
```

If it works, you'll get back a JSON object with an `output` field full of
creative direction. 🎉

---

## 11. Connect the endpoint to a Framer code component

In Framer:

1. Go to the **Assets** panel → **Code** → **+** → **New Code File**.
2. Paste in the `ChaceviaInput.tsx` component (provided separately).
3. Find the line near the top:
   ```js
   const ENDPOINT = "https://YOUR-PROJECT.vercel.app/api/creative-ai"
   ```
   Replace it with your real Vercel URL.
4. Drag the component onto your canvas, or insert it where you want the AI box.
5. Publish your Framer site.

The component only calls your public Vercel endpoint. It never sees or stores
your OpenAI key.

---

## 12. Common errors and how to fix them

| What you see                                              | Likely cause                                              | Fix                                                                                  |
| -------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `Server is missing OPENAI_API_KEY`                       | Key not set in Vercel, or you didn't redeploy after adding it | Add the env var (Step 8), then redeploy (Step 9).                                     |
| `Method not allowed. Use POST.`                          | You opened the URL in a browser (that's a GET request)    | Normal. The endpoint only answers POST. Test with curl/PowerShell or your Framer box. |
| `Missing or invalid 'input'`                             | The request body didn't include a valid `input` string    | Make sure you send `{"input":"..."}` as JSON with `Content-Type: application/json`.   |
| `Input is too long`                                      | The idea is over 3000 characters                          | Shorten the input. (You can raise the limit in `creative-ai.js` if needed.)           |
| CORS error in the browser console                        | Browser blocked the cross-site request                    | The backend already allows all origins; confirm your endpoint URL is correct and deployed. |
| `Something went wrong generating creative direction`     | The OpenAI call failed (bad key, no billing, model name)  | Check the key is valid, billing is enabled, and `OPENAI_MODEL` is a real model name. Check Vercel logs. |
| `429` / rate limit from OpenAI                           | Too many requests or no credit on the OpenAI account      | Add billing/credits in your OpenAI account, or slow down requests.                   |

To read server logs: in Vercel, open your project → **Logs** (or click a
deployment → **Functions**) to see the `console.error` output.

---

## Future security improvements (optional, not needed yet)

These are easy wins you can add later without complicating the project:

- **Lock down CORS:** In `creative-ai.js`, replace `"*"` with your exact Framer
  domain so only your site can call the endpoint.
- **Add light rate limiting:** Once you have real traffic, Vercel's built-in
  firewall / rate-limit settings can cap abuse without code changes.
- **Cap costs in OpenAI:** Set a monthly spending limit in your OpenAI billing
  dashboard as a safety net.
