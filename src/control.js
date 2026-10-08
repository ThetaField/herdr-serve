import net from 'node:net';
import { chmod, unlink } from 'node:fs/promises';

// Private local management channel. Never signal a PID read from a state file.
export async function listenControl(path, info, shutdown) {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.setTimeout(2000, () => socket.destroy());
    let input = '';
    socket.on('data', chunk => {
      input += chunk;
      if (input.length > 1024) return socket.destroy();
      if (!input.includes('\n')) return;
      socket.removeAllListeners('data');
      if (input.trim() === 'status') socket.end(JSON.stringify({ service: 'herdr-serve', ...(typeof info === 'function' ? info() : info) }) + '\n');
      else if (input.trim() === 'stop') socket.end('{"stopping":true}\n', () => { void shutdown(); });
      else socket.end('{"error":"Unknown command"}\n');
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  await chmod(path, 0o600);
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    try { await unlink(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
}
