import { createInterface } from 'node:readline';

// One prompt at a time: setup subprocesses can own stdin for sudo and login.
export async function askLine(prompt = '> ') {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise(resolve => {
      rl.once('close', () => resolve('q'));
      rl.question(prompt, answer => resolve(answer.trim().toLowerCase()));
    });
  } finally { rl.close(); process.stdin.pause(); }
}

export async function runPanel({ summary, providers, service, ask = askLine, print = console.log }) {
  let selected = null;
  while (true) {
    try {
      if (selected === null) {
        print('\nHERDR SERVE · CONNECTION OPTIONS');
        try { await summary(); } catch (error) { print(`Error: ${error.message}`); }
        print('[1] Cloudflare Tunnel\n[2] Tailscale Funnel\n[3] Service controls\n[q] Close panel');
        const key = await ask();
        if (key === 'q') return;
        if (key === '1') selected = 'cloudflare';
        else if (key === '2') selected = 'tailscale';
        else if (key === '3') selected = 'service';
        else print('Choose 1, 2, 3 or q.');
        continue;
      }
      if (selected === 'service') {
        print('\nHERDR SERVE · SERVICE CONTROLS');
        try { await summary(); } catch (error) { print(`Error: ${error.message}`); }
        print('[s] Start service\n[x] Stop service and its active tunnel\n[r] Refresh\n[b] Back\n[q] Close panel');
        const key = await ask();
        if (key === 'q') return;
        if (key === 'b') selected = null;
        else if (key === 's') await service.start();
        else if (key === 'x') await service.stop();
        else if (key !== 'r') print('Choose s, x, r, b or q.');
        continue;
      }
      const provider = providers[selected];
      print(`\nHERDR SERVE · ${provider.title}`);
      // A broken/missing dependency must not prevent opening Setup or going Back.
      try { print(await provider.status()); } catch (error) { print(error.message); }
      print('[s] Deploy / Setup\n[e] Enable public access (token login required)\n[d] Disable public access\n[r] Refresh status\n[b] Back to connection options\n[q] Close panel');
      const key = await ask();
      if (key === 'q') return;
      if (key === 'b') selected = null;
      else if (key === 's') await provider.setup();
      else if (key === 'e') await provider.enable();
      else if (key === 'd') await provider.disable();
      else if (key !== 'r') print('Choose s, e, d, r, b or q.');
    } catch (error) { print(`Error: ${error.message}`); }
  }
}
