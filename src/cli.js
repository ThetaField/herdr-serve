#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createServer } from './server.js';
import { listenControl } from './control.js';
import { startCloudflare } from './cloudflare-process.js';

if (process.argv.includes('--help')) {
  console.log(`herdr-serve — browser access to Herdr

npm run build && npm start

Environment:
  HERDR_SERVE_HOST          Bind address (127.0.0.1)
  HERDR_SERVE_PORT          Port (7681)
  HERDR_SERVE_ORIGIN        Exact browser origin, e.g. https://herdr.example.com
  HERDR_SERVE_TOKEN         Access token, minimum 32 characters
  HERDR_SERVE_TOKEN_FILE    Token file (default ~/.config/herdr-serve/token)
  HERDR_SERVE_SESSION_FILE  Remembered-device store (default ~/.config/herdr-serve/sessions.json)
  HERDR_SERVE_SESSION       Named Herdr session (default session if omitted)
  HERDR_SERVE_BINARY        Herdr executable (herdr)

Use an HTTPS reverse proxy or private VPN for access away from this machine.`);
  process.exit(0);
}
const host = process.env.HERDR_SERVE_HOST || '127.0.0.1';
const port = Number(process.env.HERDR_SERVE_PORT || 7681);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
const origin = process.env.HERDR_SERVE_ORIGIN || `http://127.0.0.1:${port}`;
let token = process.env.HERDR_SERVE_TOKEN;
if (!token) {
  const file = process.env.HERDR_SERVE_TOKEN_FILE || join(homedir(), '.config/herdr-serve/token');
  try { token = (await readFile(file, 'utf8')).trim(); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(join(file, '..'), { recursive: true, mode: 0o700 });
    token = randomBytes(32).toString('base64url');
    await writeFile(file, `${token}\n`, { mode: 0o600, flag: 'wx' });
  }
  console.log(`Access token file: ${file}`);
}
const app = createServer({ token, origin, sessionFile: process.env.HERDR_SERVE_SESSION_FILE || join(homedir(), '.config/herdr-serve/sessions.json'), session: process.env.HERDR_SERVE_SESSION, binary: process.env.HERDR_SERVE_BINARY || 'herdr' });
app.server.on('error', error => { console.error(error.message); process.exit(1); });
let closeControl, cloudflare;
let stopping = false;
const startedAt = new Date().toISOString();
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await cloudflare?.stop();
  await app.close();
  await closeControl?.();
  process.exit(0);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown);
app.server.listen(port, host, async () => {
  try {
    if (process.env.HERDR_SERVE_CF_ACTIVE === '1') {
      cloudflare = await startCloudflare({ binary: process.env.HERDR_SERVE_CLOUDFLARED_BINARY || 'cloudflared', tokenFile: process.env.HERDR_SERVE_CLOUDFLARE_TOKEN_FILE });
      await new Promise(resolve => setTimeout(resolve, 400));
      if (!cloudflare.status().running) throw new Error('cloudflared exited during startup. Inspect serve.log.');
    }
    if (process.env.HERDR_SERVE_CONTROL_PATH) {
      closeControl = await listenControl(process.env.HERDR_SERVE_CONTROL_PATH, () => ({
        pid: process.pid, origin, host, port, session: process.env.HERDR_SERVE_SESSION || 'default',
        startedAt, cloudflare: cloudflare?.status(),
      }), shutdown);
    }
    console.log(`Herdr Serve listening on ${host}:${port}\nBrowser URL: ${origin}`);
    process.send?.({ ready: true });
    if (process.connected) process.disconnect();
  } catch (error) { console.error(error.message); await cloudflare?.stop(); await app.close(); process.exit(1); }
});
