# medlingo-ai-proxy

Cloudflare Worker that calls Claude with the official Anthropic SDK (`@anthropic-ai/sdk`) for MedLingo **Advanced Practice · 進階學習**.
Only the "MedLingo AI" Google Apps Script calls it, using a shared secret header (`x-proxy-secret`).

## Secrets / variables (Cloudflare → Worker → Settings → Variables and Secrets)
| Name | Type | Value |
|---|---|---|
| `ANTHROPIC_API_KEY` | Secret | Claude API key (from platform.claude.com) |
| `PROXY_SECRET` | Secret | long random string — same value as the Apps Script property `PROXY_SECRET` |
| `CLAUDE_MODEL` | Text (optional) | default `claude-sonnet-5-5`; `claude-opus-5-5` for harder reasoning |

No key is written in the code.

## Build / deploy
- Source: `index.js`. `worker.min.js` is the bundled file (SDK included) pasted into the Cloudflare dashboard editor.
- Rebuild: `npm install && npx esbuild index.js --bundle --minify --format=esm --platform=browser --conditions=workerd,worker,browser --target=es2022 --outfile=worker.min.js`
- Or deploy with Wrangler: `npx wrangler deploy` (then `npx wrangler secret put ANTHROPIC_API_KEY` and `PROXY_SECRET`).

## API
- `GET /` → health check `{ ok, model, configured }`
- `POST /messages` with header `x-proxy-secret` and body `{ system, messages, max_tokens, model? }` → `{ ok, text, model, usage }`
