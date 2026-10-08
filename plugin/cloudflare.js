import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, rename, unlink, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFunnel } from './funnel.js';
const exec = promisify(execFile);

export function validateCloudflare(record) {
  if (typeof record.origin !== 'string' || !record.origin) throw new Error('Set HERDR_SERVE_CLOUDFLARE_ORIGIN to your published HTTPS hostname first. Open Cloudflare setup in the panel for instructions.');
  const url = new URL(record.origin);
  if (record.version !== 1 || url.protocol !== 'https:' || url.origin !== record.origin || url.port ||
      !url.hostname.includes('.') || url.hostname === '127.0.0.1' || url.hostname.endsWith('.localhost') ||
      !Number.isInteger(record.port) || record.port < 1 || record.port > 65535 ||
      typeof record.tokenFile !== 'string' || !isAbsolute(record.tokenFile) ||
      typeof record.binary !== 'string' || !record.binary) throw new Error('Invalid Cloudflare settings. Use an HTTPS origin without a path and an absolute token-file path.');
  return record;
}
export async function readCloudflare(p) {
  try { return validateCloudflare(JSON.parse(await readFile(join(p.state, 'cloudflare.json'), 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function checkCloudflare(record) {
  let meta;
  try { meta = await stat(record.tokenFile); } catch { throw new Error(`Save your Cloudflare tunnel token in ${record.tokenFile} and chmod 600 the file before enabling.`); }
  if (!meta.isFile() || meta.size < 1 || meta.size > 16384 || (meta.mode & 0o077)) throw new Error('Cloudflare token file must be a nonempty private file (chmod 600).');
  if (!(await readFile(record.tokenFile, 'utf8')).trim()) throw new Error('Cloudflare token file is empty.');
  let stdout;
  try { ({ stdout } = await exec(record.binary, ['--version'], { timeout: 5000, maxBuffer: 4096 })); }
  catch { throw new Error('cloudflared is unavailable. Install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ or set HERDR_SERVE_CLOUDFLARED_BINARY.'); }
  const match = stdout.match(/\b(\d{4})\.(\d+)\.(\d+)\b/);
  if (!match || Number(match[1]) < 2025 || (Number(match[1]) === 2025 && Number(match[2]) < 4)) throw new Error('cloudflared 2025.4.0 or later is required for --token-file.');
}
async function save(p, record) {
  const file = join(p.state, 'cloudflare.json'), temp = file + '.' + randomUUID();
  try { await writeFile(temp, JSON.stringify(record), { mode: 0o600, flag: 'wx' }); await rename(temp, file); }
  finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
async function clear(p) { await unlink(join(p.state, 'cloudflare.json')).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
export function cloudflareManager(p, services, preflight = checkCloudflare) {
  return {
    async status() {
      const saved = await readCloudflare(p);
      if (!saved) return { enabled: false, message: 'Cloudflare: not configured by this plugin' };
      const info = await services.status();
      const running = info?.cloudflare?.running === true;
      return { enabled: running, origin: saved.origin, message: running ? `Cloudflare connector running: ${saved.origin} (public routing/Access must be verified in Cloudflare)` : 'Cloudflare selected, but connector is not running. Inspect serve.log or retry cloudflare-on.' };
    },
    async enable() {
      if (await readFunnel(p)) throw new Error('Tailscale Funnel is selected. Run funnel-off before enabling Cloudflare.');
      const config = await services.config();
      const record = validateCloudflare({ version: 1, origin: config.HERDR_SERVE_CLOUDFLARE_ORIGIN,
        port: Number(config.HERDR_SERVE_PORT || 7681), tokenFile: config.HERDR_SERVE_CLOUDFLARE_TOKEN_FILE || join(p.config, 'cloudflare-token'),
        binary: config.HERDR_SERVE_CLOUDFLARED_BINARY || 'cloudflared' });
      await preflight(record);
      const saved = await readCloudflare(p);
      if (saved && JSON.stringify(saved) !== JSON.stringify(record)) throw new Error('Cloudflare settings changed. Run cloudflare-off before enabling the new settings.');
      const previous = await services.status();
      if (saved && previous?.cloudflare?.running && previous.origin === record.origin && previous.port === record.port) return previous;
      await save(p, record);
      try {
        if (previous) await services.stop();
        const info = await services.start();
        if (!info?.cloudflare?.running || info.origin !== record.origin) throw new Error('Cloudflare connector failed to start. Inspect serve.log.');
        return info;
      } catch (error) {
        if (!saved) {
          try { await services.stop(); await clear(p); if (previous) await services.start(); }
          catch (rollback) { throw new Error(`${error.message}\nCould not restore the previous service: ${rollback.message}`); }
        }
        throw error;
      }
    },
    async disable(restart = true) {
      if (!await readCloudflare(p)) return { message: 'No plugin-owned Cloudflare connector to disable' };
      const running = await services.status();
      await services.stop(); // The bridge stops its own connector before closing the HTTP listener.
      await clear(p);
      if (restart && running) await services.start();
      return { message: 'Plugin Cloudflare connector stopped; original server.env settings restored. Cloudflare DNS, Access policies and other connectors were not changed.' };
    },
  };
}
export function cloudflareGuide(p) {
  return `CLOUDFLARE TUNNEL SETUP
1. Choose Install / Check cloudflared in this wizard, or install cloudflared 2025.4.0+ manually: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
2. Create a dedicated tunnel in the Cloudflare dashboard. Do not also install its connector as a system service; this plugin runs it.
3. Add a public hostname (e.g. herdr.example.com), mapped to http://127.0.0.1:7681 (use your configured HERDR_SERVE_PORT).
4. For account restrictions, configure a Cloudflare Access application/policy covering the entire hostname. Tunnel alone does not supply a user whitelist.
5. Save only the tunnel token in ${join(p.config, 'cloudflare-token')}, then chmod 600 that file. This is different from your Herdr Serve login token.
6. Edit ${p.configFile}:
HERDR_SERVE_CLOUDFLARE_ORIGIN=https://herdr.example.com
# Optional: HERDR_SERVE_CLOUDFLARE_TOKEN_FILE=/absolute/path/to/token
# Optional: HERDR_SERVE_CLOUDFLARED_BINARY=/absolute/path/to/cloudflared
7. Disable Tailscale Funnel if selected, then run herdr plugin action invoke herdr.serve.cloudflare-on.
Token login remains required. The plugin does not create DNS routes or Access policies.\n`;
}
