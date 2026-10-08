import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import * as pty from 'node-pty';
import { Sessions, sessionKey } from './sessions.js';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
]);
const hash = value => createHash('sha256').update(value).digest();
const dimensions = (cols, rows) => Number.isInteger(cols) && cols >= 20 && cols <= 500 && Number.isInteger(rows) && rows >= 5 && rows <= 200;

export function createServer({ token, origin = 'http://127.0.0.1:7681', session, binary = 'herdr', cwd = process.cwd(), spawn = pty.spawn, sessionTTL = 12 * 60 * 60 * 1000, maxClients = 8, sessionFile, rememberTTL = 30 * 24 * 60 * 60 * 1000 } = {}) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('Access token must have at least 32 characters.');
  const parsedOrigin = new URL(origin);
  if (!['http:', 'https:'].includes(parsedOrigin.protocol) || parsedOrigin.origin !== origin) throw new Error('Origin must be an http(s) origin without a trailing slash or path.');
  const secure = parsedOrigin.protocol === 'https:';
  const sessions = new Sessions(token, sessionFile);
  const attempts = new Map();
  const connections = new Map();
  const cookieName = secure ? '__Host-herdr' : 'herdr';
  const cookie = (id, age) => `${cookieName}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${secure ? '; Secure' : ''}`;
  function auth(req) {
    const rawId = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    if (!rawId || !/^[a-f0-9]{64}$/.test(rawId)) return null;
    const id = sessionKey(rawId);
    const expires = sessions.get(id);
    if (!expires || expires <= Date.now()) return null;
    return id;
  }
  function revoke(id) {
    sessions.delete(id);
    for (const [ws, connection] of connections) if (connection.id === id) ws.close(4001, 'Sign in again');
  }
  async function body(req) {
    let data = '';
    for await (const chunk of req) {
      data += chunk;
      if (Buffer.byteLength(data) > 4096) throw new Error('Request too large');
    }
    return JSON.parse(data);
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    try {
      const path = new URL(req.url, origin).pathname;
      if (req.method === 'POST' && req.headers.origin !== origin) return json(403, {
        error: `Browser address does not match the server configuration. Open ${origin}, or set HERDR_SERVE_ORIGIN to your browser's exact origin and restart the server.`,
      });
      if (path === '/api/login' && req.method === 'POST') {
        const ip = req.socket.remoteAddress;
        let entry = attempts.get(ip);
        if (!entry || entry.until < Date.now()) { entry = { count: 0, until: Date.now() + 60_000 }; attempts.set(ip, entry); }
        if (++entry.count > 10) return json(429, { error: 'Too many attempts. Try again in a minute.' });
        const input = await body(req);
        if (typeof input.token !== 'string' || !timingSafeEqual(hash(input.token), hash(token))) return json(401, { error: 'Incorrect access token' });
        if (sessions.size >= 100) return json(503, { error: 'Too many active sign-ins' });
        const previous = auth(req);
        if (previous) revoke(previous);
        const id = randomBytes(32).toString('hex');
        const remember = input.remember === true;
        const ttl = remember ? rememberTTL : sessionTTL;
        sessions.create(sessionKey(id), Date.now() + ttl, remember);
        res.setHeader('Set-Cookie', cookie(id, Math.floor(ttl / 1000)));
        return json(200, { ok: true });
      }
      if (path === '/api/logout' && req.method === 'POST') {
        const id = auth(req);
        if (id) revoke(id);
        res.setHeader('Set-Cookie', cookie('', 0));
        return json(200, { ok: true });
      }
      if (path === '/api/session' && req.method === 'GET') return json(auth(req) ? 200 : 401, { authenticated: !!auth(req), session: session || 'default' });
      if (req.method === 'GET' && assets.has(path)) {
        const [file, type] = assets.get(path);
        const data = await readFile(new URL(`../public/${file}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': type });
        return res.end(data);
      }
      json(404, { error: 'Not found' });
    } catch { if (!res.headersSent) json(400, { error: 'Invalid request or missing assets. Run npm run build.' }); else res.end(); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    const id = auth(req);
    if (req.url !== '/terminal' || req.headers.origin !== origin || !id) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    if (connections.size >= maxClients) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, id));
  });
  wss.on('connection', (ws, id) => {
    let terminal, pending = 0, paused = false;
    const state = { id, alive: true };
    connections.set(ws, state);
    const send = value => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); };
    const startTimer = setTimeout(() => ws.close(4000, 'Missing terminal size'), 10_000);
    ws.on('pong', () => { state.alive = true; });
    ws.on('error', () => {});
    ws.on('message', (raw, isBinary) => {
      if (!sessions.has(id) || sessions.get(id) <= Date.now()) { ws.close(4001, 'Sign in again'); return; }
      try {
        if (isBinary) throw new Error('Expected JSON');
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'resize' && dimensions(msg.cols, msg.rows)) {
          if (terminal) terminal.resize(msg.cols, msg.rows);
          else {
            clearTimeout(startTimer);
            // Never forward an enclosing pane's identity to a new Herdr client.
            const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
            for (const key of Object.keys(env)) if (key.startsWith('HERDR_') && key !== 'HERDR_CONFIG_PATH') delete env[key];
            terminal = spawn(binary, session ? ['--session', session] : [], { name: 'xterm-256color', cols: msg.cols, rows: msg.rows, cwd, env });
            terminal.onData(data => {
              pending += Buffer.byteLength(data);
              send({ type: 'output', data });
              if (pending > 256 * 1024 && !paused) { terminal.pause(); paused = true; }
              if (pending > 2 * 1024 * 1024) ws.close(4000, 'Client too slow');
            });
            terminal.onExit(({ exitCode }) => { send({ type: 'exit', code: exitCode }); ws.close(4002, 'Herdr client exited'); });
            send({ type: 'ready' });
          }
        } else if (msg.type === 'input' && terminal && typeof msg.data === 'string' && msg.data.length <= 32_768) terminal.write(msg.data);
        else if (msg.type === 'ack' && Number.isInteger(msg.bytes) && msg.bytes > 0 && msg.bytes <= pending) {
          pending -= msg.bytes;
          if (paused && pending < 64 * 1024) { terminal.resume(); paused = false; }
        } else throw new Error('Invalid message');
      } catch { send({ type: 'error', message: 'Unable to process terminal request. Check the Herdr installation and connection.' }); ws.close(4000, 'Terminal error'); }
    });
    ws.on('close', () => {
      clearTimeout(startTimer);
      connections.delete(ws);
      // Kill only this attached UI client; the persistent Herdr server owns agents.
      if (terminal) { try { terminal.kill(); } catch {} }
    });
  });
  const heartbeat = setInterval(() => {
    for (const [id, expiry] of sessions) if (expiry <= Date.now()) {
      try { revoke(id); } catch { console.error('Unable to prune expired session store'); }
    }
    for (const [ip, entry] of attempts) if (entry.until <= Date.now()) attempts.delete(ip);
    for (const [ws, state] of connections) {
      if (!state.alive) { ws.terminate(); continue; }
      state.alive = false; ws.ping();
    }
  }, 15_000);
  heartbeat.unref();
  server.on('close', () => clearInterval(heartbeat));
  return {
    server,
    async close() {
      clearInterval(heartbeat);
      for (const ws of connections.keys()) ws.terminate();
      wss.close();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
