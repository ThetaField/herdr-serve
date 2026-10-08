import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { funnelManager, readFunnel } from '../plugin/funnel.js';

async function fixture(t, settings = {}) {
  const state = await mkdtemp(join(tmpdir(), 'hs-funnel-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const p = { state };
  const calls = [];
  const data = { routes: {}, service: { origin: 'http://127.0.0.1:7681', host: '127.0.0.1', port: 7681 }, fail: false, starts: 0, stops: 0, backend: 'Running' };
  const route = () => ({ TCP: { 443: { HTTPS: true } }, Web: { 'host.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:7681' } } } }, AllowFunnel: { 'host.example.ts.net:443': true } });
  const run = async args => {
    calls.push(args);
    if (args[0] === 'status') return JSON.stringify({ BackendState: data.backend, Self: { DNSName: 'host.example.ts.net.' } });
    if (args[1] === 'status') return JSON.stringify(data.routes);
    if (args.at(-1) === 'off') { data.routes = {}; return ''; }
    if (data.fail) { if (data.partial) data.routes = route(); throw new Error('Funnel authorization denied'); }
    const port = Number(args[2].split('=')[1]);
    data.routes = { TCP: { [port]: { HTTPS: true } }, Web: { [`host.example.ts.net:${port}`]: { Handlers: { '/': { Proxy: args.at(-1) } } } }, AllowFunnel: { [`host.example.ts.net:${port}`]: true } };
    return 'enabled';
  };
  const services = {
    config: async () => settings,
    status: async () => data.service,
    stop: async () => { data.stops++; data.service = null; },
    start: async () => {
      data.starts++;
      if (data.failStart) throw new Error('port busy');
      const saved = await readFunnel(p);
      data.service = { origin: saved?.origin || 'http://127.0.0.1:7681', host: '127.0.0.1', port: Number(settings.HERDR_SERVE_PORT || 7681) };
      return data.service;
    },
  };
  return { manager: funnelManager(p, services, run), data, calls, p, route };
}

test('enable synchronizes public origin, keeps ownership, and is idempotent', async t => {
  const f = await fixture(t);
  assert.equal((await f.manager.enable()).funnel, 'https://host.example.ts.net');
  assert.equal(f.data.service.origin, 'https://host.example.ts.net');
  assert.equal((await f.manager.status()).enabled, true);
  assert.equal((await readFunnel(f.p)).target, 'http://127.0.0.1:7681');
  await f.manager.enable();
  assert.equal(f.calls.filter(args => args[1] === '--bg' && args.at(-1) !== 'off').length, 1);
});

test('disable revokes only owned route and restores local settings', async t => {
  const f = await fixture(t); await f.manager.enable();
  await f.manager.disable();
  assert.deepEqual(f.data.routes, {});
  assert.equal(f.data.service.origin, 'http://127.0.0.1:7681');
  assert.equal(await readFunnel(f.p), null);
  assert.ok(f.calls.some(args => args.join(' ') === 'funnel --bg --https=443 off'));
  assert.ok(!f.calls.some(args => args.includes('reset')));
});

test('existing private Serve and foreground routes are never published or overwritten', async t => {
  for (const foreground of [false, true]) {
    const f = await fixture(t);
    const existing = f.route(); delete existing.AllowFunnel;
    f.data.routes = foreground ? { Foreground: { session: existing } } : existing;
    await assert.rejects(f.manager.enable(), /already used/);
    assert.equal(f.data.stops, 0);
    assert.equal(await readFunnel(f.p), null);
    assert.ok(!f.calls.some(args => args[1] === '--bg'));
  }
});

test('external changes prevent deleting another route', async t => {
  const f = await fixture(t); await f.manager.enable();
  f.data.routes.Web['host.example.ts.net:443'].Handlers['/other'] = { Text: 'another app' };
  await assert.rejects(f.manager.disable(), /changed outside/);
  assert.equal(f.data.service.origin, 'https://host.example.ts.net');
  assert.ok(await readFunnel(f.p));
});

test('authorization failure rolls back local configuration, including partial route creation', async t => {
  for (const partial of [false, true]) {
    const f = await fixture(t); f.data.fail = true; f.data.partial = partial;
    await assert.rejects(f.manager.enable(), /authorization denied/);
    assert.equal(f.data.service.origin, 'http://127.0.0.1:7681');
    assert.deepEqual(f.data.routes, {});
    assert.equal(await readFunnel(f.p), null);
  }
});

test('logged-out Tailscale fails before changing the service', async t => {
  const f = await fixture(t); f.data.backend = 'NeedsLogin';
  await assert.rejects(f.manager.enable(), /not ready/);
  assert.equal(f.data.stops, 0);
});

test('alternate public port is included in origin and commands', async t => {
  const f = await fixture(t, { HERDR_SERVE_FUNNEL_PORT: '8443' });
  assert.equal((await f.manager.enable()).funnel, 'https://host.example.ts.net:8443');
  assert.ok(f.calls.some(args => args.includes('--https=8443')));
});

test('stopping disables Funnel without restarting the local service', async t => {
  const f = await fixture(t); await f.manager.enable();
  await f.manager.disable(false);
  assert.equal(f.data.service, null);
  assert.equal(await readFunnel(f.p), null);
});

test('retry will not silently change a saved target', async t => {
  const settings = {};
  const f = await fixture(t, settings); await f.manager.enable();
  settings.HERDR_SERVE_PORT = '7777';
  await assert.rejects(f.manager.enable(), /changed/);
  assert.equal((await readFunnel(f.p)).target, 'http://127.0.0.1:7681');
});
