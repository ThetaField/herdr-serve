import { execFile } from 'node:child_process';
import { promisify, parseEnv } from 'node:util';
import { readFile, writeFile, rename, unlink, stat, mkdtemp, rm } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { askLine } from './panel.js';
import { chooseDomain } from './cloudflare-domains.js';
import { apiTokenGuide } from './cloudflare-token-guide.js';
import { installCloudflared, checkSetupBinary } from './cloudflared-install.js';
export { checkSetupBinary } from './cloudflared-install.js';
import { cloudflareGuide, readCloudflare } from './cloudflare.js';
const exec = promisify(execFile);
const idPattern = /^[a-f0-9]{32}$/i;
const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

async function atomic(file, text) {
  const temp = file + '.' + randomUUID();
  try { await writeFile(temp, text, { mode: 0o600, flag: 'wx' }); await rename(temp, file); }
  finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
async function readJournal(p) {
  try { return JSON.parse(await readFile(join(p.config, 'cloudflare-deployment.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export function cloudflareAPI(token, fetcher = fetch) {
  if (!token || /\s/.test(token)) throw new Error('A Cloudflare API token is required.');
  return async (path, method = 'GET', body) => {
    let response;
    try { response = await fetcher('https://api.cloudflare.com/client/v4' + path, {
      method, redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }); } catch { throw new Error('Cloudflare API connection failed. Retry Setup to recover an interrupted deployment.'); }
    let data;
    try { data = await response.json(); } catch { throw new Error(`Cloudflare returned an invalid response (HTTP ${response.status}).`); }
    // Do not echo remote response bodies: they can contain credentials.
    if (!response.ok || !data.success) throw new Error(`Cloudflare API request failed (HTTP ${response.status}). Check account, zone and API token permissions; then retry Setup.`);
    return data.result;
  };
}
export async function loadAPIToken(file, env = process.env) {
  if (env.CLOUDFLARE_API_TOKEN) return env.CLOUDFLARE_API_TOKEN.trim();
  if (!isAbsolute(file || '')) throw new Error('Use an absolute API token file path, or set CLOUDFLARE_API_TOKEN.');
  const meta = await stat(file);
  if (!meta.isFile() || meta.size > 16384 || (meta.mode & 0o077)) throw new Error('API token file must be private (chmod 600).');
  return (await readFile(file, 'utf8')).trim();
}
export async function wranglerCreate(name, account, token, run = exec) {
  // Isolate from any Workers project config; use the exact account/token used by the API.
  const cwd = await mkdtemp(join(tmpdir(), 'herdr-wrangler-'));
  try {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('CLOUDFLARE_') || key.startsWith('CF_')) delete env[key];
    const options = { cwd, timeout: 60_000, maxBuffer: 1024 * 1024, env: { ...env,
      CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG: 'error', CI: 'true' } };
    await run('wrangler', ['tunnel', 'create', name], options);
  } catch { throw new Error('Wrangler tunnel creation failed. Install a Wrangler version supporting tunnel create and check API permissions. Retry Setup to recover any tunnel already created.'); }
  finally { await rm(cwd, { recursive: true, force: true }); }
}
export function validateDeployment(input) {
  const { account, zone, hostname, port, binary, method } = input;
  if (!idPattern.test(account) || !idPattern.test(zone)) throw new Error('Account ID and Zone ID must each contain 32 hexadecimal characters.');
  if (typeof hostname !== 'string' || hostname.length > 253 || !hostname.includes('.') || !hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new Error('Enter a DNS hostname, such as herdr.example.com, without https:// or a path.');
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !binary || /[\r\n'"`]/.test(binary) || !['api', 'wrangler'].includes(method)) throw new Error('Invalid port, cloudflared path or deployment method.');
  return input;
}

// Caller holds the plugin operation lock. Setup never starts a connector or service.
export async function deployCloudflare(p, input, { api, token, checkBinary = checkSetupBinary, createWithWrangler = wranglerCreate } = {}) {
  validateDeployment(input);
  if (await readCloudflare(p)) throw new Error('Disable the selected Cloudflare connector before changing its setup.');
  await checkBinary(input.binary);
  const original = await readFile(p.configFile, 'utf8');
  const journalFile = join(p.config, 'cloudflare-deployment.json');
  let journal = await readJournal(p);
  if (journal && (journal.version !== 1 || JSON.stringify({ ...journal.input, binary: input.binary }) !== JSON.stringify(input))) throw new Error(`An existing deployment uses different settings. Keep ${journalFile} for recovery; manage its resources in Cloudflare before setting up a different deployment.`);
  if (journal) journal.input = { ...input };
  const base = `/accounts/${input.account}/cfd_tunnel`;
  const dns = `/zones/${input.zone}/dns_records`;
  const zone = await api(`/zones/${input.zone}`);
  if (zone.account?.id !== input.account || zone.status !== 'active' || !input.hostname.endsWith('.' + zone.name) || input.hostname.slice(0, -(zone.name.length + 1)).includes('.')) throw new Error('Use a direct subdomain of an active zone in this account (e.g. herdr.example.com).');
  const records = await api(`${dns}?name=${encodeURIComponent(input.hostname)}&per_page=100`);
  if (!Array.isArray(records)) throw new Error('Unexpected DNS response.');
  if (records.length && (!journal?.tunnel || records.length !== 1 || records[0].type !== 'CNAME' || records[0].content !== `${journal.tunnel}.cfargotunnel.com` || records[0].proxied !== true)) throw new Error('This hostname already has DNS records. Nothing was overwritten; choose an unused hostname.');
  if (!journal) {
    journal = { version: 1, input, name: `herdr-serve-${randomUUID()}` };
    await atomic(journalFile, JSON.stringify(journal));
  }
  // A lost response may mean creation succeeded: recover by the journal's unique name.
  const matches = await api(`${base}?name=${encodeURIComponent(journal.name)}&is_deleted=false&per_page=100`);
  const exact = matches.filter(item => item.name === journal.name && !item.deleted_at);
  if (exact.length > 1) throw new Error('Multiple tunnels match deployment state. Inspect Cloudflare before retrying.');
  if (!exact.length) {
    if (journal.tunnel) throw new Error('Previously created tunnel is missing. Inspect Cloudflare and the deployment journal before retrying.');
    if (input.method === 'wrangler') {
      await createWithWrangler(journal.name, input.account, token);
      const created = await api(`${base}?name=${encodeURIComponent(journal.name)}&is_deleted=false&per_page=100`);
      exact.push(...created.filter(item => item.name === journal.name && !item.deleted_at));
    } else exact.push(await api(base, 'POST', { name: journal.name, config_src: 'cloudflare' }));
  }
  if (exact.length !== 1 || !uuidPattern.test(exact[0].id) || exact[0].remote_config !== true || (journal.tunnel && journal.tunnel !== exact[0].id)) throw new Error('Unexpected tunnel identity or management mode. No routing was changed.');
  journal.tunnel = exact[0].id;
  await atomic(journalFile, JSON.stringify(journal));
  const desired = { ingress: [{ hostname: input.hostname, service: `http://127.0.0.1:${input.port}` }, { service: 'http_status:404' }] };
  const current = await api(`${base}/${journal.tunnel}/configurations`);
  const ingress = current?.config?.ingress || [];
  // Never replace extra routes that someone added to the tunnel outside this plugin.
  const defaultOnly = ingress.length === 1 && !ingress[0].hostname && ingress[0].service === 'http_status:404';
  if (ingress.length && !defaultOnly && !(ingress.length === 2 && ingress[0].hostname === input.hostname && ingress[0].service === desired.ingress[0].service && !ingress[1].hostname && ingress[1].service === 'http_status:404')) throw new Error('Tunnel has different routing. Inspect its configuration before retrying; nothing was overwritten.');
  if (!ingress.length || defaultOnly) await api(`${base}/${journal.tunnel}/configurations`, 'PUT', { config: desired });
  if (!records.length) await api(dns, 'POST', { type: 'CNAME', name: input.hostname, content: `${journal.tunnel}.cfargotunnel.com`, proxied: true, ttl: 1 });
  const tunnelToken = await api(`${base}/${journal.tunnel}/token`);
  if (typeof tunnelToken !== 'string' || !tunnelToken.trim() || /\s/.test(tunnelToken) || tunnelToken.length > 16384) throw new Error('Invalid tunnel token returned by Cloudflare.');
  const tokenFile = join(p.config, `cloudflare-token-${journal.tunnel}`);
  if (/[\r\n'"`]/.test(tokenFile)) throw new Error('Unsupported characters in the plugin configuration path.');
  await atomic(tokenFile, tunnelToken + '\n');
  // Append overrides: preserve the user's comments and unrelated/multiline settings.
  if (await readFile(p.configFile, 'utf8') !== original) throw new Error('server.env changed during setup. Retry to preserve the new settings.');
  const config = parseEnv(original);
  const settings = { HERDR_SERVE_CLOUDFLARE_ORIGIN: `https://${input.hostname}`, HERDR_SERVE_CLOUDFLARE_TOKEN_FILE: tokenFile, HERDR_SERVE_CLOUDFLARED_BINARY: input.binary };
  const changes = Object.entries(settings).filter(([key, value]) => config[key] !== value);
  if (changes.length) await atomic(p.configFile, original + '\n# Cloudflare automatic setup\n' + changes.map(([key, value]) => `${key}='${value}'`).join('\n') + '\n');
  journal.complete = true;
  await atomic(journalFile, JSON.stringify(journal));
  return { origin: settings.HERDR_SERVE_CLOUDFLARE_ORIGIN, tunnel: journal.tunnel, tokenFile };
}
async function askValue(prompt) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return await new Promise(resolve => { rl.once('close', () => resolve('q')); rl.question(prompt, answer => resolve(answer.trim())); }); }
  finally { rl.close(); process.stdin.pause(); }
}
export async function cloudflareSetupWizard(p, locked) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Open the Cloudflare setup pane, or run node plugin/manage.js cloudflare-setup-ui in a terminal.');
  while (true) {
    console.log('\nCLOUDFLARE SETUP\n[i] Install / Check cloudflared (no sudo)\n[a] Automatic setup with Cloudflare API (installs cloudflared if needed)\n[w] Automatic setup with Wrangler + API (also installs cloudflared; experimental)\n[h] Manual setup instructions\n[q] Back');
    const choice = await askLine();
    if (choice === 'q') return;
    if (choice === 'h') { console.log(cloudflareGuide(p)); continue; }
    if (!['i', 'a', 'w'].includes(choice)) continue;
    try {
      const installed = await locked(() => installCloudflared(p));
      console.log(`cloudflared ${installed.version}: ${installed.binary}${installed.installed ? ' (installed)' : ' (already available)'}`);
      if (choice === 'i') continue;
      console.log('Requires cloudflared 2025.4.0+, an active Cloudflare domain, and an API token with Account / Cloudflare Tunnel / Edit, Zone / DNS / Edit, and Zone / Zone / Read.\nKeep the API token in a chmod 600 file or CLOUDFLARE_API_TOKEN; do not paste it here. Wrangler mode also requires wrangler on PATH.\nSetup creates a dedicated tunnel and DNS route; Enable later starts public access with Herdr token login. Configure Cloudflare Access separately for a user whitelist.');
      const previous = await readJournal(p);
      const config = parseEnv(await readFile(p.configFile, 'utf8'));
      console.log(choice === 'w'
        ? '\nWrangler 配置教程：Wrangler 创建 Tunnel，API 配置域名和路由，因此本流程也需要以下 API Token。'
        : '\nCloudflare API 配置教程：先创建以下 API Token，再选择域名并部署。');
      if (!process.env.CLOUDFLARE_API_TOKEN) console.log(apiTokenGuide());
      else console.log('已从 CLOUDFLARE_API_TOKEN 读取授权配置，接下来选择域名。');
      const file = process.env.CLOUDFLARE_API_TOKEN ? '' : await askValue('API token 文件的完整路径（不是令牌字符串；q 返回）: ');
      if (file === 'q') continue;
      const token = await loadAPIToken(file);
      const api = cloudflareAPI(token);
      const domain = previous ? null : await chooseDomain(api, { ask: askValue });
      if (!previous && !domain) continue;
      const input = previous ? { ...previous.input, binary: config.HERDR_SERVE_CLOUDFLARED_BINARY || 'cloudflared' } : {
        ...domain,
        port: Number(config.HERDR_SERVE_PORT || 7681), binary: config.HERDR_SERVE_CLOUDFLARED_BINARY || 'cloudflared',
        method: choice === 'w' ? 'wrangler' : 'api',
      };
      validateDeployment(input);
      console.log(`${previous ? 'Resume' : 'Create'} ${input.hostname} → http://127.0.0.1:${input.port} using ${input.method}.`);
      if (await askLine('Enter deploy to configure Cloudflare, or Enter to cancel: ') !== 'deploy') continue;
      const result = await locked(() => deployCloudflare(p, input, { api, token }));
      console.log(`Setup complete: ${result.origin}\nTunnel: ${result.tunnel}\nReturn to Cloudflare options and choose Enable. Herdr token login remains required.`);
      await askLine('配置已完成（尚未启用公网访问）。按 Enter 返回，然后选择 Enable；独立 Setup 窗口将在返回时关闭。');
      return;
    } catch (error) { console.error(error.message); }
  }
}
