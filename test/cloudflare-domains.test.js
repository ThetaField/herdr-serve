import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listDomains, chooseDomain } from '../plugin/cloudflare-domains.js';
const zone = (n=1) => ({ id:n.toString(16).padStart(32,'0'), name:`site${n}.example`, status:'active', account:{id:'a'.repeat(32),name:'Personal'} });
function prompts(values, output=[]) { return {ask:async prompt=>{output.push(prompt);assert.ok(values.length,'Unexpected prompt');return values.shift();},print:value=>output.push(value)}; }
test('single domain accepts defaults and derives account and zone IDs',async()=>{
 const z=zone();const output=[];const result=await chooseDomain(async()=>[z],prompts(['',''],output));
 assert.deepEqual(result,{account:z.account.id,zone:z.id,hostname:'herdr.site1.example'});
 assert.ok(output.some(line=>line.includes('Personal')));
 assert.ok(!output.some(line=>line.includes(z.id)));
});
test('multiple accounts/domains select correct IDs and validate address prefix',async()=>{
 const z=zone(2);z.account={id:'b'.repeat(32),name:'Team'};
 const result=await chooseDomain(async()=>[zone(),z],prompts(['99','2','bad/path','work']));
 assert.deepEqual(result,{account:z.account.id,zone:z.id,hostname:'work.site2.example'});
});
test('domain discovery paginates and skips inactive domains',async()=>{
 const calls=[];const result=await listDomains(async path=>{calls.push(path);return calls.length===1?Array.from({length:50},(_,i)=>zone(i+1)):[zone(51),{...zone(52),status:'pending'}];});
 assert.equal(result.length,51);assert.match(calls[1],/page=2/);
});
test('empty results and authorization errors explain recovery and permit cancellation',async()=>{
 for(const api of [async()=>[],async()=>{throw new Error('HTTP 403');}]){
  const output=[];assert.equal(await chooseDomain(api,prompts(['q'],output)),null);
  assert.ok(output.some(line=>line.includes('API token')));
 }
});
test('manual fallback explains identifiers and preserves input',async()=>{
 const z=zone();const output=[];
 const result=await chooseDomain(async()=>[],prompts(['m',z.account.id,z.id,'herdr.example.com'],output));
 assert.deepEqual(result,{account:z.account.id,zone:z.id,hostname:'herdr.example.com'});
 assert.ok(output.some(line=>line.includes('not your login email')));
});
test('back from prefix returns to domain choice without selecting resources',async()=>{
 assert.equal(await chooseDomain(async()=>[zone()],prompts(['1','q','q'])),null);
});
