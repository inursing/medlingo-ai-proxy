/**
 * MedLingo — Advanced Practice AI backend (separate from the progress backend)
 *
 * A STANDALONE Apps Script project. It powers only the "Advanced Practice · 進階學習"
 * section of the page (Ask the Tutor + Chart Reader). If it is off, broken or out of
 * credit, the rest of MedLingo (study, quizzes, progress saving) is not affected.
 *
 * Claude is called through the MedLingo AI proxy (Cloudflare Worker "medlingo-ai-proxy", repo inursing/medlingo-ai-proxy), which uses
 * the official Anthropic SDK and reads ANTHROPIC_API_KEY from its environment variables.
 * This project only needs two Script properties (Project Settings → Script properties):
 *   PROXY_URL      the Worker URL, https://medlingo-ai-proxy.nursingsmiley.workers.dev
 *   PROXY_SECRET   the same long random string set as the PROXY_SECRET secret on the Worker
 *
 * It reads the "Usage" sheet of your MedLingo spreadsheet (to check student ID + name)
 * and writes two tabs there: "AI Log" (every question / answer) and nothing else.
 *
 * After editing: Deploy → Manage deployments → (pencil) → Version: New version → Deploy.
 */

// ── 1. Settings ──────────────────────────────────────────────────────────────
const MODE = 'students';        // 'off' = nobody · 'teacher' = teachers only · 'students' = teachers + students with a student ID
const DAILY_LIMIT = 30;        // AI uses per student per day (teachers: unlimited)
const MODEL = 'claude-sonnet-5-5';
const CLIENT_ID = '159350431685-s7095o51b6o2dvfmci9obo28v67iai65.apps.googleusercontent.com';
const TEACHERS = ['a103262003@gmail.com'];
const SHEET_ID = '102pv4vb0rmB8YzZQcbH6RC9m-vJhS4nv4q56Z9WIx8Y';   // the MedLingo 學生紀錄 spreadsheet
const LOG_NAME = 'AI Log';
const TZ = 'Asia/Taipei';

// ── 2. Entry points ──────────────────────────────────────────────────────────
function doGet() { return ContentService.createTextOutput('MedLingo AI is running.'); }

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false, error: 'bad_request' }); }
  const who = verify_(req.token);
  if (!who) return out_({ ok: false, error: 'auth' });
  const teacher = TEACHERS.map(s => s.toLowerCase()).indexOf(who.email) >= 0;

  let student = null;
  if (!teacher) {
    if (MODE !== 'students') return out_({ ok: true, enabled: false });
    student = profile_(who.email);
    if (!student) return out_({ ok: true, enabled: false, reason: 'no_profile' });
  }
  const used = teacher ? 0 : usedToday_(who.email);
  const base = { ok: true, enabled: MODE !== 'off', teacher: teacher, limit: teacher ? 0 : DAILY_LIMIT, used: used };
  if (MODE === 'off') return out_({ ok: true, enabled: false });

  if (req.action === 'hello') return out_(base);
  if (req.action === 'log') {
    if (!teacher) return out_({ ok: false, error: 'forbidden' });
    return out_({ ok: true, rows: readLog_(Number(req.limit) || 300) });
  }
  if (['ask', 'chart', 'explain'].indexOf(req.action) < 0) return out_({ ok: false, error: 'unknown_action' });
  const P = PropertiesService.getScriptProperties();
  if (!P.getProperty('PROXY_URL') || !P.getProperty('PROXY_SECRET')) return out_({ ok: false, error: 'no_key' });
  if (!teacher && used >= DAILY_LIMIT) return out_({ ok: false, error: 'limit', limit: DAILY_LIMIT, used: used });

  let res;
  try {
    if (req.action === 'ask') res = ask_(req);
    else if (req.action === 'chart') res = chart_(req);
    else res = explain_(req);
  } catch (err) {
    return out_({ ok: false, error: 'ai_error', detail: String(err && err.message || err).slice(0, 300) });
  }
  if (!res.ok) return out_(res);
  const nowUsed = teacher ? 0 : bump_(who.email);
  log_(who, student, teacher, req.action, res.logIn || '', res.logOut || '');
  delete res.logIn; delete res.logOut;
  res.used = nowUsed; res.limit = teacher ? 0 : DAILY_LIMIT;
  return out_(res);
}

// ── 3. Features ──────────────────────────────────────────────────────────────
const BILINGUAL = 'Write bilingually: for each short paragraph or bullet, give the English first, then on the next line the Traditional Chinese (Taiwan) translation. ' +
  'Plain text only: no markdown headings, no tables, no bold; use "- " for bullets.';

