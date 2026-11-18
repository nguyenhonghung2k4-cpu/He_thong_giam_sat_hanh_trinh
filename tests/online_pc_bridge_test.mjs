// Isolated loopback fixtures only. No real key, user DB, tunnel or cloud Site.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync,mkdirSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOnlineBridge,validPublicOrigin,loadOnlineBridgeSettings } from '../WebDashboard_Online/online-bridge.mjs';
import { signRelay,sha256Hex } from '../CloudPortal/worker/protocol.js';
import { readOnlineSettings,validPort,extractTunnelUrl,maskTunnelUrls,compatibleMain,compatibleBridge,compatiblePortal,findCloudflared,signedHealthHeaders,registerAndVerify,portalRequest,maintainPortal } from '../WebDashboard_Online/tools/start-online.mjs';

const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${server.address().port}`)));
const close=server=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections?.();});
const origin='https://synthetic-portal.example',secret='synthetic-connector-key-not-a-production-secret',runId='synthetic-run-0123456789';
let upstreamCalls=0,observed;
const upstream=createServer(async(req,res)=>{
  upstreamCalls++;const chunks=[];for await(const c of req)chunks.push(c);
  observed={method:req.method,path:req.url,headers:req.headers,body:Buffer.concat(chunks).toString()};
  if(req.url==='/slow-headers'){setTimeout(()=>{res.writeHead(200);res.end('late');},100);return;}
  if(req.url==='/large-download'){
    res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':131072});res.flushHeaders();
    for(let i=0;i<4;i++){await new Promise(resolve=>setTimeout(resolve,30));res.write(Buffer.alloc(32768,i));}res.end();return;
  }
  if(req.url==='/redirect'){res.writeHead(302,{Location:upstreamUrl+'/destination'});res.end();return;}
  res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Set-Cookie':'DO_NOT_FORWARD=1','Referrer-Policy':'same-origin'});
  res.end(JSON.stringify({ok:true,echo:observed}));
});
const upstreamUrl=await listen(upstream);
let clock=Date.now();
const bridge=createOnlineBridge({targetUrl:upstreamUrl,publicUrl:origin,connectorSecret:secret,runId,now:()=>clock,headerTimeoutMs:50});
const base=await listen(bridge);
async function signed(path,{method='GET',body='',signedPath=path,headers={},timestamp=clock,signatureKey=secret,signedRun=runId,purpose=path==='/__relay/health'?'health':'proxy'}={}){
  const bytes=Buffer.from(body);
  const signature=await signRelay(signatureKey,{purpose,method,path:signedPath,origin,runId:signedRun,timestamp:String(timestamp),bodyHash:await sha256Hex(bytes)});
  return fetch(base+path,{method,redirect:'manual',headers:{'x-hht-relay-time':String(timestamp),'x-hht-relay-run':signedRun,'x-hht-relay-origin':origin,'x-hht-relay-signature':signature,...(!['GET','HEAD','OPTIONS'].includes(method)?{Origin:origin}:{}),...headers},body:method==='GET'||method==='HEAD'?undefined:bytes});
}
try{
  assert.equal((await fetch(base+'/')).status,403,'raw tunnel is not an unauthenticated back door');
  let response=await signed('/__relay/health');assert.equal(response.status,200);assert.equal((await response.json()).service,'telematics-pc-bridge');
  response=await signed('/api/access-status');const status=await response.json();
  assert.equal(response.headers.get('referrer-policy'),'strict-origin-when-cross-origin','external map tiles receive the public origin as Referer');
  assert.equal(status.requires_login,false);assert.equal(status.access_mode,'public');assert.equal(status.authenticated,false);assert.equal(status.run_id,runId);
  assert.equal(upstreamCalls,0,'bridge status is not a backend side effect');
  response=await signed('/api/dashboard?device_id=synthetic',{headers:{Authorization:'Bearer BROWSER_MUST_NOT_PASS',Cookie:'private=1','OAI-Sites-Authorization':'Bearer MUST_NOT_PASS','oai-authenticated-user-id':'private-id'}});
  assert.equal(response.status,200);assert.equal(response.headers.get('access-control-allow-origin'),null);assert.equal(response.headers.get('set-cookie'),null);
  assert.equal(response.headers.get('referrer-policy'),'strict-origin-when-cross-origin','a restrictive legacy upstream header must not override public map tile policy');
  let data=await response.json();assert.equal(data.echo.path,'/api/dashboard?device_id=synthetic');
  for(const h of ['authorization','cookie','oai-sites-authorization','oai-authenticated-user-id','x-hht-relay-signature'])assert.equal(data.echo.headers[h],undefined);
  response=await signed('/api/device-config',{method:'POST',body:'{"test":true}',headers:{'Content-Type':'application/json'}});data=await response.json();
  assert.equal(data.echo.headers.origin,upstreamUrl);assert.equal(data.echo.headers.host,new URL(upstreamUrl).host);assert.equal(data.echo.headers['sec-fetch-site'],'same-origin');
  assert.equal(data.echo.body,'{"test":true}');
  for(const path of ['/api/telemetry','/api/events','/api/direct-demo/realtime','/api/device-commands/next','/api/device-commands/result','/api/sd/export-chunk'])assert.equal((await signed(path)).status,403,path);
  assert.equal((await signed('/api/stream')).status,409);
  assert.equal((await signed('/api/device-config',{method:'POST',body:'{}',headers:{Origin:'https://wrong.example'}})).status,403);
  assert.equal((await signed('/api/dashboard',{signatureKey:'another-synthetic-key-not-the-correct-key'})).status,403);
  assert.equal((await signed('/api/dashboard',{signedRun:'previous-run'})).status,403);
  assert.equal((await signed('/api/dashboard',{signedPath:'/api/other'})).status,403);
  assert.equal((await signed('/api/dashboard',{timestamp:clock-31000})).status,403);
  assert.equal((await signed('/api/dashboard',{timestamp:clock+6000})).status,403);
  response=await signed('/large-download');assert.equal(response.status,200);assert.equal((await response.arrayBuffer()).byteLength,131072,'a streamed download outlives the header timeout');
  response=await signed('/slow-headers');assert.equal(response.status,502,'only the header wait times out');
  response=await signed('/redirect');assert.equal(response.status,302);assert.equal(response.headers.get('location'),'/destination');
  const before=upstreamCalls;response=await signed('/api/device-config',{method:'POST',body:'x'.repeat(256*1024+1)});assert.equal(response.status,413);assert.equal(upstreamCalls,before);
}finally{await close(bridge);await close(upstream);}

assert.equal(validPublicOrigin(origin+'/'),origin);
for(const value of ['http://example.com','https://example.com/path','https://a:b@example.com','https://example.com:444','https://example.com/?secret=x'])assert.throws(()=>validPublicOrigin(value));
for(const value of [0,-1,65536,1.2,'x'])assert.throws(()=>validPort(value));
assert.equal(validPort('3000'),3000);
assert.equal(extractTunnelUrl('log https://correct-name.trycloudflare.com |'),'https://correct-name.trycloudflare.com');
assert.equal(extractTunnelUrl('https://correct-name.trycloudflare.com.attacker.example'),null);
assert(!maskTunnelUrls('log https://correct-name.trycloudflare.com').includes('correct-name'));
assert(compatibleMain({ok:true,service:'telematics-dashboard',patch_version:'11.6.1',live_poll:true}));
assert(!compatibleMain({ok:true,service:'telematics-dashboard',patch_version:'11.5.4',live_poll:true}));
assert(compatibleBridge({ok:true,service:'telematics-pc-bridge',version:'11.6.1',run_id:runId},runId));
assert(compatiblePortal({ok:true,service:'telematics-online-bridge',version:'11.6.1',run_id:runId,requires_login:false,access_mode:'public'},runId));
assert(!compatiblePortal({ok:true,service:'telematics-online-bridge',version:'11.6.1',run_id:'old',requires_login:false,access_mode:'public'},runId));
const folder=mkdtempSync(join(tmpdir(),'telematics-online-pc-settings-'));
writeFileSync(join(folder,'config.local.json'),JSON.stringify({port:3001}));
writeFileSync(join(folder,'online.config.json'),JSON.stringify({publicUrl:origin}));
writeFileSync(join(folder,'online.private.json'),JSON.stringify({connectorSecret:secret}));
assert.equal(readOnlineSettings(folder,{}).bridgePort,3002);
assert.equal(loadOnlineBridgeSettings(folder,{ONLINE_RUN_ID:runId}).targetUrl,'http://127.0.0.1:3001');
assert.throws(()=>readOnlineSettings(folder,{PORT:'3001',ONLINE_BRIDGE_PORT:'3001'}));
mkdirSync(join(folder,'tools','bin'),{recursive:true});writeFileSync(join(folder,'tools','bin',process.platform==='win32'?'cloudflared.exe':'cloudflared'),'not-executed-test-placeholder');
assert(findCloudflared(folder,{PATH:''}));assert.throws(()=>findCloudflared(folder,{CLOUDFLARED_PATH:'relative.exe'}));
const healthHeaders=await signedHealthHeaders({publicUrl:origin,connectorSecret:secret},runId,clock);assert.equal(healthHeaders['x-hht-relay-run'],runId);

let attempts=0,registered=0,tick=0;const requested=[];
const fakeFetch=async(url,options)=>{
  requested.push({url,options});
  if(url.endsWith('/__relay/register')){
    assert.equal(options.headers.Authorization,`Bearer ${secret}`);assert.equal(JSON.parse(options.body).run_id,runId);
    if(attempts++===0)return new Response(JSON.stringify({ok:false,code:'bridge_not_ready'}),{status:502});
    return new Response(JSON.stringify({ok:true}));
  }
  return new Response(JSON.stringify({ok:true,service:'telematics-online-bridge',version:'11.6.1',run_id:runId,requires_login:false,access_mode:'public'}));
};
await registerAndVerify({publicUrl:origin,connectorSecret:secret},runId,'https://synthetic.trycloudflare.com',{fetcher:fakeFetch,now:()=>tick,wait:async ms=>{tick+=ms;},onRegistered:()=>registered++});
assert.equal(attempts,2);assert.equal(registered,1);assert.equal(requested.at(-1).url,origin+'/api/access-status','READY requires the fixed URL round trip');
await assert.rejects(()=>portalRequest({publicUrl:origin,connectorSecret:secret},'/__relay/heartbeat',{run_id:runId},{fetcher:async()=>new Response('not-json')}),/JSON/);
let leaseCalls=0;
const recovered=await maintainPortal({publicUrl:origin,connectorSecret:secret},runId,'https://synthetic.trycloudflare.com',{fetcher:async(url,options)=>{
  if(url.endsWith('/__relay/heartbeat'))return new Response(JSON.stringify({ok:false,code:'lease_expired'}),{status:409});
  leaseCalls++;return fakeFetch(url,options);
}});
assert.equal(recovered.reconnected,true);assert.equal(leaseCalls,2);
await assert.rejects(()=>maintainPortal({publicUrl:origin,connectorSecret:secret},runId,'https://synthetic.trycloudflare.com',{fetcher:async()=>new Response(JSON.stringify({ok:false,code:'stale_run'}),{status:409})}),error=>error.code==='stale_run');
console.log('PASS PC bridge/launcher: signed-only internal access, anonymous fixed-portal status, exact origin/body/path/run/time gates, private device routes, stripped secrets/cookies/CORS, streamed download/header timeout, configured ports, marker checks, retry and fixed-URL readiness. No real tunnel, production database or public data used.');
