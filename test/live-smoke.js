// Opt-in integration check; never attaches to the user's default session.
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { WebSocket } from 'ws';
import { createServer } from '../src/server.js';

export async function liveSmoke() {
  const session = `serve-test-${randomUUID().slice(0, 8)}`;
  const token = randomUUID();
  const origin = 'http://127.0.0.1:7681';
  const app = createServer({ token, origin, session });
  let ws;
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('HERDR_')) delete env[key];
  try {
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const response = await fetch(base + '/api/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
    const cookie = response.headers.get('set-cookie').split(';')[0];
    ws = new WebSocket(base.replace('http:', 'ws:') + '/terminal', { origin, headers: { cookie } });
    await once(ws, 'open');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Herdr produced no terminal output')), 15_000);
      ws.on('message', raw => {
        const msg = JSON.parse(raw);
        if (msg.type === 'output' && msg.data.includes('\x1b[')) { clearTimeout(timer); resolve(); }
        if (msg.type === 'error') { clearTimeout(timer); reject(new Error(msg.message)); }
      });
      ws.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
    });
    const closed = once(ws, 'close'); ws.close(); await closed;
    const status = execFileSync('herdr', ['--session', session, 'status', 'server'], { env, encoding: 'utf8' });
    if (!status.includes('status: running')) throw new Error('Herdr server did not survive browser disconnect');
    console.log('Live Herdr smoke passed: ANSI frames received; server survives browser disconnect.');
  } finally {
    ws?.terminate(); await app.close();
    try { execFileSync('herdr', ['--session', session, 'server', 'stop'], { env, stdio: 'pipe', timeout: 5000 }); } catch {}
    try { execFileSync('herdr', ['session', 'delete', session], { env, stdio: 'pipe', timeout: 5000 }); } catch {}
  }
}
if (process.env.HERDR_SERVE_LIVE_TEST === '1') await liveSmoke();
