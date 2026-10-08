import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The bridge owns the child handle. Never kill a PID loaded from disk.
export async function startCloudflare({ binary, tokenFile }, spawnChild = spawn) {
  const dir = await mkdtemp(join(tmpdir(), 'herdr-cloudflared-'));
  const config = join(dir, 'config.yml');
  await writeFile(config, '{}\n', { mode: 0o600 });
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('HERDR_') || key.startsWith('TUNNEL_') || key.startsWith('CF_') || key.startsWith('CLOUDFLARE_')) delete env[key];
  let child;
  try {
    child = spawnChild(binary, ['tunnel', '--config', config, '--no-autoupdate', 'run', '--token-file', tokenFile], { env, stdio: ['ignore', 'inherit', 'inherit'] });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(new Error('Cannot launch cloudflared. Check installation and binary path.'))); });
  } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
  let running = true, stopping;
  const exited = new Promise(resolve => child.once('exit', () => { running = false; resolve(); }));
  return {
    status: () => ({ running }),
    stop() {
      return stopping ||= (async () => {
        if (running) {
          child.kill('SIGTERM');
          const timer = setTimeout(() => { if (running) child.kill('SIGKILL'); }, 2000);
          try { await exited; } finally { clearTimeout(timer); }
        }
        await rm(dir, { recursive: true, force: true });
      })();
    },
  };
}
