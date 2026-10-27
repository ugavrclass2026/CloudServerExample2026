// One small server for a VR class project, running on a Google Cloud VM:
//   - your web files (put them in public/), served over HTTPS by Caddy in front of this
//   - /room: a shared room over WebSocket; every message one client sends goes to all the others
//   - /api/chat: Gemini on your Google Cloud credits. The VM's own service account signs the calls,
//     so there is no API key anywhere: not in your app, not in this file, not in git.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { GoogleGenAI } from '@google/genai';

const PORT = Number(process.env.PORT || 8080);
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT;          // set by setup.sh from the VM's metadata
const MODEL = process.env.MODEL || 'gemini-3.5-flash';
const PUBLIC = path.resolve('public');
const DEFAULT_PERSONA = 'You are a friendly guide inside a VR app. Answer in one or two short spoken sentences. ' +
  'No lists, no markdown, no emoji.';

let ai = null;                                             // made on the first chat, so the rest works without it
function gemini() {
  if (!PROJECT) throw Object.assign(new Error('GOOGLE_CLOUD_PROJECT is not set: run ./setup.sh'), { status: 500 });
  return ai ??= new GoogleGenAI({ vertexai: true, project: PROJECT, location: 'global' });
}

// ---------- /api/chat: one conversation per session id, kept in memory ----------
const sessions = new Map();                                // id -> { persona, history, used }
const MAX_TURNS = 20;                                      // older turns are dropped (and not paid for)

async function chat({ message, session, persona, json }) {
  if (typeof message !== 'string' || !message.trim()) throw Object.assign(new Error('send a "message"'), { status: 400 });
  if (message.length > 4000) throw Object.assign(new Error('message too long (4000 characters max)'), { status: 400 });
  let id = typeof session === 'string' && sessions.has(session) ? session : crypto.randomUUID();
  if (!sessions.has(id)) sessions.set(id, { persona: persona || DEFAULT_PERSONA, history: [] });
  const s = sessions.get(id);
  s.used = Date.now();
  s.history.push({ role: 'user', parts: [{ text: message }] });
  const response = await gemini().models.generateContent({
    model: MODEL,
    contents: s.history.slice(-2 * MAX_TURNS),
    config: {
      systemInstruction: s.persona,
      maxOutputTokens: 1024,
      ...(json ? { responseMimeType: 'application/json' } : {}),
    },
  });
  const reply = response.text ?? '';
  s.history.push({ role: 'model', parts: [{ text: reply }] });
  if (s.history.length > 4 * MAX_TURNS) s.history.splice(0, s.history.length - 2 * MAX_TURNS);
  return { reply, session: id };
}
setInterval(() => {                                        // forget conversations idle for an hour
  for (const [id, s] of sessions) if (Date.now() - s.used > 3600e3) sessions.delete(id);
}, 600e3);

// anyone who finds your address can call /api/chat on your credits: allow 20 requests a minute per address
const hits = new Map();
function tooMany(ip) {
  const now = Date.now(), recent = (hits.get(ip) || []).filter(t => now - t < 60e3);
  recent.push(now); hits.set(ip, recent);
  return recent.length > 20;
}

// ---------- HTTP ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json', '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.mp4': 'video/mp4' };

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (req.method === 'OPTIONS') return send(res, 204, '');
  if (url.pathname === '/api/health') return send(res, 200, { ok: true, project: PROJECT || null, model: MODEL });
  if (url.pathname === '/api/chat' && req.method === 'POST') {
    if (tooMany(ip)) return send(res, 429, { error: 'too many requests: wait a minute' });
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 64e3) return send(res, 413, { error: 'request too large' }); }
    try {
      const out = await chat(JSON.parse(body || '{}'));
      console.log(`[chat] ${ip} ${out.session.slice(0, 8)}: ${out.reply.slice(0, 80).replace(/\s+/g, ' ')}`);
      return send(res, 200, out);
    } catch (e) {
      console.error('[chat] error:', e.message);
      return send(res, e.status || 500, { error: e.message });
    }
  }
  // static files from public/
  let file = path.join(PUBLIC, decodeURIComponent(url.pathname));
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'forbidden', 'text/plain');
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'not found', 'text/plain');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ---------- /room: a shared room ----------
const wss = new WebSocketServer({ server, path: '/room', maxPayload: 16 * 1024 });
const COLORS = ['#f3a712', '#2bc8e8', '#ff6f91', '#a3e635', '#c879ff', '#e4572e', '#4ade80', '#fbbf24'];   // bright on dark
let next = 0;
wss.on('connection', ws => {
  ws.id = (++next).toString(36);
  ws.color = COLORS[next % COLORS.length];
  ws.send(JSON.stringify({ type: 'welcome', id: ws.id, color: ws.color, others: wss.clients.size - 1 }));
  ws.on('message', data => {
    let msg; try { msg = JSON.parse(data); } catch { return; }
    const out = JSON.stringify({ ...msg, from: ws.id, color: ws.color });
    for (const c of wss.clients) if (c !== ws && c.readyState === 1) c.send(out);
  });
  ws.on('close', () => {
    const out = JSON.stringify({ type: 'left', from: ws.id });
    for (const c of wss.clients) if (c.readyState === 1) c.send(out);
  });
});

server.listen(PORT, '127.0.0.1', () =>
  console.log(`VR server on 127.0.0.1:${PORT} (behind Caddy) · project ${PROJECT || '(not set)'} · model ${MODEL}`));
