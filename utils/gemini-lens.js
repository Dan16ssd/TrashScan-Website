'use strict';

const guidelines = require('../data/recycling-guidelines.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isTransient(status) {
  return status === 503 || status === 429 || status === 500;
}

function isNetworkError(err) {
  return err.name === 'TimeoutError' ||
    err.cause?.code === 'ENOTFOUND' ||
    err.cause?.code === 'ECONNRESET';
}

const PROMPT =
  'You are the advanced Object Detection and Vision AI engine for the S.A.R.A. recycling app. ' +
  'Your task is to analyze the uploaded image, look for waste or recyclable items, detect their exact ' +
  'locations so the app can crop them, and provide recycling data. ' +
  'For every distinct waste or recyclable item you see in the image, you must find its boundaries and return the data. ' +
  'CRITICAL: Provide the location using normalized bounding box coordinates [ymin, xmin, ymax, xmax] on a scale of 0 to 1000. ' +
  'Also set "in_use": true when the item appears to still be in active use rather than discarded — e.g. held in a hand, ' +
  'full or unopened, plugged in, or placed on a desk or shelf; set "in_use": false when it appears to be waste — ' +
  'empty, crushed, on the ground, or in or near a bin. If the image contains no waste or recyclable items at all, return []. ' +
  'Output ONLY a JSON array — no markdown, no code fences, no conversational text: ' +
  '[{"box_2d":[200,150,600,850],"label":"Plastic Water Bottle","category":"Recyclable","material":"PET Plastic","in_use":false,"action_required":"Rinse, crush, and place in the blue recycling bin."}]';

// ── Material key helper ───────────────────────────────────────────────────────
function getMaterialKey(raw) {
  if (raw.includes('plastic'))  return 'plastic';
  if (raw.includes('metal') || raw.includes('aluminum') || raw.includes('steel')) return 'metal';
  if (raw.includes('glass'))    return 'glass';
  if (raw.includes('paper') || raw.includes('cardboard')) return 'paper';
  if (raw.includes('organic') || raw.includes('food'))    return 'organic';
  if (raw.includes('ewaste') || raw.includes('e-waste') || raw.includes('electronic')) return 'ewaste';
  if (raw.includes('hazard'))   return 'hazardous';
  return raw.replace(/[^a-z]/g, '') || 'mixed';
}

// ── Gemini ────────────────────────────────────────────────────────────────────
async function callGemini(model, imageBase64, mimeType) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw Object.assign(new Error('GEMINI_API_KEY not set'), { fatal: true });

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: mimeType, data: imageBase64 } },
            { text: PROMPT },
          ],
        }],
        generationConfig: { temperature: 0.1 },
      }),
      signal: AbortSignal.timeout(30000),
    }
  );

  if (!resp.ok) {
    const text = await resp.text();
    const err = new Error(`Gemini ${model} error ${resp.status}: ${text}`);
    err.status = resp.status;
    throw err;
  }

  const data = await resp.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ── Groq (free) ───────────────────────────────────────────────────────────────
async function callGroq(imageBase64, mimeType) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw Object.assign(new Error('GROQ_API_KEY not set'), { fatal: true });

  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
          { type: 'text', text: PROMPT },
        ],
      }],
      temperature: 0.1,
      max_tokens: 600,
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!resp.ok) {
    const text = await resp.text();
    const err = new Error(`Groq error ${resp.status}: ${text}`);
    err.status = resp.status;
    throw err;
  }

  const data = await resp.json();
  return data?.choices?.[0]?.message?.content || '';
}

// ── Hugging Face router (free tier, non-Gemini/non-Groq backstop) ─────────────
async function callHuggingFace(imageBase64, mimeType) {
  const apiKey = process.env.HF_TOKEN;
  if (!apiKey) throw Object.assign(new Error('HF_TOKEN not set'), { fatal: true });

  const resp = await fetch('https://router.huggingface.co/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'Qwen/Qwen2.5-VL-3B-Instruct',
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
          { type: 'text', text: PROMPT },
        ],
      }],
      temperature: 0.1,
      max_tokens: 600,
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!resp.ok) {
    const text = await resp.text();
    const err = new Error(`HuggingFace error ${resp.status}: ${text}`);
    err.status = resp.status;
    throw err;
  }

  const data = await resp.json();
  return data?.choices?.[0]?.message?.content || '';
}

