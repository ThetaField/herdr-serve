import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const exec = promisify(execFile);
export async function tailscale(args) {
  try { return (await exec('tailscale', args, { timeout: 20_000, maxBuffer: 1024 * 1024 })).stdout; }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('Tailscale is not installed or not on PATH. Open the guided setup: herdr plugin action invoke herdr.serve.setup');
    throw new Error(`Tailscale failed: ${(error.stderr || error.stdout || error.message).trim()}. Check tailscale status, Funnel authorization and permission to manage tailscaled; no sudo is run automatically.`);
  }
}
export async function readFunnel(p) {
  try {
    const record = JSON.parse(await readFile(join(p.state, 'funnel.json'), 'utf8'));
    const url = new URL(record.origin);
    if (record.version !== 1 || ![443, 8443, 10000].includes(record.port) || url.protocol !== 'https:' ||
        !/^[a-z0-9.-]+\.ts\.net$/.test(url.hostname) || url.origin !== record.origin ||
        Number(url.port || 443) !== record.port || record.hostPort !== `${url.hostname}:${record.port}` ||
        !/^http:\/\/127\.0\.0\.1:\d+$/.test(record.target)) throw new Error('Invalid Funnel state');
    return record;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function save(p, record) {
  const path = join(p.state, 'funnel.json');
  const temp = path + '.' + randomUUID();
  try { await writeFile(temp, JSON.stringify(record), { mode: 0o600, flag: 'wx' }); await rename(temp, path); }
  finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
async function clear(p) { await unlink(join(p.state, 'funnel.json')).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
function parse(text) { const value = JSON.parse(text); if (value === null) return {}; if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Unexpected Tailscale JSON'); return value; }
function usesPort(config, port) {
  return !!config.TCP?.[port] || Object.keys(config.Web || {}).some(key => key.endsWith(`:${port}`)) ||
    Object.entries(config.AllowFunnel || {}).some(([key, value]) => value && key.endsWith(`:${port}`)) ||
    Object.values(config.Foreground || {}).some(value => usesPort(value, port));
}
// Do not remove a route when another service/path has appeared on the same listener.
export function ownsRoute(config, record) {
  if (Object.values(config.Foreground || {}).some(value => usesPort(value, record.port))) return false;
  const tcp = config.TCP?.[record.port];
  if (!tcp?.HTTPS || tcp.HTTP || tcp.TCPForward || tcp.TerminateTLS) return false;
  const hosts = Object.keys(config.Web || {}).filter(key => key.endsWith(`:${record.port}`));
  if (hosts.length !== 1 || hosts[0] !== record.hostPort) return false;
  const handlers = config.Web[record.hostPort]?.Handlers;
  if (!handlers || Object.keys(handlers).length !== 1 || !handlers['/']) return false;
  const handler = handlers['/'];
  return Object.keys(handler).every(key => key === 'Proxy') && handler.Proxy?.replace(/\/$/, '') === record.target;
}
export function funnelManager(p, services, run = tailscale) {
  const config = async () => parse(await run(['funnel', 'status', '--json']));
  const removeRoute = async record => {
    const current = await config();
    if (!usesPort(current, record.port)) return;
    if (!ownsRoute(current, record)) throw new Error('Funnel route was changed outside this plugin. Refusing to remove another service. Inspect tailscale funnel status before retrying.');
    await run(['funnel', '--bg', `--https=${record.port}`, 'off']);
    if (usesPort(await config(), record.port)) throw new Error('Funnel route is still present; local service was left unchanged.');
  };
  return {
    async status() {
      const record = await readFunnel(p);
      if (!record) return { enabled: false, message: 'Funnel: not configured by this plugin' };
      const current = await config();
      const active = ownsRoute(current, record) && current.AllowFunnel?.[record.hostPort] === true;
      return { enabled: active, origin: record.origin, message: active ? `Public Funnel: ${record.origin} (token login required)` : 'Funnel: saved configuration is missing or changed; use funnel-on to retry, or inspect tailscale funnel status' };
    },
    async enable() {
      await services.exclusive?.();
      const node = parse(await run(['status', '--json']));
      const hostname = node.Self?.DNSName?.replace(/\.$/, '');
      if (node.BackendState !== 'Running' || !hostname || !/^[a-z0-9.-]+\.ts\.net$/.test(hostname)) throw new Error('Tailscale is not ready. Run tailscale up and enable MagicDNS/HTTPS and Funnel in your tailnet.');
      const settings = await services.config();
      const port = Number(settings.HERDR_SERVE_FUNNEL_PORT || 443);
      const localPort = Number(settings.HERDR_SERVE_PORT || 7681);
      if (![443, 8443, 10000].includes(port)) throw new Error('HERDR_SERVE_FUNNEL_PORT must be 443, 8443 or 10000.');
      if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) throw new Error('Invalid local port');
      const record = { version: 1, port, origin: `https://${hostname}${port === 443 ? '' : ':' + port}`, hostPort: `${hostname}:${port}`, target: `http://127.0.0.1:${localPort}` };
      const saved = await readFunnel(p);
      if (saved && (saved.origin !== record.origin || saved.target !== record.target)) throw new Error('Funnel hostname or port changed. Run funnel-off before enabling the new configuration.');
      const current = await config();
      if (usesPort(current, port) && !(saved && ownsRoute(current, saved))) throw new Error(`Tailscale port ${port} is already used by another Serve/Funnel configuration. Choose HERDR_SERVE_FUNNEL_PORT=8443 or 10000. Nothing was changed.`);
      const previous = await services.status();
      await save(p, record); // Durable ownership intent before making external changes.
      try {
        if (previous && (previous.origin !== record.origin || previous.host !== '127.0.0.1' || previous.port !== localPort)) await services.stop();
        const info = await services.start();
        if (!info || info.origin !== record.origin || info.host !== '127.0.0.1' || info.port !== localPort) throw new Error('Local service does not match Funnel configuration');
        if (!ownsRoute(current, record) || !current.AllowFunnel?.[record.hostPort]) {
          await run(['funnel', '--bg', `--https=${port}`, record.target]);
        }
        const actual = await config();
        if (!ownsRoute(actual, record) || actual.AllowFunnel?.[record.hostPort] !== true) throw new Error('Tailscale did not confirm the requested public route');
        return { ...info, funnel: record.origin };
      } catch (error) {
        // Keep existing setups intact on retry failures. New setups roll back only our route.
        if (saved) throw error;
        try {
          await removeRoute(record);
          await clear(p);
          await services.stop();
          if (previous) await services.start();
        } catch (rollback) { throw new Error(`${error.message}\nRollback incomplete: ${rollback.message}. Funnel state was retained where possible; inspect funnel-status.`); }
        throw error;
      }
    },
    async disable(restart = true) {
      const record = await readFunnel(p);
      if (!record) return { enabled: false, message: 'No plugin-owned Funnel to disable' };
      await removeRoute(record); // Revoke public routing before freeing the local port.
      const running = await services.status();
      await services.stop();
      await clear(p);
      if (restart && running) await services.start();
      return { enabled: false, message: 'Funnel disabled; original server.env settings restored' };
    },
  };
}
