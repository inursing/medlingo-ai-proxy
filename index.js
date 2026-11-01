// MedLingo AI proxy — Cloudflare Worker.
// Calls Claude with the official Anthropic SDK. Only the "MedLingo AI" Apps Script calls it.
// Secrets / variables (set in Cloudflare → Worker → Settings → Variables and Secrets, never in code):
//   ANTHROPIC_API_KEY  (Secret)  your Claude API key
//   PROXY_SECRET       (Secret)  long random string; the same value goes in the Apps Script property PROXY_SECRET
//   CLAUDE_MODEL       (Text, optional) default claude-sonnet-5-5; claude-opus-5-5 for harder reasoning
import Anthropic from '@anthropic-ai/sdk';

const DEFAULT_MODEL = 'claude-sonnet-5-5';
const ALLOWED_MODELS = new Set(['claude-sonnet-5-5', 'claude-opus-5-5']);
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

function secretOk(given, expected) {
  if (!expected || typeof given !== 'string' || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const model = env.CLAUDE_MODEL || DEFAULT_MODEL;
    if (request.method === 'GET' && url.pathname === '/') {
      return json({ ok: true, service: 'medlingo-ai-proxy', model, sdk: '@anthropic-ai/sdk', configured: !!(env.ANTHROPIC_API_KEY && env.PROXY_SECRET) });
    }
    if (request.method !== 'POST' || url.pathname !== '/messages') return json({ ok: false, error: 'not_found' }, 404);
    if (!secretOk(request.headers.get('x-proxy-secret'), env.PROXY_SECRET)) return json({ ok: false, error: 'unauthorized' }, 401);
    if (!env.ANTHROPIC_API_KEY) return json({ ok: false, error: 'no_key' }, 500);
    const raw = await request.text();
    if (raw.length > 64 * 1024) return json({ ok: false, error: 'too_large' }, 413);
    let body;
    try { body = JSON.parse(raw); } catch (e) { return json({ ok: false, error: 'bad_request' }, 400); }
    const { system, messages, max_tokens } = body;
    if (!Array.isArray(messages) || !messages.length) return json({ ok: false, error: 'bad_request' }, 400);
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    try {
      const msg = await client.messages.create({
        model: ALLOWED_MODELS.has(body.model) ? body.model : model,
        max_tokens: Math.min(Math.max(Number(max_tokens) || 700, 50), 2000),
        ...(typeof system === 'string' ? { system } : {}),
        messages: messages.slice(-12).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 8000) })),
      });
      const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
      return json({ ok: true, text, model: msg.model, usage: msg.usage });
    } catch (err) {
      console.error('Claude API error', err && err.status, err && err.message);
      return json({ ok: false, error: 'api_error', status: err && err.status || 500, detail: String(err && err.message || err).slice(0, 300) }, 502);
    }
  },
};