// ── Parse and enrich array response from any model ────────────────────────────
function parseAndEnrichArray(rawText) {
  const cleaned = rawText.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();

  let items;
  try {
    items = JSON.parse(cleaned);
  } catch {
    // Model added text around the JSON — extract the first [...] block
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('No JSON array in AI response');
    items = JSON.parse(match[0]);
  }

  if (!Array.isArray(items)) items = [items];

  // Models sometimes return a placeholder item instead of [] when nothing
  // waste-like is in frame (e.g. {"label":"None"}). Drop those.
  const JUNK_LABELS = new Set(['none', 'unknown', 'nothing', 'no item', 'no items', 'n/a', 'na', 'null', 'not applicable', '-']);
  items = items.filter((item) => {
    const label = String(item.label || '').trim().toLowerCase();
    const mat   = String(item.material || '').trim().toLowerCase();
    if (!label && !mat) return false;
    if (JUNK_LABELS.has(label) || JUNK_LABELS.has(mat)) return false;
    return true;
  });

  return items.map((item) => {
    const raw = (item.material || '').toLowerCase();
    const materialKey = getMaterialKey(raw);
    const guide = guidelines[materialKey] || guidelines['mixed'];

    return {
      box_2d: Array.isArray(item.box_2d) && item.box_2d.length === 4 ? item.box_2d : null,
      label:  item.label   || item.material || 'Unknown item',
      object: item.label   || item.material || 'Unknown item',
      material: guide.name || item.material,
      category: item.category || guide.name,
      recyclable: typeof item.recyclable === 'boolean' ? item.recyclable : guide.recyclable,
      in_use: item.in_use === true,
      guidelines: guide.guidelines,
      icon: guide.icon,
      disposalInstructions: item.action_required || guide.guidelines[0],
    };
  });
}

// ── Fallback chain: gemini-2.5-flash → gemini-2.5-pro → gemini-2.5-flash-lite → groq-llama-vision → hf-qwen2.5-vl ──
// Note: gemini-1.5-flash was retired from the Gemini API in Sept 2025 and now
// returns a "model not found" error, so the chain uses currently available
// models instead — 2.5-pro is slower but more precise, used as the second
// attempt before dropping to the lighter flash-lite. Groq and the Hugging
// Face router are independent (non-Gemini) providers, kept as last-resort
// backstops so a Gemini-wide outage doesn't take the scanner down.
const PROVIDERS = [
  { name: 'gemini-2.5-flash', call: (b64, mime) => callGemini('gemini-2.5-flash', b64, mime) },
  { name: 'gemini-2.5-pro', call: (b64, mime) => callGemini('gemini-2.5-pro', b64, mime) },
  { name: 'gemini-2.5-flash-lite', call: (b64, mime) => callGemini('gemini-2.5-flash-lite', b64, mime) },
  { name: 'groq-llama-vision', call: (b64, mime) => callGroq(b64, mime) },
  { name: 'hf-qwen2.5-vl', call: (b64, mime) => callHuggingFace(b64, mime) },
];

async function analyzeTrashImage(imageBase64, mimeType = 'image/jpeg') {
  const anyKeyConfigured =
    process.env.GEMINI_API_KEY || process.env.GROQ_API_KEY || process.env.HF_TOKEN;
  if (!anyKeyConfigured) throw new Error('No vision provider API key configured');

  let lastErr;

  for (const provider of PROVIDERS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const rawText = await provider.call(imageBase64, mimeType);
        return parseAndEnrichArray(rawText);
      } catch (err) {
        lastErr = err;

        // fatal means this provider's own key is missing — skip straight to
        // the next provider rather than aborting the whole chain.
        if (err.fatal) break;

        const retry = isNetworkError(err) || (err.status && isTransient(err.status));
        if (retry && attempt === 0) {
          await sleep(1200);
          continue;
        }
        break;
      }
    }
  }

  throw lastErr || new Error('All AI providers failed');
}

module.exports = { analyzeTrashImage };
