import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { deployCloudflare, cloudflareAPI, loadAPIToken, wranglerCreate } from '../plugin/cloudflare-setup.js';
const account = 'a'.repeat(32), zone = 'b'.repeat(32), tunnel = '12345678-abcd-abcd-abcd-123456789abc';
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'hs-setup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const p = { config: dir, state: join(dir, 'state'), configFile: join(dir, 'server.env') };
  await mkdir(p.state);
  await writeFile(p.configFile, '# preserved\nHERDR_SERVE_PORT=9876\nHERDR_SERVE_ORIGIN=http://localhost:9876\n');
  const input = { account, zone, hostname: 'herdr.example.com', port: 9876, binary: 'cloudflared', method: 'api' };
  const remote = { tunnels: [], records: [], config: null, calls: [] };
  const api = async (path, method = 'GET', body) => {
    remote.calls.push({path, method, body});
    if (path === `/zones/${zone}`) return { name: 'example.com', account: {id: account}, status: 'active' };
    if (path.includes('/dns_records?')) return remote.records;
    if (path.endsWith('/dns_records') && method === 'POST') { remote.records.push({id:'dns', ...body}); return remote.records[0]; }
    if (path.includes('/cfd_tunnel?')) return remote.tunnels;
    if (path.endsWith('/cfd_tunnel') && method === 'POST') { const value = { id: tunnel, name: body.name, remote_config: true }; remote.tunnels.push(value); return value; }
    if (path.endsWith('/configurations')) { if (method === 'PUT') remote.config = body.config; return {config: remote.config}; }
    if (path.endsWith('/token')) return 'fake-connector-token';
    throw new Error('Unexpected request ' + path);
  };
  const deps = { api, token: 'fake-api-token', checkBinary: async () => {} };
  return {p, input, remote, deps};
}
test('automatic deployment configures loopback routing, private token and preserves local settings; retry is idempotent', async t => {
  const {p,input,remote,deps} = await fixture(t);
  const result = await deployCloudflare(p,input,deps);
  assert.equal(result.origin,'https://herdr.example.com');
  assert.deepEqual(remote.config.ingress, [{hostname:input.hostname,service:'http://127.0.0.1:9876'},{service:'http_status:404'}]);
  const content = await readFile(p.configFile,'utf8');
  assert.match(content, /# preserved/);
  assert.equal(parseEnv(content).HERDR_SERVE_ORIGIN,'http://localhost:9876');
  assert.equal(parseEnv(content).HERDR_SERVE_CLOUDFLARE_ORIGIN,result.origin);
  assert.equal((await stat(result.tokenFile)).mode & 0o777,0o600);
  assert.ok(!(await readFile(join(p.config,'cloudflare-deployment.json'),'utf8')).includes('fake-'));
  await deployCloudflare(p,input,deps);
  assert.equal(remote.calls.filter(c=>c.method==='POST').length,2);
  assert.equal(remote.calls.filter(c=>c.method==='PUT').length,1);
  assert.equal(await readFile(p.configFile,'utf8'),content);
});
test('conflicting DNS or invalid account input never mutates Cloudflare', async t => {
  const {p,input,remote,deps} = await fixture(t);
  remote.records.push({type:'A',name:input.hostname,content:'192.0.2.1'});
  await assert.rejects(deployCloudflare(p,input,deps),/already has DNS/);
  assert.ok(remote.calls.every(c=>c.method==='GET'));
  await assert.rejects(deployCloudflare(p,{...input,account:'bad'},deps),/Account ID/);
});
test('lost create response recovers the dedicated tunnel on retry without duplicates', async t => {
  const {p,input,remote,deps} = await fixture(t);
  let fail=true;
  const api=deps.api;
  deps.api=async(...args)=>{const result=await api(...args);if(fail && args[1]==='POST'){fail=false;throw new Error('connection lost');}return result;};
  await assert.rejects(deployCloudflare(p,input,deps),/connection lost/);
  await deployCloudflare(p,input,deps);
  assert.equal(remote.tunnels.length,1);
  assert.equal(remote.records.length,1);
});
test('Wrangler creates the tunnel; API finishes routing without parsing CLI output', async t => {
  const {p,input,remote,deps} = await fixture(t);
  input.method='wrangler';
  deps.createWithWrangler=async(name,accountId,token)=>{assert.equal(accountId,account);assert.equal(token,'fake-api-token');remote.tunnels.push({id:tunnel,name,remote_config:true});};
  await deployCloudflare(p,input,deps);
  assert.equal(remote.calls.filter(c=>c.path.endsWith('/cfd_tunnel') && c.method==='POST').length,0);
  assert.equal(remote.records.length,1);
});
test('changed remote routes and local settings are not silently replaced', async t => {
  const {p,input,remote,deps} = await fixture(t);
  await deployCloudflare(p,input,deps);
  remote.config.ingress.unshift({hostname:'another.example.com',service:'http://localhost:1234'});
  await assert.rejects(deployCloudflare(p,input,deps),/different routing/);
  await assert.rejects(deployCloudflare(p,{...input,hostname:'new.example.com'},deps),/different settings/);
});
test('missing binary stops before cloud mutations', async t => {
  const {p,input,remote,deps} = await fixture(t);
  deps.checkBinary=async()=>{throw new Error('not installed');};
  await assert.rejects(deployCloudflare(p,input,deps),/not installed/);
  assert.equal(remote.calls.length,0);
});
test('API sends credentials only to Cloudflare and never reports response secrets', async () => {
  const api=cloudflareAPI('secret-api-token',async(url,options)=>{
    assert.ok(url.startsWith('https://api.cloudflare.com/client/v4/'));
    assert.equal(options.headers.Authorization,'Bearer secret-api-token');
    assert.equal(options.redirect,'error');
    return {ok:false,status:403,json:async()=>({success:false,errors:[{message:'secret-api-token'}]})};
  });
  await assert.rejects(api('/zones/test'),error=>error.message.includes('403') && !error.message.includes('secret-api-token'));
});
test('private API token input and Wrangler credentials never appear in command arguments or errors',async t=>{
  const {p}=await fixture(t);
  const file=join(p.config,'api-token');
  await writeFile(file,'api-secret',{mode:0o644});
  await assert.rejects(loadAPIToken(file,{}),/private/);
  await wranglerCreate('herdr-test',account,'api-secret',async(binary,args,options)=>{
    assert.equal(binary,'wrangler');assert.deepEqual(args,['tunnel','create','herdr-test']);
    assert.equal(options.env.CLOUDFLARE_API_TOKEN,'api-secret');
    assert.equal(options.env.CLOUDFLARE_ACCOUNT_ID,account);
  });
  await assert.rejects(wranglerCreate('herdr-test',account,'api-secret',async()=>{throw new Error('api-secret');}),error=>!error.message.includes('api-secret'));
});
test('installing a private binary does not prevent resuming an existing deployment',async t=>{
  const{p,input,remote,deps}=await fixture(t);
  await deployCloudflare(p,input,deps);
  const binary=join(p.config,'bin','cloudflared');
  await deployCloudflare(p,{...input,binary},deps);
  assert.equal(remote.tunnels.length,1);assert.equal(remote.records.length,1);
  assert.equal(parseEnv(await readFile(p.configFile,'utf8')).HERDR_SERVE_CLOUDFLARED_BINARY,binary);
});