function ask_(req) {
  const msgs = (Array.isArray(req.messages) ? req.messages : []).slice(-8)
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map(m => ({ role: m.role, content: m.content.slice(0, 1500) }));
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return { ok: false, error: 'bad_request' };
  const q = msgs[msgs.length - 1].content;
  if (q.length > 600) return { ok: false, error: 'too_long' };
  const card = req.card && typeof req.card === 'object' ? req.card : null;
  let system = 'You are "MedLingo Tutor", a friendly, precise tutor in a Taiwanese university nursing EMI course on medical English terminology ' +
    '(word parts, clinical vocabulary, abbreviations, chart language, specialties). ' +
    'Only help with medical/nursing English: meanings, differences between similar terms, word-part analysis, pronunciation tips, abbreviations, clinical usage and example sentences, memory tips. ' +
    'If a question is unrelated to this, or asks you to do homework/exam answers or give personal medical advice, politely decline in one short bilingual line and suggest a related question. ' +
    'Be medically accurate; if a term is rare, outdated or you are unsure, say so. Do not invent word parts or etymologies. ' +
    'Keep it short: at most about 120 English words (plus the Chinese). ' + BILINGUAL;
  if (card && card.term) {
    system += '\n\nThe student opened this from a vocabulary card: ' + JSON.stringify({
      term: String(card.term).slice(0, 120), abbr: String(card.abbr || '').slice(0, 30), zh: String(card.zh || '').slice(0, 80),
      meaning: String(card.meaning || '').slice(0, 300), unit: String(card.unit || '').slice(0, 80), section: String(card.section || '').slice(0, 80)
    }) + '. Questions like "this word" refer to it.';
  }
  const text = claude_(system, msgs, 700);
  return { ok: true, answer: text, logIn: (card && card.term ? '[' + card.term + '] ' : '') + q, logOut: text };
}

function chart_(req) {
  const abbrs = (Array.isArray(req.abbrs) ? req.abbrs : []).slice(0, 220)
    .map(a => ({ a: String(a.a || '').slice(0, 24), t: String(a.t || '').slice(0, 90) })).filter(a => a.a && a.t);
  if (abbrs.length < 5) return { ok: false, error: 'bad_request' };
  const level = ['easy', 'medium', 'hard'].indexOf(req.level) >= 0 ? req.level : 'medium';
  const n = { easy: '3', medium: '5 to 6', hard: '8 to 10' }[level];
  const form = { easy: 'ONE short line of a nursing note', medium: 'a short nursing progress note of 2–3 lines', hard: 'a realistic progress note of 4–6 lines (e.g. S/O/A/P or a handover)' }[level];
  const topic = String(req.topic || 'general ward').slice(0, 80);
  const avoid = (Array.isArray(req.avoid) ? req.avoid : []).slice(0, 30).map(String).join(', ');
  const system = 'You write short, realistic, fictional English clinical chart notes for nursing students to practise reading abbreviations. ' +
    'STRICT RULES: use ONLY abbreviations from the provided list, copied exactly (same capitals, dots and slashes). ' +
    'Everything else must be written in full words — no other abbreviations or acronyms at all. Numbers with these units are allowed: mg, mL, kg, cm, mmHg, °C, bpm, %. ' +
    'Use "Pt." for patient only if it is in the list; otherwise write "patient". The case must be medically coherent and plausible. No real names; use bed numbers. ' +
    'Reply with JSON only, no other text: {"note":"...","used":["ABBR1","ABBR2",...]} where "used" lists every abbreviation that appears in the note.';
  const user = 'Specialty / setting: ' + topic + '\nLength: ' + form + '\nUse ' + n + ' different abbreviations from this list:\n' +
    abbrs.map(a => a.a + ' = ' + a.t).join('\n') + (avoid ? '\n\nTry not to reuse these (used recently): ' + avoid : '');
  const raw = claude_(system, [{ role: 'user', content: user }], 600);
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { ok: false, error: 'ai_format' };
  let j; try { j = JSON.parse(m[0]); } catch (err) { return { ok: false, error: 'ai_format' }; }
  if (!j.note || !Array.isArray(j.used)) return { ok: false, error: 'ai_format' };
  return { ok: true, note: String(j.note), abbrs: j.used.map(String), logIn: topic + ' · ' + level, logOut: String(j.note) };
}

function explain_(req) {
  const note = String(req.note || '').slice(0, 1500);
  const key = (Array.isArray(req.key) ? req.key : []).slice(0, 20).map(k => String(k.a) + ' = ' + String(k.t) + (k.zh ? ' (' + k.zh + ')' : '')).join('\n');
  if (!note) return { ok: false, error: 'bad_request' };
  const system = 'You explain English clinical chart notes to Taiwanese nursing students. ' + BILINGUAL +
    ' Structure: 1) "Full version / 完整寫法": the note rewritten with every abbreviation spelled out. ' +
    '2) "What is happening / 病人狀況": 2–4 short bullets explaining the patient situation in plain language. ' +
    '3) "Nursing point / 護理重點": 1–2 bullets on what a nurse should watch or do. Be medically accurate and concise.';
  const text = claude_(system, [{ role: 'user', content: 'Chart note:\n' + note + '\n\nAbbreviation key (from the course):\n' + key }], 900);
  return { ok: true, answer: text, logIn: note, logOut: text };
}

