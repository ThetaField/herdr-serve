import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths, prepare, start, stop, status, funnel } from '../plugin/manage.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'hs-plugin-'));
  const p = paths({ HERDR_PLUGIN_CONFIG_DIR: join(dir, 'config'), HERDR_PLUGIN_STATE_DIR: join(dir, 'state') });
  await prepare(p);
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const config = `HERDR_SERVE_PORT=${port}\nHERDR_SERVE_ORIGIN=http://127.0.0.1:${port}\nHERDR_SERVE_TOKEN_FILE=${join(dir, 'token')}\nHERDR_SERVE_SESSION_FILE=${join(dir, 'sessions.json')}\nHERDR_SERVE_SESSION=plugin-test\n`;
  await writeFile(p.configFile, config);
  t.after(async () => { await stop(p); await rm(dir, { recursive: true, force: true }); });
  return { p, port, config };
}

test('managed service starts, retains config and token, prevents duplicate starts, and stops cleanly', async t => {
  const { p, port, config } = await fixture(t);
  await prepare(p); assert.equal(await readFile(p.configFile, 'utf8'), config);
  assert.equal(await status(p), null);
  const first = await start(p);
  assert.equal(first.port, port); assert.equal(first.session, 'plugin-test');
  const token = await readFile(join(p.config, '../token'), 'utf8');
  assert.equal((await fetch(first.origin)).status, 200);
  const second = await start(p);
  assert.equal(first.pid, second.pid); assert.equal(second.alreadyRunning, true);
  assert.equal((await stop(p)).stopped, true);
  assert.equal(await status(p), null);
  assert.equal((await stop(p)).alreadyStopped, true);
  await start(p);
  assert.equal(await readFile(join(p.config, '../token'), 'utf8'), token);
});

test('port collision does not stop an independently running service', async t => {
  const { p, port } = await fixture(t);
  const unrelated = net.createServer(socket => socket.end('unrelated'));
  unrelated.listen(port, '127.0.0.1'); await once(unrelated, 'listening');
  t.after(() => new Promise(resolve => unrelated.close(resolve)));
  await assert.rejects(start(p), /Start failed/);
  assert.equal(await status(p), null);
  await stop(p);
  assert.equal(unrelated.listening, true);
});

test('concurrent start actions launch at most one service', async t => {
  const { p } = await fixture(t);
  const results = await Promise.allSettled([start(p), start(p)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(results.find(result => result.status === 'rejected').reason.message, /operation is in progress/);
  assert.ok(await status(p));
});

test('unknown management endpoint is never stopped or replaced', async t => {
  const { p } = await fixture(t);
  const other = net.createServer(socket => { socket.once('data', () => socket.end('{"service":"other"}\n')); });
  other.listen(p.socket); await once(other, 'listening');
  try {
    await assert.rejects(start(p), /unknown service/);
    await assert.rejects(stop(p), /unknown service/);
    assert.equal(other.listening, true);
  } finally { await new Promise(resolve => other.close(resolve)); }
});


test('Funnel integration restarts real bridge with HTTPS origin and restores it on disable', async t => {
  const { p, port, config } = await fixture(t);
  let routes = {};
  const publicOrigin = 'https://test.example.ts.net';
  const run = async args => {
    if (args[0] === 'status') return JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'test.example.ts.net.' } });
    if (args[1] === 'status') return JSON.stringify(routes);
    if (args.at(-1) === 'off') { routes = {}; return ''; }
    routes = { TCP: { 443: { HTTPS: true } }, Web: { 'test.example.ts.net:443': { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } } }, AllowFunnel: { 'test.example.ts.net:443': true } };
    return '';
  };
  await start(p);
  const manager = funnel(p, run);
  try {
    await manager.enable();
    assert.equal((await status(p)).origin, publicOrigin);
    assert.equal(await readFile(p.configFile, 'utf8'), config);
    const token = (await readFile(join(p.config, '../token'), 'utf8')).trim();
    const response = await fetch(`http://127.0.0.1:${port}/api/login`, { method: 'POST', headers: { origin: publicOrigin, 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie'), /__Host-herdr=.*Secure/);
  } finally { await manager.disable(); }
  assert.equal((await status(p)).origin, `http://127.0.0.1:${port}`);
  assert.deepEqual(routes, {});
});
