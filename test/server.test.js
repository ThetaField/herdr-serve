import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createServer } from '../src/server.js';

const token = 'test-token-'.repeat(5);
const origin = 'http://127.0.0.1:7681';
async function setup(t, options = {}) {
  const terminals = [];
  const spawn = (binary, args, config) => {
    const term = { binary, args, config, written: '', killed: false, paused: false,
      onData(fn) { this.output = fn; }, onExit(fn) { this.exit = fn; },
      resize(cols, rows) { this.size = [cols, rows]; }, write(data) { this.written += data; },
      kill() { this.killed = true; }, pause() { this.paused = true; }, resume() { this.paused = false; } };
    terminals.push(term); return term;
  };
  const app = createServer({ token, origin, spawn, ...options });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (path, data, cookie, requestOrigin = origin) => fetch(base + path, { method: 'POST', headers: { origin: requestOrigin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(data) });
  async function login() { const res = await post('/api/login', { token }); assert.equal(res.status, 200); return res.headers.get('set-cookie').split(';')[0]; }
  async function connect(cookie) { const ws = new WebSocket(base.replace('http:', 'ws:') + '/terminal', { origin, headers: { cookie } }); await once(ws, 'open'); return ws; }
  return { ...app, base, post, login, connect, terminals };
}

test('requires authentication, rejects foreign origins, serves only known assets', async t => {
  const app = await setup(t);
  assert.equal((await fetch(app.base + '/api/session')).status, 401);
  assert.equal((await app.post('/api/login', { token: 'wrong' })).status, 401);
  assert.equal((await app.post('/api/login', { token }, null, 'https://evil.example')).status, 403);
  assert.equal((await app.post('/api/login', { token: 'a'.repeat(5000) })).status, 400);
  const response = await app.post('/api/login', { token });
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(app.base + '/api/session', { headers: { cookie } })).status, 200);
  assert.equal((await fetch(app.base + '/src/server.js')).status, 404);
  const page = await fetch(app.base + '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(app.terminals.length, 0);
});

test('rejects WebSocket connections without credentials or from a foreign origin', async t => {
  const app = await setup(t); const cookie = await app.login();
  for (const headers of [{ origin }, { origin: 'https://evil.example', cookie }]) {
    const ws = new WebSocket(app.base.replace('http:', 'ws:') + '/terminal', { headers });
    const error = await new Promise(resolve => ws.once('error', resolve));
    assert.match(error.message, /403/);
  }
  assert.equal(app.terminals.length, 0);
});

test('streams real protocol, resizes, forwards Unicode input, applies backpressure and detaches only its client', async t => {
  const app = await setup(t, { session: 'test-session' });
  const ws = await app.connect(await app.login());
  let received = once(ws, 'message'); ws.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
  assert.equal(JSON.parse((await received)[0]).type, 'ready');
  const term = app.terminals[0];
  assert.deepEqual(term.args, ['--session', 'test-session']);
  assert.equal(term.config.env.HERDR_SERVE_TOKEN, undefined);
  received = once(ws, 'message'); term.output('\x1b[32mhello 世界');
  assert.equal(JSON.parse((await received)[0]).data, '\x1b[32mhello 世界');
  ws.send(JSON.stringify({ type: 'input', data: '世界\r' }));
  ws.send(JSON.stringify({ type: 'resize', cols: 40, rows: 20 }));
  received = once(ws, 'message'); term.output('x'.repeat(300_000)); await received;
  assert.equal(term.paused, true);
  ws.send(JSON.stringify({ type: 'ack', bytes: 300_000 }));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(term.written, '世界\r'); assert.deepEqual(term.size, [40, 20]); assert.equal(term.paused, false);
  const closed = once(ws, 'close'); ws.close(); await closed;
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(term.killed, true);
});

test('logout revokes the cookie and connected terminals', async t => {
  const app = await setup(t); const cookie = await app.login(); const ws = await app.connect(cookie);
  const closed = once(ws, 'close');
  assert.equal((await app.post('/api/logout', {}, cookie)).status, 200);
  assert.equal((await closed)[0], 4001);
  assert.equal((await fetch(app.base + '/api/session', { headers: { cookie } })).status, 401);
});

test('expired sessions cannot send terminal input', async t => {
  const app = await setup(t, { sessionTTL: 80 }); const ws = await app.connect(await app.login());
  await new Promise(resolve => setTimeout(resolve, 100));
  const closed = once(ws, 'close'); ws.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
  assert.equal((await closed)[0], 4001); assert.equal(app.terminals.length, 0);
});

test('rejects malformed dimensions before launching a terminal', async t => {
  const app = await setup(t); const ws = await app.connect(await app.login());
  const closed = once(ws, 'close'); ws.send(JSON.stringify({ type: 'resize', cols: 99999, rows: 0 }));
  assert.equal((await closed)[0], 4000); assert.equal(app.terminals.length, 0);
});

test('limits login attempts and terminal connections', async t => {
  const app = await setup(t, { maxClients: 1 }); const cookie = await app.login();
  const ws = await app.connect(cookie);
  const second = new WebSocket(app.base.replace('http:', 'ws:') + '/terminal', { origin, headers: { cookie } });
  const error = await new Promise(resolve => second.once('error', resolve)); assert.match(error.message, /503/);
  for (let i = 0; i < 9; i++) await app.post('/api/login', { token: 'wrong' });
  assert.equal((await app.post('/api/login', { token })).status, 429); ws.close();
});

test('remembered login survives restart, logout persists, and token rotation invalidates it', async t => {
  const { mkdtemp, readFile, rm, stat } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'herdr-serve-auth-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sessionFile = join(dir, 'sessions.json');
  const first = await setup(t, { sessionFile });
  const response = await first.post('/api/login', { token, remember: true });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /Max-Age=2592000/);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const disk = await readFile(sessionFile, 'utf8');
  assert.ok(!disk.includes(cookie.split('=')[1]));
  assert.ok(!disk.includes(token));
  assert.equal((await stat(sessionFile)).mode & 0o777, 0o600);
  const temporaryCookie = await first.login();
  await first.close();
  const second = await setup(t, { sessionFile });
  const status = (app, value) => fetch(app.base + '/api/session', { headers: { cookie: value } });
  assert.equal((await status(second, cookie)).status, 200);
  assert.equal((await status(second, temporaryCookie)).status, 401);
  assert.equal((await second.post('/api/logout', {}, cookie)).status, 200);
  await second.close();
  const third = await setup(t, { sessionFile });
  assert.equal((await status(third, cookie)).status, 401);
  const renewed = await third.post('/api/login', { token, remember: true });
  const rotatedCookie = renewed.headers.get('set-cookie').split(';')[0];
  await third.close();
  const rotated = await setup(t, { sessionFile, token: 'replacement-'.repeat(4) });
  assert.equal((await status(rotated, rotatedCookie)).status, 401);
  await rotated.close();
  const restored = await setup(t, { sessionFile });
  assert.equal((await status(restored, rotatedCookie)).status, 401);
});

test('remembered sessions expire across restarts', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'herdr-serve-expiry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const options = { sessionFile: join(dir, 'sessions.json'), rememberTTL: 40 };
  const first = await setup(t, options);
  const res = await first.post('/api/login', { token, remember: true });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  await first.close();
  await new Promise(resolve => setTimeout(resolve, 60));
  const second = await setup(t, options);
  assert.equal((await fetch(second.base + '/api/session', { headers: { cookie } })).status, 401);
});