// ── 4. Claude API ────────────────────────────────────────────────────────────
function claude_(system, messages, maxTokens) {
  // Claude is called through the MedLingo AI proxy (Cloudflare Worker), which uses the official
  // Anthropic SDK and reads ANTHROPIC_API_KEY from its own environment variables.
  // Script properties: PROXY_URL (https://...workers.dev) and PROXY_SECRET (same value as on the Worker).
  const props = PropertiesService.getScriptProperties();
  const url = props.getProperty('PROXY_URL'), secret = props.getProperty('PROXY_SECRET');
  if (!url || !secret) throw new Error('proxy_not_configured');
  const res = UrlFetchApp.fetch(url.replace(/\/+$/, '') + '/messages', {
    method: 'post', contentType: 'application/json', headers: { 'x-proxy-secret': secret }, muteHttpExceptions: true,
    payload: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system: system, messages: messages })
  });
  const code = res.getResponseCode(), body = res.getContentText();
  if (code !== 200) throw new Error('proxy ' + code + ': ' + body.slice(0, 200));
  const j = JSON.parse(body);
  if (!j.ok) throw new Error('proxy: ' + (j.detail || j.error));
  return j.text;
}

// ── 5. Sign-in check, student ID, usage, log ─────────────────────────────────
function verify_(token) {
  if (!token) return null;
  const cache = CacheService.getScriptCache();
  const key = 'a' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token)).slice(0, 40);
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return null;
  const p = JSON.parse(res.getContentText());
  if (p.aud !== CLIENT_ID || String(p.email_verified) !== 'true' || Number(p.exp) * 1000 < Date.now()) return null;
  const who = { email: String(p.email).toLowerCase(), name: p.name || '' };
  cache.put(key, JSON.stringify(who), Math.max(60, Math.min(3000, Math.floor(Number(p.exp) - Date.now() / 1000 - 60))));
  return who;
}

function ss_() { return SpreadsheetApp.openById(SHEET_ID); }

function profile_(email) {   // student ID + name from the "Usage" sheet; null if not linked
  const cache = CacheService.getScriptCache(), ck = 'p' + email;
  const hit = cache.get(ck);
  if (hit) return JSON.parse(hit);
  const sh = ss_().getSheetByName('Usage');
  if (!sh || sh.getLastRow() < 2) return null;
  const f = sh.getRange(2, 1, sh.getLastRow() - 1, 1).createTextFinder(email).matchEntireCell(true).findNext();
  if (!f) return null;
  const v = sh.getRange(f.getRow(), 1, 1, 3).getValues()[0];
  const sid = String(v[1] || '').trim(), name = String(v[2] || '').trim();
  if (!sid) return null;
  const p = { sid: sid, name: name };
  cache.put(ck, JSON.stringify(p), 600);
  return p;
}

function today_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
function usedToday_(email) {
  const raw = PropertiesService.getScriptProperties().getProperty('count_' + today_());
  const m = raw ? JSON.parse(raw) : {};
  return m[email] || 0;
}
function bump_(email) {
  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    const props = PropertiesService.getScriptProperties(), k = 'count_' + today_();
    const m = JSON.parse(props.getProperty(k) || '{}');
    m[email] = (m[email] || 0) + 1;
    props.setProperty(k, JSON.stringify(m));
    props.getKeys().forEach(x => { if (x.indexOf('count_') === 0 && x !== k) props.deleteProperty(x); });
    return m[email];
  } finally { lock.releaseLock(); }
}

function logSheet_() {
  const ss = ss_();
  let sh = ss.getSheetByName(LOG_NAME);
  if (!sh) {
    sh = ss.insertSheet(LOG_NAME);
    sh.getRange(1, 1, 1, 8).setValues([['Time', 'Email', 'Student ID', 'Name', 'Role', 'Feature', 'Question / input', 'AI answer / output']]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}
function log_(who, student, teacher, action, input, output) {
  const feature = { ask: 'Ask the Tutor', chart: 'Chart Reader · new note', explain: 'Chart Reader · AI explanation' }[action] || action;
  const row = [Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'), who.email, student ? student.sid : '', student ? student.name : who.name,
    teacher ? 'Teacher' : 'Student', feature, String(input).slice(0, 5000), String(output).slice(0, 5000)];
  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  try { logSheet_().appendRow(row); } finally { lock.releaseLock(); }
}
function readLog_(limit) {
  const sh = logSheet_(), n = sh.getLastRow() - 1;
  if (n < 1) return [];
  const k = Math.min(n, Math.max(1, Math.min(limit, 1000)));
  return sh.getRange(sh.getLastRow() - k + 1, 1, k, 8).getValues().reverse()
    .map(r => ({ time: String(r[0]), email: r[1], sid: String(r[2]), name: String(r[3]), role: r[4], feature: r[5], input: String(r[6]), output: String(r[7]) }));
}

function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

// ── 6. Test (run from the editor: select testProxy → Run, then check the Execution log) ──
function testProxy() {
  const t = Date.now();
  const text = claude_('Reply in one short line.', [{ role: 'user', content: 'Say "MedLingo proxy OK" and the model you are.' }], 50);
  Logger.log('Proxy reply (' + (Date.now() - t) + ' ms): ' + text);
}
