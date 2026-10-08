import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths, prepare, start, stop, status, cloudflare, funnel } from '../plugin/manage.js';
import { readCloudflare, validateCloudflare } from '../plugin/cloudflare.js';

async function fixture(t, fail = false) {
  const dir = await mkdtemp(join(tmpdir(), 'hs-cf-'));
  const p = paths({ HERDR_PLUGIN_CONFIG_DIR: join(dir, 'config'), HERDR_PLUGIN_STATE_DIR: join(dir, 'state') });
  await prepare(p);
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const binary = join(dir, 'cloudflared'), tokenFile = join(dir, 'cf-token'), capture = join(dir, 'child.json');
  await writeFile(tokenFile, 'not-a-real-cloudflare-token', { mode: 0o600 });
  await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('cloudflared version 2026.1.0'); process.exit(0); }
if (${fail}) process.exit(1);
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({args:process.argv.slice(2),pid:process.pid}));
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  const config = `HERDR_SERVE_PORT=${port}\nHERDR_SERVE_ORIGIN=http://127.0.0.1:${port}\nHERDR_SERVE_TOKEN_FILE=${join(dir, 'token')}\nHERDR_SERVE_SESSION_FILE=${join(dir, 'sessions.json')}\nHERDR_SERVE_CLOUDFLARE_ORIGIN=https://herdr.example.com\nHERDR_SERVE_CLOUDFLARE_TOKEN_FILE=${tokenFile}\nHERDR_SERVE_CLOUDFLARED_BINARY=${binary}\n`;
  await writeFile(p.configFile, config);
  t.after(async () => { await stop(p); await rm(dir, { recursive: true, force: true }); });
  return { p, dir, port, config, tokenFile, binary, capture };
}

test('named Tunnel starts owned connector, uses HTTPS cookies, and stops its child on disable', async t => {
  const { p, dir, config, port, tokenFile, capture } = await fixture(t);
  await start(p);
  const cf = cloudflare(p);
  const info = await cf.enable();
  assert.equal(info.origin, 'https://herdr.example.com');
  assert.equal(info.host, '127.0.0.1'); assert.equal(info.cloudflare.running, true);
  assert.equal((await cf.status()).enabled, true);
  assert.equal((await cf.enable()).pid, info.pid);
  const child = JSON.parse(await readFile(capture, 'utf8'));
  assert.deepEqual(child.args.slice(-3), ['run', '--token-file', tokenFile]);
  assert.ok(!JSON.stringify(child.args).includes('not-a-real-cloudflare-token'));
  assert.equal(await readFile(p.configFile, 'utf8'), config);
  const token = (await readFile(join(dir, 'token'), 'utf8')).trim();
  const response = await fetch(`http://127.0.0.1:${port}/api/login`, { method: 'POST', headers: { origin: info.origin, 'content-type': 'application/json' }, body: JSON.stringify({token}) });
  assert.equal(response.status, 200); assert.match(response.headers.get('set-cookie'), /Secure/);
  await cf.disable();
  assert.equal((await status(p)).origin, `http://127.0.0.1:${port}`);
  assert.equal(await readCloudflare(p), null);
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
});

test('failed connector launch rolls back existing local service', async t => {
  const { p, port } = await fixture(t, true); await start(p);
  await assert.rejects(cloudflare(p).enable(), /Start failed/);
  assert.equal(await readCloudflare(p), null);
  assert.equal((await status(p)).origin, `http://127.0.0.1:${port}`);
});

test('Cloudflare selection prevents Funnel actions before contacting Tailscale', async t => {
  const { p } = await fixture(t); await cloudflare(p).enable();
  await assert.rejects(funnel(p, () => assert.fail('must not call Tailscale')).enable(), /Cloudflare is selected/);
});

test('Funnel selection prevents Cloudflare start', async t => {
  const { p } = await fixture(t);
  const path = join(p.state, 'funnel.json');
  await writeFile(path, JSON.stringify({version:1,port:443,origin:'https://host.example.ts.net',hostPort:'host.example.ts.net:443',target:'http://127.0.0.1:7681'}));
  try { await assert.rejects(cloudflare(p).enable(), /Funnel is selected/); assert.equal(await status(p), null); }
  finally { await rm(path); }
});

test('private credentials and required origin are validated before replacing a service', async t => {
  const { p, tokenFile } = await fixture(t); const previous = await start(p);
  await chmod(tokenFile, 0o644);
  await assert.rejects(cloudflare(p).enable(), /chmod 600/);
  assert.equal((await status(p)).pid, previous.pid);
  assert.throws(() => validateCloudflare({version:1,origin:'http://example.com',port:7681,tokenFile,binary:'cloudflared'}), /Invalid Cloudflare/);
});

test('normal Stop stops the owned Cloudflare connector without restarting the bridge', async t => {
  const { p, capture } = await fixture(t); await cloudflare(p).enable();
  const { pid } = JSON.parse(await readFile(capture, 'utf8'));
  await stop(p);
  assert.equal(await status(p), null); assert.equal(await readCloudflare(p), null);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
