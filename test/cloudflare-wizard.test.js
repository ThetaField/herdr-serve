import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import pty from 'node-pty';

test('successful Wrangler setup remains visible until user acknowledges completion', { timeout: 15000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hs-wizard-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const p = {config:dir,state:join(dir,'state'),configFile:join(dir,'server.env')};
  await mkdir(p.state);
  const binary = join(dir,'cloudflared');
  await writeFile(binary,'#!/bin/sh\necho "cloudflared version 2026.10.0"\n',{mode:0o700});
  await writeFile(p.configFile,`HERDR_SERVE_CLOUDFLARED_BINARY=${binary}\n`);
  const input={account:'a'.repeat(32),zone:'b'.repeat(32),hostname:'herdr.example.com',port:7681,binary,method:'wrangler'};
  const tunnel='12345678-abcd-abcd-abcd-123456789abc';
  await writeFile(join(dir,'cloudflare-deployment.json'),JSON.stringify({version:1,input,name:'herdr-test',tunnel,complete:true}));
  const modulePath=fileURLToPath(new URL('../plugin/cloudflare-setup.js',import.meta.url));
  const script=`
    import { cloudflareSetupWizard } from ${JSON.stringify(modulePath)};
    globalThis.fetch = async url => {
      const path=new URL(url).pathname;
      let result;
      if(path.endsWith('/zones/${input.zone}')) result={name:'example.com',account:{id:'${input.account}'},status:'active'};
      else if(path.endsWith('/dns_records')) result=[{type:'CNAME',content:'${tunnel}.cfargotunnel.com',proxied:true}];
      else if(path.endsWith('/cfd_tunnel')) result=[{id:'${tunnel}',name:'herdr-test',remote_config:true}];
      else if(path.endsWith('/configurations')) result={config:{ingress:[{hostname:'herdr.example.com',service:'http://127.0.0.1:7681'},{service:'http_status:404'}]}};
      else if(path.endsWith('/token')) result='fake-test-token';
      else throw new Error('Unexpected request');
      return new Response(JSON.stringify({success:true,result}));
    };
    await cloudflareSetupWizard(${JSON.stringify(p)}, action => action());
  `;
  const child=pty.spawn(process.execPath,['--input-type=module','-e',script],{cols:120,rows:40,env:{...process.env,CLOUDFLARE_API_TOKEN:'fake-api-token'}});
  let output='',stage=0,exited=false;
  t.after(()=>{if(!exited)child.kill();});
  const exit=new Promise(resolve=>child.onExit(result=>{exited=true;resolve(result);}));
  let ready;
  const completed=new Promise(resolve=>{ready=resolve;});
  child.onData(chunk=>{
    output+=chunk;
    if(stage===0 && output.includes('[q] Back') && output.includes('> ')){stage=1;child.write('w\r');}
    if(stage===1 && output.includes('Enter deploy to configure Cloudflare')){stage=2;child.write('deploy\r');}
    if(stage===2 && output.includes('独立 Setup 窗口将在返回时关闭。')){stage=3;ready();}
  });
  await Promise.race([completed,exit.then(()=>{throw new Error('Wizard exited before acknowledgment: '+output);})]);
  await new Promise(resolve=>setTimeout(resolve,150));
  assert.equal(exited,false,'success page must remain open');
  assert.match(output,/Setup complete/);
  child.write('\r');
  assert.equal((await exit).exitCode,0);
});
