// api/fill-form.js
//
// Chacevia "Read & Write" — PDF form filler.
// POST { pdf: base64, info: string }
//   - reads the PDF's fillable fields
//   - asks the AI to map the user's own info onto those fields
//   - returns the filled PDF
//
// Only fills real fillable (AcroForm) PDFs. Flat/scanned forms have no fields
// to fill and return a friendly message.

import OpenAI from "openai"
import { PDFDocument, StandardFonts } from "pdf-lib"

export const config = { maxDuration: 30 }

const DEFAULT_MODEL = "gpt-5.5"

function setCorsHeaders(res) {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type")
}

const INSTRUCTIONS = `You help a person fill out THEIR OWN PDF form using the personal details they gave you.

You receive: (1) the form's fields (name, type, and for choice fields the allowed options), and (2) the person's info. Return ONLY valid JSON — no markdown, no backticks — an object mapping each field name to the value to put in it.

Rules:
- Use the person's info to fill fields you can confidently match (name, email, phone, address, city, state, zip, date of birth, date, etc.).
- For checkbox fields, return "yes" or "no".
- For dropdown / radio / option fields, return EXACTLY one of the provided options, or "" if none fit.
- If you don't have info for a field, return "" for it. Never invent personal data (IDs, SSNs, signatures) you weren't given.
- For short open-ended prompts (e.g. "reason for applying"), you may write a brief, plain answer grounded in the person's info.
- Output every field name as a key.`

export function readFields(form) {
    return form.getFields().map((f) => {
        const o = { name: f.getName(), type: f.constructor.name }
        try {
            if (typeof f.getOptions === "function") o.options = f.getOptions()
        } catch (e) {}
        return o
    })
}

export function applyValues(form, map) {
    let filled = 0
    for (const f of form.getFields()) {
        const name = f.getName()
        const val = map[name]
        if (val === undefined || val === null || String(val) === "") continue
        const t = f.constructor.name
        try {
            if (t === "PDFTextField") f.setText(String(val))
            else if (t === "PDFCheckBox") {
                ["yes", "true", "x", "on", "1", "checked"].includes(String(val).toLowerCase()) ? f.check() : f.uncheck()
            } else if (t === "PDFDropdown" || t === "PDFOptionList") f.select(String(val))
            else if (t === "PDFRadioGroup") f.select(String(val))
            else continue
            filled++
        } catch (e) {}
    }
    return filled
}

export default async function handler(req, res) {
    setCorsHeaders(res)
    if (req.method === "OPTIONS") return res.status(204).end()
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed. Use POST." })

    let body = req.body
    if (typeof body === "string") {
        try { body = JSON.parse(body) } catch { return res.status(400).json({ error: "Body must be valid JSON." }) }
    }
    const pdfB64 = body && body.pdf
    const info = (body && body.info) || ""
    if (typeof pdfB64 !== "string" || !pdfB64) {
        return res.status(400).json({ error: "Missing PDF." })
    }
    if (!info.trim()) {
        return res.status(400).json({ error: "Add your info so I know what to fill in." })
    }
    if (!process.env.OPENAI_API_KEY) {
        return res.status(500).json({ error: "Server is missing OPENAI_API_KEY." })
    }

    try {
        const clean = pdfB64.replace(/^data:application\/pdf;base64,/, "")
        const bytes = Buffer.from(clean, "base64")

        let pdf
        try {
            pdf = await PDFDocument.load(bytes, { ignoreEncryption: true })
        } catch (e) {
            return res.status(400).json({ error: "That file couldn't be read as a PDF." })
        }

        const form = pdf.getForm()
        const fields = readFields(form)
        if (!fields.length) {
            return res.status(200).json({
                noFields: true,
                error: "This PDF doesn't have fillable form fields, so there's nothing to fill in automatically. It's likely a flat or scanned form.",
            })
        }

        // Ask the AI to map the person's info onto the fields.
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
        const model = process.env.OPENAI_MODEL || DEFAULT_MODEL
        const resp = await openai.responses.create({
            model,
            instructions: INSTRUCTIONS,
            input: `Form fields:\n${JSON.stringify(fields, null, 2)}\n\nThe person's info:\n${info}`,
        })

        let map = {}
        try {
            let t = String(resp.output_text || "").trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "")
            const a = t.indexOf("{"), b = t.lastIndexOf("}")
            map = JSON.parse(t.slice(a, b + 1))
        } catch (e) {
            return res.status(502).json({ error: "Couldn't read the AI's response. Please try again." })
        }

        const filled = applyValues(form, map)

        try {
            const helv = await pdf.embedFont(StandardFonts.Helvetica)
            form.updateFieldAppearances(helv)
        } catch (e) {}

        const outBytes = await pdf.save()
        const base64 = Buffer.from(outBytes).toString("base64")

        return res.status(200).json({
            file: base64,
            fileName: "filled-form.pdf",
            filled,
            total: fields.length,
        })
    } catch (err) {
        console.error("fill-form error:", err)
        return res.status(500).json({ error: "Something went wrong filling the form. Please try again." })
    }
}
