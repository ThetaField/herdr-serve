import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPanel } from '../plugin/panel.js';

async function navigate(keys, overrides = {}) {
  const calls = [], output = [];
  const provider = id => ({ title: id, status: async () => `${id} status`, ...Object.fromEntries(['setup','enable','disable'].map(action => [action, async () => calls.push(`${id}.${action}`)])), ...overrides[id] });
  await runPanel({ summary: overrides.summary || (async () => {}), providers: { cloudflare: provider('cloudflare'), tailscale: provider('tailscale') }, service: { start: async () => calls.push('service.start'), stop: async () => calls.push('service.stop') }, ask: async () => { assert.ok(keys.length, 'unexpected extra prompt'); return keys.shift(); }, print: message => output.push(message) });
  assert.equal(keys.length, 0);
  return { calls, output };
}
test('choosing providers and going back never enables a tunnel', async () => {
  const result = await navigate(['1','b','2','b','q']);
  assert.deepEqual(result.calls, []);
  assert.ok(!result.output[0].includes('Enable'));
});
test('setup returns to provider menu and operations target only the selected provider', async () => {
  const result = await navigate(['1','s','e','d','b','2','s','e','d','q']);
  assert.deepEqual(result.calls, ['cloudflare.setup','cloudflare.enable','cloudflare.disable','tailscale.setup','tailscale.enable','tailscale.disable']);
});
test('dependency errors leave setup and back navigation available', async () => {
  const result = await navigate(['2','s','b','q'], { tailscale: { status: async () => { throw new Error('Not installed'); } } });
  assert.deepEqual(result.calls, ['tailscale.setup']);
  assert.ok(result.output.includes('Not installed'));
});
test('failed enable stays in provider submenu; service controls remain separately accessible', async () => {
  const result = await navigate(['1','e','b','3','s','x','b','q'], { cloudflare: { enable: async () => { throw new Error('Configure first'); } } });
  assert.ok(result.output.includes('Error: Configure first'));
  assert.deepEqual(result.calls, ['service.start','service.stop']);
});
test('unreadable service state leaves navigation and close available', async () => {
  const result = await navigate(['3','b','q'], { summary: async () => { throw new Error('Cannot read state'); } });
  assert.deepEqual(result.calls, []);
  assert.equal(result.output.filter(line => line === 'Error: Cannot read state').length, 3);
});
