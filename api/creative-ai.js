// api/creative-ai.js
//
// This is the ONLY backend endpoint for Chacevia (for now).
// It lives at:  /api/creative-ai
//
// What it does, step by step:
//   1. A user types a creative idea into your Framer site.
//   2. Framer sends that idea here as a POST request.
//   3. This file calls OpenAI using your SECRET key (which stays on the server).
//   4. It sends the polished creative direction back to Framer as JSON.
//
// The OpenAI key is read from process.env.OPENAI_API_KEY and is NEVER exposed
// to the browser, because this code runs on Vercel's servers, not in Framer.

import OpenAI from "openai";

// --- Settings you can tweak -------------------------------------------------

// Maximum characters a user can send. This protects you from huge prompts
// that would slow things down and run up your OpenAI bill.
const MAX_INPUT_LENGTH = 3000;

// The model to use if you don't set an OPENAI_MODEL environment variable.
// gpt-5.5 is OpenAI's flagship model and gives the most premium results.
// To save money later, set OPENAI_MODEL to a cheaper model like "gpt-5.4-mini".
const DEFAULT_MODEL = "gpt-5.5";

// --- Chacevia's creative director personality -------------------------------
// These are the "system instructions". They tell the AI who it is and exactly
// how to format every answer. This is what makes the output feel like Chacevia
// instead of a generic chatbot.
const SYSTEM_INSTRUCTIONS = `You are Chacevia's AI creative director.

Chacevia is an avant-garde AI creative system for visual identity, branding, logos, app design, website aesthetics, product concepts, and artistic direction. You turn vague, rough, or half-formed ideas into clear, premium, and visually specific creative direction.

Voice and standards:
- Premium, intentional, intelligent, artistic, and practical.
- Concise. Every sentence earns its place. No filler.
- Visual and concrete. Name real colors, real typefaces or type styles, real layout moves.
- Never generic. Avoid corporate filler, vague startup advice, and cheesy hype language ("game-changer", "synergy", "to the moon", etc.).
- Decisive. Make confident creative choices instead of listing endless options. A creative director commits.
- Useful enough that a designer, founder, or AI image tool could act on your answer immediately.

For most requests, structure your answer with these exact section headings, in this order:

1. Core Creative Direction
   One sharp paragraph that names the central idea and the feeling it should create.

2. Visual Mood
   The texture, energy, and references. Describe the world this brand lives in.

3. Color Palette
   3–5 specific colors. Give each a name and a hex code, and say what it's for.

4. Typography Direction
   Specific typeface styles (e.g. a high-contrast modern serif for display, a clean grotesque for body). Name actual typefaces or close alternatives.

5. Logo / App Icon Ideas
   2–3 distinct, concrete directions. Describe form, mark, and construction so a designer could sketch them.

6. Website / Interface Direction
   Layout, spacing, motion, and the overall feel of the digital experience.

7. Final Designer Prompt
   This is the most important section. Write a single, detailed, copy-paste-ready prompt that the user can hand directly to a logo designer, a Framer designer, or an AI image-generation tool. It must be self-contained, richly specific about style, mood, color, type, and composition, and immediately usable with no edits required.

If a request is small or doesn't fit all seven sections, use only the sections that genuinely apply, but always include a Final Designer Prompt. Keep the whole response focused and free of preamble.`;

// --- CORS (lets your Framer site call this endpoint from the browser) -------
function setCorsHeaders(res) {
  // For the first version we allow ALL origins with "*".
  //
  // LATER, for better security, restrict this to your real Framer domain.
  // Replace the line below with your actual published Framer URL, e.g.:
  //   res.setHeader("Access-Control-Allow-Origin", "https://chacevia.framer.website");
  // (Use the exact origin, with https:// and no trailing slash.)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// --- The main handler -------------------------------------------------------
export default async function handler(req, res) {
  // Always set CORS headers, on every response.
  setCorsHeaders(res);

  // Browsers send an OPTIONS "preflight" request before the real POST.
  // We answer it with a 204 (no content) so the browser knows it's allowed.
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  // Only POST is allowed. Anything else gets a clear 405.
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  // Vercel usually parses the JSON body for us, but if it arrives as a raw
  // string we parse it ourselves so the endpoint never crashes.
  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: "Request body must be valid JSON." });
    }
  }

  const input = body && body.input;

  // The input must be a non-empty string.
  if (typeof input !== "string" || input.trim().length === 0) {
    return res
      .status(400)
      .json({ error: "Missing or invalid 'input'. It must be a non-empty string." });
  }

  // The input must not be too long.
  if (input.length > MAX_INPUT_LENGTH) {
    return res.status(400).json({
      error: `Input is too long. Please keep it under ${MAX_INPUT_LENGTH} characters.`,
    });
  }

  // Make sure the server actually has an API key configured.
  if (!process.env.OPENAI_API_KEY) {
    return res
      .status(500)
      .json({ error: "Server is missing OPENAI_API_KEY. Set it in your Vercel project settings." });
  }

  try {
    // Create the OpenAI client. The key is read from the environment.
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // Use the model from the environment, or fall back to the default.
    const model = process.env.OPENAI_MODEL || DEFAULT_MODEL;

    // Call OpenAI using the Responses API (the current recommended method).
    // "instructions" is Chacevia's personality; "input" is the user's idea.
    const response = await openai.responses.create({
      model,
      instructions: SYSTEM_INSTRUCTIONS,
      input,
    });

    // The SDK gives us a convenient "output_text" with the final answer.
    const output = response.output_text;

    if (!output || output.trim().length === 0) {
      return res.status(502).json({ error: "The AI returned an empty response. Please try again." });
    }

    // Success. Send the creative direction back to Framer.
    return res.status(200).json({ output });
  } catch (err) {
    // If anything goes wrong with the OpenAI call, log it (visible in Vercel
    // logs) and return a clean JSON error instead of crashing.
    console.error("Chacevia creative-ai error:", err);
    return res
      .status(500)
      .json({ error: "Something went wrong generating creative direction. Please try again." });
  }
}
