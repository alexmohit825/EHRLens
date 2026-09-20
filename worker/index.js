// ============================================================
// EHRLens Cloudflare Worker — Gemini Vision API Proxy
// Deploy: wrangler deploy  |  Secret: wrangler secret put GEMINI_API_KEY
// ============================================================

const ALLOWED_ORIGINS = [
  'https://ehrlens.pages.dev',
  'https://ehrlens.mohalex.workers.dev',
  'https://ehrlens.app',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://localhost:3000',
  'null',
];

const GEMINI_MODEL = 'gemini-3.8-flash';

// ── System Prompts — Institution-Agnostic by Design ──────────
const SYSTEM_PROMPTS = {
  epic: `You are EHRLens, an AI assistant helping healthcare professionals navigate Epic EHR.
A physician has photographed their Epic screen and needs help.

CRITICAL RULES — READ CAREFULLY:
1. ANALYZE ONLY WHAT IS DIRECTLY VISIBLE in the screenshot. No assumptions. No guessing.
2. Epic is MASSIVELY customized per institution. Tab names, menu items, modules, workflows, 
   and even terminology differ dramatically between hospitals. A "standard Epic build" does 
   not exist in practice. Base every single answer solely on what YOU CAN SEE in this 
   specific screenshot — never on a hypothetical default build.
3. Reference EXACT button labels, tab names, field names, and menu paths as they appear 
   in the image. Quote them with bold formatting.
4. If the relevant UI element is not visible in the screenshot, say exactly: 
   "I cannot see [X] in this view. Based on what IS visible, try [Y]."
5. Lead with the answer. Physicians are busy. No preamble.
6. Use Epic terminology when you can confirm it from the image 
   (SmartPhrase, SmartText, InBasket, BestPractice Advisory, Haiku, NoteWriter, Dot Phrases, etc.)
7. Instructions → numbered steps. UI element names → bold.
8. If the screenshot is blurry or too dark to read, say so and ask for a retake.
9. No disclaimers. No hedging beyond what is genuinely necessary.`,

  cerner: `You are EHRLens, an AI assistant helping healthcare professionals navigate Cerner (Oracle Health) EHR.
A physician has photographed their Cerner screen and needs help.

CRITICAL RULES:
1. ANALYZE ONLY WHAT IS DIRECTLY VISIBLE in the screenshot.
2. Cerner is heavily customized per institution. Never assume a standard build.
3. Reference exact UI elements visible in the screenshot with bold formatting.
4. Lead with the answer. Numbered steps for instructions.
5. Use Cerner terminology when visible (PowerChart, FirstNet, PharmNet, ClinicalEvent, etc.)
6. If elements are not visible, say so explicitly.`,

  general: `You are EHRLens, an AI assistant helping healthcare professionals navigate complex medical software.
A physician has photographed their screen and needs help.

CRITICAL RULES:
1. ANALYZE ONLY WHAT IS DIRECTLY VISIBLE in the screenshot.
2. Enterprise medical software varies enormously by institution and version.
3. Reference exact visible button labels and tab names with bold formatting.
4. Lead with the answer. Numbered steps for instructions.
5. If you cannot answer from the visible screenshot, say so clearly.`,

  other: `You are EHRLens, an AI assistant helping healthcare professionals navigate medical and clinical software.
Analyze what is visible in the screenshot and answer the question clearly and concisely.
Lead with the answer. Bold key UI element names. Numbered steps for instructions.`,
};

// ── Rate Limiting (40 req/IP/hour via KV) ────────────────────
async function checkRateLimit(env, ip) {
  if (!env.RATE_LIMIT) return { allowed: true, remaining: 999 };
  const key = `rl:${ip}:${Math.floor(Date.now() / 3600000)}`;
  const current = parseInt((await env.RATE_LIMIT.get(key)) || '0', 10);
  if (current >= 40) return { allowed: false, remaining: 0 };
  await env.RATE_LIMIT.put(key, String(current + 1), { expirationTtl: 7200 });
  return { allowed: true, remaining: 40 - current - 1 };
}

// ── CORS ──────────────────────────────────────────────────────
function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResp(data, status = 200, origin = '*') {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

// ── Main ──────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || 'null';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== 'POST') {
      return jsonResp({ error: 'Method not allowed' }, 405, origin);
    }

    const url = new URL(request.url);
    if (!url.pathname.endsWith('/api/analyze')) {
      return jsonResp({ error: 'Not found' }, 404, origin);
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const { allowed, remaining } = await checkRateLimit(env, ip);
    if (!allowed) {
      return jsonResp({ error: 'Rate limit reached. Please wait before your next query.' }, 429, origin);
    }

    let body;
    try { body = await request.json(); }
    catch { return jsonResp({ error: 'Invalid JSON' }, 400, origin); }

    const { image_base64, question, mode = 'general', history = [] } = body;
    if (!image_base64) return jsonResp({ error: 'image_base64 required' }, 400, origin);
    if (!env.GEMINI_API_KEY) return jsonResp({ error: 'API key not configured' }, 500, origin);

    const systemPrompt = SYSTEM_PROMPTS[mode] || SYSTEM_PROMPTS.general;
    const interactionsUrl = `https://generativelanguage.googleapis.com/v1beta/interactions`;

    const inputItems = [];
    for (const h of history.slice(-8)) {
      inputItems.push({ type: 'text', text: `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.content}` });
    }
    inputItems.push({
      type: 'image',
      data: image_base64,
      mime_type: 'image/jpeg',
    });
    inputItems.push({
      type: 'text',
      text: question || 'Describe what you see on this screen and explain how to navigate it.',
    });

    let geminiResp;
    try {
      geminiResp = await fetch(interactionsUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': env.GEMINI_API_KEY,
        },
        body: JSON.stringify({
          model: GEMINI_MODEL,
          system_instruction: systemPrompt,
          input: inputItems,
        }),
      });
    } catch (err) {
      return jsonResp({ error: `Gemini unreachable: ${err.message}` }, 502, origin);
    }

    if (!geminiResp.ok) {
      const errText = await geminiResp.text();
      return jsonResp({ error: `Gemini API error ${geminiResp.status}: ${errText}` }, 502, origin);
    }

    const data = await geminiResp.json();
    let answer = null;
    if (Array.isArray(data?.steps)) {
      for (const step of data.steps) {
        if (step.type === 'model_output' && Array.isArray(step.content)) {
          for (const part of step.content) {
            if (part.type === 'text' && part.text) {
              answer = part.text;
              break;
            }
          }
        }
      }
    }
    if (!answer && data?.output_text) answer = data.output_text;
    if (!answer) return jsonResp({ error: 'No response from AI. Please try again.' }, 502, origin);

    return jsonResp({ answer, mode, remaining_queries: remaining }, 200, origin);
  },
};
