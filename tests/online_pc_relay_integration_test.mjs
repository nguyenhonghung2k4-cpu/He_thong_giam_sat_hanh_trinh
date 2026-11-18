// Actual Worker + actual PC bridge with synthetic, loopback-only application.
// The fake transport rewrites only the test trycloudflare hostname to loopback.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRelay,REGISTRY_KEY } from '../CloudPortal/worker/index.js';
import { createOnlineBridge } from '../WebDashboard_Online/online-bridge.mjs';
import { registerAndVerify,maintainPortal } from '../WebDashboard_Online/tools/start-online.mjs';

const origin='https://synthetic-full-relay.example',secret='synthetic-full-relay-key-not-a-production-key';
const runId='synthetic_full_run_0123456789',upstream='https://synthetic-full-relay.trycloudflare.com';
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${server.address().port}`)));
const close=server=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections?.();});
class FakeR2 {
  data=null;etag=null;revision=0;
  async get(key){assert.equal(key,REGISTRY_KEY);if(this.data===null)return null;const value=this.data;return{etag:this.etag,json:async()=>JSON.parse(value)};}
  async put(key,value,options){
    assert.equal(key,REGISTRY_KEY);const condition=options.onlyIf;
    const match=condition instanceof Headers?condition.get('If-Match'):condition?.etagMatches;
    const none=condition instanceof Headers?condition.get('If-None-Match'):condition?.etagDoesNotMatch;
    if((match&&match!==this.etag)||(none==='*'&&this.data!==null))return null;
    this.data=value;this.etag='synthetic-'+(++this.revision);return{etag:this.etag};
  }
}
let calls=0,posted=null;
const app=createServer(async(req,res)=>{
  calls++;const chunks=[];for await(const chunk of req)chunks.push(chunk);
  if(req.url==='/download'){
    res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':65536});res.flushHeaders();
    await new Promise(resolve=>setTimeout(resolve,150));res.write(Buffer.alloc(32768,1));
    await new Promise(resolve=>setTimeout(resolve,150));res.end(Buffer.alloc(32768,2));return;
  }
  if(req.method==='POST'){posted={url:req.url,body:JSON.parse(Buffer.concat(chunks)),origin:req.headers.origin};}
  res.writeHead(200,{'Content-Type':'application/json','Set-Cookie':'APP_COOKIE_MUST_NOT_LEAK=1','Access-Control-Allow-Origin':'*'});
  res.end(JSON.stringify({ok:true,device_id:'synthetic-unit',latest:{road_label:'duong_bang_phang'},path:req.url}));
});
const appBase=await listen(app);
let clock=Date.now();
const bridge=createOnlineBridge({targetUrl:appBase,publicUrl:origin,connectorSecret:secret,runId,now:()=>clock,headerTimeoutMs:100});
const bridgeBase=await listen(bridge),bucket=new FakeR2();
const env={CONNECTOR_SECRET:secret,PUBLIC_ORIGIN:origin,BUCKET:bucket};
const worker=createRelay({now:()=>clock,headerTimeoutMs:100,fetcher:async(url,options)=>{
  const target=new URL(url);assert.equal(target.origin,upstream);
  return fetch(bridgeBase+target.pathname+target.search,options);
}});
const publicFetch=(url,options={})=>worker.fetch(new Request(url,options),env);
const settings={publicUrl:origin,connectorSecret:secret};
try{
  let response=await publicFetch(origin+'/');assert.equal(response.status,503);assert.match(await response.text(),/ngoại tuyến/);
  response=await publicFetch(origin+'/api/dashboard');assert.equal(response.status,503);assert.equal(calls,0);
  response=await publicFetch(origin+'/__relay/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({upstream,run_id:runId})});assert.equal(response.status,401);
  await registerAndVerify(settings,runId,upstream,{fetcher:publicFetch,deadlineMs:1000});
  response=await publicFetch(origin+'/api/access-status');const status=await response.json();
  assert.equal(status.requires_login,false);assert.equal(status.run_id,runId);assert.equal(response.headers.get('set-cookie'),null);
  response=await publicFetch(origin+'/api/dashboard');assert.equal(response.status,200);assert.equal((await response.json()).device_id,'synthetic-unit');
  assert.equal(response.headers.get('set-cookie'),null);assert.equal(response.headers.get('access-control-allow-origin'),null);
  response=await publicFetch(origin+'/api/device-config',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{"synthetic":true}'});
  assert.equal(response.status,200);assert.equal(posted.origin,appBase);assert.equal(posted.body.synthetic,true);
  response=await publicFetch(origin+'/api/device-config',{method:'POST',headers:{Origin:'https://wrong.example','Content-Type':'application/json'},body:'{}'});assert.equal(response.status,403);
  for(const path of ['/api/telemetry','/api/events','/api/device-commands/next','/api/device-commands/result','/api/sd/export-chunk','/api/direct-demo/realtime'])assert.equal((await publicFetch(origin+path)).status,403,path);
  response=await publicFetch(origin+'/download');assert.equal(response.status,200);assert.equal((await response.arrayBuffer()).byteLength,65536,'both relay layers stream past header deadlines');
  clock+=180001;
  response=await publicFetch(origin+'/api/dashboard');assert.equal(response.status,503,'lease loss does not pretend stale server is online');
  const repaired=await maintainPortal(settings,runId,upstream,{fetcher:publicFetch,now:()=>clock,deadlineMs:1000});
  assert.equal(repaired.reconnected,true);
  response=await publicFetch(origin+'/__relay/status');const state=await response.json();assert.equal(state.online,true);assert.equal('upstream'in state,false);
  response=await publicFetch(origin+'/__relay/disconnect',{method:'POST',headers:{Authorization:`Bearer ${secret}`,'Content-Type':'application/json'},body:JSON.stringify({run_id:'older_run_0123456789'})});assert.equal(response.status,409);
  response=await publicFetch(origin+'/__relay/disconnect',{method:'POST',headers:{Authorization:`Bearer ${secret}`,'Content-Type':'application/json'},body:JSON.stringify({run_id:runId})});assert.equal(response.status,200);
  response=await publicFetch(origin+'/api/dashboard');assert.equal(response.status,503);
}finally{await close(bridge);await close(app);}
console.log('PASS actual Worker + actual PC bridge: fixed URL registration/health roundtrip, no browser password, read/control origin rewrite, device-route isolation, streamed file through both layers, lease expiry/recovery and stale-stop protection. Synthetic loopback only; no real tunnel, hardware, production data or cloud mutation.');
