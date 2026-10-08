#!/usr/bin/env node
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, copyFile, unlink, rmdir, chmod, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { runPanel } from './panel.js';
import { cloudflareSetupWizard } from './cloudflare-setup.js';
import { funnelManager, readFunnel } from './funnel.js';
import { setupWizard } from './setup.js';
import { cloudflareManager, readCloudflare, cloudflareGuide } from './cloudflare.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const allowed = new Set(['HERDR_SERVE_CLOUDFLARE_ORIGIN', 'HERDR_SERVE_CLOUDFLARE_TOKEN_FILE', 'HERDR_SERVE_CLOUDFLARED_BINARY', 'HERDR_SERVE_FUNNEL_PORT', 'HERDR_SERVE_HOST', 'HERDR_SERVE_PORT', 'HERDR_SERVE_ORIGIN', 'HERDR_SERVE_TOKEN', 'HERDR_SERVE_TOKEN_FILE', 'HERDR_SERVE_SESSION_FILE', 'HERDR_SERVE_SESSION', 'HERDR_SERVE_BINARY']);
export function paths(env = process.env) {
  const config = env.HERDR_PLUGIN_CONFIG_DIR || join(homedir(), '.config/herdr-serve/plugin');
  const state = env.HERDR_PLUGIN_STATE_DIR || join(homedir(), '.local/state/herdr-serve');
  return { config, state, configFile: join(config, 'server.env'), socket: join(state, 'serve.sock'), lock: join(state, 'operation.lock'), log: join(state, 'serve.log') };
}
export async function prepare(p) {
  await mkdir(p.config, { recursive: true, mode: 0o700 });
  await mkdir(p.state, { recursive: true, mode: 0o700 });
  await chmod(p.state, 0o700);
  const legacy = join(homedir(), '.config/herdr-serve/server.env');
  try { await copyFile(legacy, p.configFile, constants.COPYFILE_EXCL); await chmod(p.configFile, 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') return;
    if (error.code !== 'ENOENT') throw error;
    try {
      await writeFile(p.configFile, '# Edit then stop/start the plugin to apply. No shell expansion.\n# Existing token and remembered devices are reused from ~/.config/herdr-serve/.\nHERDR_SERVE_HOST=127.0.0.1\nHERDR_SERVE_PORT=7681\nHERDR_SERVE_ORIGIN=http://127.0.0.1:7681\n# HERDR_SERVE_SESSION=work\n', { flag: 'wx', mode: 0o600 });
    } catch (err) { if (err.code !== 'EEXIST') throw err; }
  }
}
export function request(p, command = 'status') {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(p.socket);
    let data = '';
    socket.setTimeout(2000, () => socket.destroy(new Error('Management socket timed out; refusing to replace it.')));
    socket.on('connect', () => socket.write(command + '\n'));
    socket.on('data', chunk => { data += chunk; if (data.length > 8192) socket.destroy(new Error('Invalid management response')); });
    socket.on('error', reject);
    socket.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid management response')); } });
  });
}
export async function status(p) {
  try {
    const info = await request(p);
    if (info.service !== 'herdr-serve') throw new Error('Socket belongs to an unknown service; refusing to manage it.');
    return info;
  } catch (error) {
    if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) return null;
    throw error;
  }
}
async function locked(p, action) {
  try { await mkdir(p.lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Another management operation is in progress. If a previous action crashed, verify it has exited, then remove the empty lock directory: ${p.lock}`);
    throw error;
  }
  try { return await action(); } finally { await rmdir(p.lock); }
}
async function startService(p) {
    const existing = await status(p);
    if (existing) return { ...existing, alreadyRunning: true };
    try { await unlink(p.socket); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (Buffer.byteLength(p.socket) > 100) throw new Error('Plugin state path is too long for a Unix socket. Use a shorter HERDR_PLUGIN_STATE_DIR.');
    const config = await readConfig(p);
    const funnel = await readFunnel(p);
    const cloudflare = await readCloudflare(p);
    if (funnel && cloudflare) throw new Error('Both tunnel providers are selected; disable one before starting.');
    if (cloudflare) Object.assign(config, { HERDR_SERVE_HOST: '127.0.0.1', HERDR_SERVE_ORIGIN: cloudflare.origin, HERDR_SERVE_PORT: String(cloudflare.port), HERDR_SERVE_CF_ACTIVE: '1', HERDR_SERVE_CLOUDFLARE_TOKEN_FILE: cloudflare.tokenFile, HERDR_SERVE_CLOUDFLARED_BINARY: cloudflare.binary });
    if (funnel) Object.assign(config, { HERDR_SERVE_HOST: '127.0.0.1', HERDR_SERVE_ORIGIN: funnel.origin, HERDR_SERVE_PORT: new URL(funnel.target).port });
    const env = { ...process.env };
    const binary = env.HERDR_BIN_PATH || 'herdr';
    for (const key of Object.keys(env)) if (key.startsWith('HERDR_') && key !== 'HERDR_CONFIG_PATH') delete env[key];
    Object.assign(env, { HERDR_SERVE_BINARY: binary }, config, { HERDR_SERVE_CONTROL_PATH: p.socket });
    delete env.CLOUDFLARE_API_TOKEN;
    // Keep existing standalone token and session files unless explicitly configured.
    await readFile(join(root, 'public/app.js'));
    const log = await open(p.log, 'a', 0o600);
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [join(root, 'src/cli.js')], { cwd: root, env, detached: true, stdio: ['ignore', log.fd, log.fd, 'ipc'] });
        let settled = false;
        const finish = error => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          if (child.connected) child.disconnect();
          if (error) { child.kill('SIGTERM'); reject(error); }
          else { child.unref(); resolve(); }
        };
        const timer = setTimeout(() => finish(new Error(`Start timed out. See ${p.log}`)), 10_000);
        child.on('error', error => finish(error));
        child.on('exit', code => finish(new Error(`Start failed (${code}). Check ${p.log}; an existing standalone service may own the port.`)));
        child.on('message', message => { if (message.ready) finish(); });
      });
    } finally { await log.close(); }
    return status(p);
}
async function stopService(p) {
    if (!await status(p)) return { stopped: true, alreadyStopped: true };
    await request(p, 'stop');
    for (let attempt = 0; attempt < 50; attempt++) {
      try { if (!await status(p)) return { stopped: true }; }
      catch (error) { if (error.code !== 'ECONNRESET') throw error; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Service is still shutting down; no process was force-killed.');
}
async function readConfig(p) {
  const config = parseEnv(await readFile(p.configFile, 'utf8'));
  for (const key of Object.keys(config)) if (!allowed.has(key)) throw new Error(`Unknown config setting: ${key}`);
  return config;
}
export function funnel(p, run) {
  return funnelManager(p, { exclusive: async () => { if (await readCloudflare(p)) throw new Error('Cloudflare is selected. Run cloudflare-off before enabling Funnel.'); }, config: () => readConfig(p), status: () => status(p), start: () => startService(p), stop: () => stopService(p) }, run);
}
export function cloudflare(p, preflight) {
  return cloudflareManager(p, { config: () => readConfig(p), status: () => status(p), start: () => startService(p), stop: () => stopService(p) }, preflight);
}
export async function start(p) {
  return locked(p, async () => await readCloudflare(p) ? cloudflare(p).enable() : await readFunnel(p) ? funnel(p).enable() : startService(p));
}
export async function stop(p) {
  return locked(p, async () => { await cloudflare(p).disable(false); await funnel(p).disable(false); return stopService(p); });
}
async function funnelStatus(p) {
  try { return (await funnel(p).status()).message; } catch (error) { return `Funnel: ${error.message}`; }
}
async function cloudflareStatus(p) {
  try { return (await cloudflare(p).status()).message; } catch (error) { return `Cloudflare: ${error.message}`; }
}
function display(p, info) {
  console.log(info ? `Running · ${info.origin}\nSession: ${info.session}\nStarted: ${info.startedAt}` : 'Plugin-managed service: stopped');
  console.log(`Config: ${p.configFile}\nLog: ${p.log}\nExisting standalone/systemd services are managed separately.`);
}
async function ui(p) {
  const enableFunnel = () => locked(p, () => funnel(p).enable());
  await runPanel({
    summary: async () => {
      display(p, await status(p));
      const selected = await readCloudflare(p) ? 'Cloudflare Tunnel' : await readFunnel(p) ? 'Tailscale Funnel' : 'None (local / external proxy)';
      console.log(`Configured public provider: ${selected}`);
    },
    providers: {
      cloudflare: {
        title: 'CLOUDFLARE TUNNEL',
        status: () => cloudflareStatus(p),
        setup: () => cloudflareSetupWizard(p, action => locked(p, action)),
        enable: async () => { display(p, await locked(p, () => cloudflare(p).enable())); },
        disable: async () => { console.log((await locked(p, () => cloudflare(p).disable())).message); },
      },
      tailscale: {
        title: 'TAILSCALE FUNNEL',
        status: () => funnelStatus(p),
        setup: () => setupWizard(enableFunnel),
        enable: async () => { display(p, await enableFunnel()); },
        disable: async () => { console.log((await locked(p, () => funnel(p).disable())).message); },
      },
    },
    service: {
      start: async () => { display(p, await start(p)); },
      stop: async () => { console.log(JSON.stringify(await stop(p))); },
    },
  });
}
export async function main(command) {
  const p = paths(); await prepare(p);
  switch (command) {
    case 'start': display(p, await start(p)); break;
    case 'stop': console.log(JSON.stringify(await stop(p))); break;
    case 'status': display(p, await status(p)); console.log(await funnelStatus(p)); console.log(await cloudflareStatus(p)); break;
    case 'cloudflare-on': display(p, await locked(p, () => cloudflare(p).enable())); console.log(await cloudflareStatus(p)); break;
    case 'cloudflare-off': console.log((await locked(p, () => cloudflare(p).disable())).message); break;
    case 'cloudflare-status': console.log((await cloudflare(p).status()).message); break;
    case 'cloudflare-guide': console.log(cloudflareGuide(p)); break;
    case 'cloudflare-setup-ui': await cloudflareSetupWizard(p, action => locked(p, action)); break;
    case 'cloudflare-setup':
      execFileSync(process.env.HERDR_BIN_PATH || 'herdr', ['plugin', 'pane', 'open', '--plugin', 'herdr.serve', '--entrypoint', 'cloudflare-setup'], { stdio: 'inherit' }); break;
    case 'funnel-on': display(p, await locked(p, () => funnel(p).enable())); console.log('Public internet access enabled. Token login is required.'); break;
    case 'funnel-off': console.log((await locked(p, () => funnel(p).disable())).message); break;
    case 'funnel-status': console.log((await funnel(p).status()).message); break;
    case 'setup-ui': await setupWizard(() => locked(p, () => funnel(p).enable())); break;
    case 'setup':
      execFileSync(process.env.HERDR_BIN_PATH || 'herdr', ['plugin', 'pane', 'open', '--plugin', 'herdr.serve', '--entrypoint', 'setup'], { stdio: 'inherit' }); break;
    case 'ui': await ui(p); break;
    case 'panel':
      execFileSync(process.env.HERDR_BIN_PATH || 'herdr', ['plugin', 'pane', 'open', '--plugin', 'herdr.serve', '--entrypoint', 'control'], { stdio: 'inherit' }); break;
    default: throw new Error('Usage: node plugin/manage.js start|stop|status|panel|ui|setup|setup-ui|funnel-on|funnel-off|funnel-status|cloudflare-on|cloudflare-off|cloudflare-status|cloudflare-setup|cloudflare-setup-ui|cloudflare-guide');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
