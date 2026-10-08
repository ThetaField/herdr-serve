import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { inspectTailscale, installTailscale, setupCommand } from '../plugin/setup.js';

test('setup distinguishes missing CLI, daemon failure and successful login', () => {
  assert.equal(inspectTailscale(() => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }).installed, false);
  assert.equal(inspectTailscale((cmd, args) => { if (args[0] === 'version') return '1.90.0\n'; throw new Error('daemon'); }).installed, true);
  assert.equal(inspectTailscale((cmd, args) => args[0] === 'version' ? '1.90.0\n' : '{"BackendState":"Running","Self":{"DNSName":"host.ts.net"}}').ready, true);
});
test('installer requires a terminal and Linux before downloading anything', async () => {
  const fetcher = () => { throw new Error('must not download'); };
  await assert.rejects(installTailscale({ tty: false, fetcher }), /interactive/);
  await assert.rejects(installTailscale({ tty: true, platform: 'darwin', fetcher }), /macOS/);
});
test('installer only executes a complete successful script and removes temporary files', async () => {
  let installedFile;
  await installTailscale({ tty: true, platform: 'linux', fetcher: async url => {
    assert.equal(url, 'https://tailscale.com/install.sh');
    return { ok: true, text: async () => '#!/bin/sh\nexit 0\n' };
  }, run: async (cmd, args) => {
    assert.equal(cmd, 'sh'); installedFile = args[0];
    assert.equal(await readFile(installedFile, 'utf8'), '#!/bin/sh\nexit 0\n');
    assert.equal((await stat(installedFile)).mode & 0o777, 0o600);
  } });
  await assert.rejects(stat(installedFile), { code: 'ENOENT' });
  for (const response of [{ ok: false, status: 503 }, { ok: true, text: async () => '<html>error</html>' }]) {
    await assert.rejects(installTailscale({ tty: true, platform: 'linux', fetcher: async () => response, run: () => assert.fail('must not execute') }));
  }
});
test('operator uses actual OS username as a single argument, without shell expansion', () => {
  assert.deepEqual(setupCommand('o', 'linux', 'test-user'), ['sudo', ['tailscale', 'set', '--operator=test-user']]);
  assert.deepEqual(setupCommand('s', 'linux'), ['sudo', ['systemctl', 'enable', '--now', 'tailscaled']]);
  assert.deepEqual(setupCommand('l', 'linux'), ['sudo', ['tailscale', 'up']]);
});
