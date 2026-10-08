// Zone responses include their owning account, so no extra account-list permission is needed.
export async function listDomains(api) {
  const zones = new Map();
  for (let page = 1; page <= 100; page++) {
    const batch = await api(`/zones?status=active&per_page=50&page=${page}&order=name&direction=asc`);
    if (!Array.isArray(batch)) throw new Error('Cloudflare returned an invalid domain list.');
    for (const zone of batch) {
      if (zone.status === 'active' && /^[a-f0-9]{32}$/i.test(zone.id) && /^[a-f0-9]{32}$/i.test(zone.account?.id) && typeof zone.name === 'string') zones.set(zone.id, zone);
    }
    if (batch.length < 50) return [...zones.values()];
  }
  throw new Error('Too many domains to list. Use an API token scoped to the domain you want.');
}
const clean = text => String(text).replace(/[\x00-\x1f\x7f-\x9f]/g, '');
export async function chooseDomain(api, { ask, print = console.log }) {
  let domains = [];
  try { domains = await listDomains(api); }
  catch (error) { print(`Cannot load domains: ${error.message}\nCheck that your API token has Zone / Zone / Read permission for the intended domain.`); }
  if (!domains.length) print('No active domains are visible. Add your domain to Cloudflare, finish its nameserver setup, and give this API token access to it.');
  else {
    print('Choose the domain for your Herdr address:');
    domains.forEach((zone, index) => print(`[${index + 1}] ${clean(zone.name)} — ${clean(zone.account.name || 'Cloudflare account')}`));
  }
  print('[m] Advanced: enter IDs manually\n[q] Back');
  while (true) {
    const answer = (await ask(domains.length === 1 ? 'Domain [1] (Enter to select): ' : 'Domain number: ')).trim().toLowerCase();
    if (answer === 'q') return null;
    if (answer === 'm') {
      print('Account ID identifies the Cloudflare account. Zone ID identifies your domain.\nBoth are shown in the API section of the domain Overview page in the Cloudflare dashboard. These are identifiers, not your login email or API token.');
      const account = (await ask('Account ID (32 hexadecimal characters; blank to cancel): ')).trim();
      if (!account) return null;
      const zone = (await ask('Zone ID (32 hexadecimal characters; blank to cancel): ')).trim();
      if (!zone) return null;
      const hostname = (await ask('Full Herdr address, e.g. herdr.example.com (without https://): ')).trim().toLowerCase();
      if (!hostname) return null;
      return { account, zone, hostname };
    }
    const index = answer === '' && domains.length === 1 ? 0 : /^[1-9]\d*$/.test(answer) ? Number(answer) - 1 : -1;
    const selected = domains[index];
    if (!selected) { print('Choose a listed number, m, or q.'); continue; }
    while (true) {
      const label = (await ask(`Address prefix [herdr] → herdr.${clean(selected.name)} (q to go back): `)).trim().toLowerCase() || 'herdr';
      if (label === 'q') break;
      if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) { print('Enter a short name such as herdr or work, using letters, digits and hyphens.'); continue; }
      const hostname = `${label}.${selected.name}`;
      print(`Herdr address: https://${clean(hostname)}`);
      return { account: selected.account.id, zone: selected.id, hostname };
    }
  }
}
