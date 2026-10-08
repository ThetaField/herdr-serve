import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

export function inspectTailscale(run = execFileSync) {
  let version;
  try { version = run('tailscale', ['version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim().split('\n')[0]; }
  catch (error) { return { installed: error.code !== 'ENOENT', ready: false, message: error.code === 'ENOENT' ? 'Tailscale is not installed/on PATH.' : `Cannot run Tailscale: ${error.message}` }; }
  try {
    const state = JSON.parse(run('tailscale', ['status', '--json'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }));
    return { installed: true, ready: state.BackendState === 'Running', message: `Tailscale ${version} · ${state.BackendState || 'unknown'} · ${state.Self?.DNSName || 'no hostname'}` };
  } catch { return { installed: true, ready: false, message: `Tailscale ${version} installed; daemon or login needs attention.` }; }
}
export function runInteractive(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} did not complete (${result.signal || result.status}). See the output above and retry when ready.`);
}
export async function installTailscale({ platform = process.platform, tty = !!process.stdin.isTTY && !!process.stdout.isTTY, fetcher = fetch, run = runInteractive } = {}) {
  if (!tty) throw new Error('Installation requires an interactive terminal. Open the Tailscale setup pane.');
  if (platform !== 'linux') throw new Error('On macOS, install the official app from https://tailscale.com/download/mac and sign in there. Then return to this wizard.');
  const response = await fetcher('https://tailscale.com/install.sh', { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Installer download failed: HTTP ${response.status}`);
  const script = await response.text();
  if (!script.startsWith('#!/bin/sh') || Buffer.byteLength(script) > 1024 * 1024) throw new Error('Unexpected installer response; nothing executed.');
  const dir = await mkdtemp(join(tmpdir(), 'herdr-tailscale-'));
  try {
    const file = join(dir, 'install.sh');
    await writeFile(file, script, { mode: 0o600, flag: 'wx' });
    console.log('Running the official Tailscale installer. Enter your sudo password only in this terminal if prompted.');
    await run('sh', [file]);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
export function setupCommand(action, platform = process.platform, username = userInfo().username) {
  if (action === 'l') return platform === 'linux' ? ['sudo', ['tailscale', 'up']] : ['tailscale', ['up']];
  if (platform !== 'linux') throw new Error('Use the Tailscale macOS app to start the service and manage permissions.');
  if (action === 's') return ['sudo', ['systemctl', 'enable', '--now', 'tailscaled']];
  if (action === 'o') return ['sudo', ['tailscale', 'set', `--operator=${username}`]];
  throw new Error('Unknown setup action');
}
async function ask() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question('> ')).trim().toLowerCase(); }
  finally { rl.close(); process.stdin.pause(); }
}
export async function setupWizard(enableFunnel) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Open an interactive setup pane: herdr plugin action invoke herdr.serve.setup');
  while (true) {
    console.log('\nTAILSCALE SETUP\n' + inspectTailscale().message);
    console.log('Choose a step; the wizard never installs or publishes automatically.');
    console.log('[i] Install using https://tailscale.com/install.sh (Linux; may require sudo)');
    console.log('[s] Start daemon and enable at boot (systemd Linux)');
    console.log('[l] Log in — open the URL shown by Tailscale in your browser');
    console.log('[o] Allow this OS user to manage Tailscale (Linux operator permission)');
    console.log('[f] Enable PUBLIC Funnel with Herdr Serve token login');
    console.log('[r] Check again  [q] Close setup');
    const action = await ask();
    if (action === 'q') return;
    try {
      if (action === 'i') {
        if (inspectTailscale().installed) console.log('Tailscale is already installed. Use your package manager to update it.');
        else await installTailscale();
      } else if (['s', 'l', 'o'].includes(action)) {
        const [command, args] = setupCommand(action);
        runInteractive(command, args);
      } else if (action === 'f') {
        if (!inspectTailscale().ready) throw new Error('Start Tailscale and finish login first.');
        const info = await enableFunnel();
        console.log(`Public URL: ${info.funnel}\nSign in with your existing Herdr Serve token.`);
      }
    } catch (error) { console.error(error.message); }
  }
}
