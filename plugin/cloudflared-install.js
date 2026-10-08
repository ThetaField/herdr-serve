import { execFile } from 'node:child_process';
import { promisify, parseEnv } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readCloudflare } from './cloudflare.js';
const exec = promisify(execFile);
const releaseURL = 'https://api.github.com/repos/cloudflare/cloudflared/releases/latest';
const maxBinary = 100 * 1024 * 1024;

export async function checkSetupBinary(binary, run = exec) {
  let stdout;
  try { ({ stdout } = await run(binary, ['--version'], { timeout: 5000, maxBuffer: 4096 })); }
  catch { throw new Error('cloudflared is unavailable. Choose Install / Check cloudflared in Cloudflare Setup.'); }
  const version = stdout.match(/\b(\d{4})\.(\d+)\.(\d+)\b/);
  if (!version || +version[1] < 2025 || (+version[1] === 2025 && +version[2] < 4)) throw new Error('cloudflared 2025.4.0+ is required.');
  return version[0];
}
export function releaseAsset(platform = process.platform, arch = process.arch) {
  if (!['linux', 'darwin'].includes(platform) || !['x64', 'arm64'].includes(arch)) throw new Error(`Automatic installation is unavailable for ${platform}/${arch}. Install cloudflared manually and set HERDR_SERVE_CLOUDFLARED_BINARY.`);
  return `cloudflared-${platform}-${arch === 'x64' ? 'amd64' : arch}${platform === 'darwin' ? '.tgz' : ''}`;
}
async function download(url, limit, fetcher, timeout) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(timeout), headers: { 'User-Agent': 'herdr-serve' } });
  if (!response.ok) throw new Error(`cloudflared download failed (HTTP ${response.status}); retry or install manually.`);
  if (Number(response.headers.get('content-length')) > limit) throw new Error('cloudflared download is too large.');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error('cloudflared download is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
// Installs only inside the plugin directory. Caller holds the management lock.
export async function installCloudflared(p, { platform = process.platform, arch = process.arch, fetcher = fetch, run = exec, print = console.log } = {}) {
  const original = await readFile(p.configFile, 'utf8');
  const config = parseEnv(original);
  const current = config.HERDR_SERVE_CLOUDFLARED_BINARY || 'cloudflared';
  try { const version = await checkSetupBinary(current, run); return { binary: current, version, installed: false }; }
  catch { /* Missing, broken or too old: use a private installation. */ }
  const name = releaseAsset(platform, arch);
  if (await readCloudflare(p)) throw new Error('Disable Cloudflare before installing a replacement connector.');
  const bin = resolve(p.config, 'bin');
  if (/[\r\n'"`]/.test(bin)) throw new Error('Unsupported characters in the plugin configuration path.');
  print('Downloading cloudflared from the official Cloudflare GitHub release; no sudo is needed.');
  const release = JSON.parse((await download(releaseURL, 2 * 1024 * 1024, fetcher, 30_000)).toString('utf8'));
  if (release.draft || release.prerelease || !/^\d{4}\.\d+\.\d+$/.test(release.tag_name)) throw new Error('Unexpected cloudflared release metadata.');
  const asset = release.assets?.find(item => item.name === name);
  const url = `https://github.com/cloudflare/cloudflared/releases/download/${release.tag_name}/${name}`;
  if (!asset || asset.browser_download_url !== url || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || '') || !Number.isInteger(asset.size) || asset.size < 1 || asset.size > maxBinary) throw new Error('No supported release asset with a SHA-256 checksum was found. Nothing installed.');
  const data = await download(url, maxBinary, fetcher, 120_000);
  if (data.length !== asset.size || createHash('sha256').update(data).digest('hex') !== asset.digest.slice(7)) throw new Error('cloudflared checksum/size mismatch. Nothing installed.');
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(join(bin, '.install-'));
  try {
    let executable = data;
    if (platform === 'darwin') {
      const archive = join(stage, 'download.tgz');
      await writeFile(archive, data, { mode: 0o600, flag: 'wx' });
      // Stream only the named member; never extract arbitrary archive paths to disk.
      const result = await run('tar', ['-xOzf', archive, 'cloudflared'], { encoding: 'buffer', maxBuffer: maxBinary, timeout: 30_000 });
      executable = result.stdout;
    }
    const candidate = join(stage, 'cloudflared');
    await writeFile(candidate, executable, { mode: 0o700, flag: 'wx' });
    const version = await checkSetupBinary(candidate, run);
    if (version !== release.tag_name) throw new Error('Downloaded executable version does not match the release.');
    if (await readFile(p.configFile, 'utf8') !== original) throw new Error('server.env changed during installation. Retry to preserve the new settings.');
    const binary = join(bin, `cloudflared-${version}-${platform}-${arch}`);
    await rename(candidate, binary);
    const configTemp = join(stage, 'server.env');
    await writeFile(configTemp, original + `\n# Plugin-managed cloudflared\nHERDR_SERVE_CLOUDFLARED_BINARY='${binary}'\n`, { mode: 0o600, flag: 'wx' });
    await rename(configTemp, p.configFile);
    return { binary, version, installed: true };
  } finally { await rm(stage, { recursive: true, force: true }); }
}
