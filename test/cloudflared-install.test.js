import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { parseEnv } from 'node:util';
import { installCloudflared, releaseAsset } from '../plugin/cloudflared-install.js';
async function fixture(t, platform='linux') {
  const dir=await mkdtemp(join(tmpdir(),'cf-install-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const p={config:dir,state:join(dir,'state'),configFile:join(dir,'server.env')};
  await mkdir(p.state);await writeFile(p.configFile,'# keep\nHERDR_SERVE_PORT=8888\n');
  const data=Buffer.from('fake executable');
  const name=releaseAsset(platform,'x64');
  const asset={name,size:data.length,digest:'sha256:'+createHash('sha256').update(data).digest('hex'),browser_download_url:`https://github.com/cloudflare/cloudflared/releases/download/2026.10.0/${name}`};
  let requests=0;
  const deps={platform,arch:'x64',print:()=>{},fetcher:async()=>{requests++;return new Response(requests===1?JSON.stringify({tag_name:'2026.10.0',assets:[asset]}):data);},run:async(binary,args)=>{
    if(binary==='cloudflared')throw new Error('missing');
    if(binary==='tar'){assert.equal(args.at(-1),'cloudflared');return{stdout:data};}
    return{stdout:'cloudflared version 2026.10.0'};
  }};
  return{p,deps,asset,data,requests:()=>requests};
}
test('installs verified private Linux executable and preserves unrelated configuration',async t=>{
  const{p,deps,data}=await fixture(t);const result=await installCloudflared(p,deps);
  assert.equal(result.installed,true);assert.deepEqual(await readFile(result.binary),data);
  assert.equal((await stat(result.binary)).mode&0o777,0o700);
  const config=parseEnv(await readFile(p.configFile,'utf8'));
  assert.equal(config.HERDR_SERVE_PORT,'8888');assert.equal(config.HERDR_SERVE_CLOUDFLARED_BINARY,result.binary);
  assert.equal((await stat(p.configFile)).mode&0o777,0o600);
});
test('reuses a suitable binary without network or config edits',async t=>{
  const{p,deps,requests}=await fixture(t);deps.run=async()=>({stdout:'cloudflared version 2026.1.0'});
  const original=await readFile(p.configFile,'utf8');assert.equal((await installCloudflared(p,deps)).installed,false);
  assert.equal(requests(),0);assert.equal(await readFile(p.configFile,'utf8'),original);
});
test('checksum failure never executes the download or changes config',async t=>{
  const{p,deps,asset}=await fixture(t);asset.digest='sha256:'+'0'.repeat(64);
  deps.run=async(binary)=>{assert.equal(binary,'cloudflared');throw new Error('missing');};
  const original=await readFile(p.configFile,'utf8');await assert.rejects(installCloudflared(p,deps),/checksum/);
  assert.equal(await readFile(p.configFile,'utf8'),original);
});
test('unsupported platforms and nonofficial download URLs are refused',async t=>{
  assert.throws(()=>releaseAsset('win32','x64'),/unavailable/);
  const{p,deps,asset,requests}=await fixture(t);asset.browser_download_url='https://example.com/binary';
  await assert.rejects(installCloudflared(p,deps),/No supported release/);assert.equal(requests(),1);
});
test('macOS extracts only the verified cloudflared archive member',async t=>{
  const{p,deps,data}=await fixture(t,'darwin');const result=await installCloudflared(p,deps);
  assert.deepEqual(await readFile(result.binary),data);
});
test('bad executable version and download errors leave settings unchanged',async t=>{
  const{p,deps}=await fixture(t);const original=await readFile(p.configFile,'utf8');
  deps.run=async(binary)=>{if(binary==='cloudflared')throw new Error('missing');return{stdout:'cloudflared version 2026.1.0'};};
  await assert.rejects(installCloudflared(p,deps),/does not match/);
  assert.equal(await readFile(p.configFile,'utf8'),original);
  deps.fetcher=async()=>new Response('unavailable',{status:503});
  await assert.rejects(installCloudflared(p,deps),/HTTP 503/);
  assert.equal(await readFile(p.configFile,'utf8'),original);
});
test('active Cloudflare selection prevents replacing its missing executable',async t=>{
  const{p,deps,requests}=await fixture(t);
  await writeFile(join(p.state,'cloudflare.json'),JSON.stringify({version:1,origin:'https://herdr.example.com',port:8888,tokenFile:join(p.config,'token'),binary:'cloudflared'}));
  await assert.rejects(installCloudflared(p,deps),/Disable Cloudflare/);assert.equal(requests(),0);
});
test('a manually installed binary can still be used on an architecture without automatic downloads',async t=>{
  const{p,deps,requests}=await fixture(t);deps.arch='arm';deps.run=async()=>({stdout:'cloudflared version 2026.1.0'});
  assert.equal((await installCloudflared(p,deps)).installed,false);assert.equal(requests(),0);
});
