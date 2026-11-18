import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRelay, PUBLIC_ORIGIN, REGISTRY_KEY, validateUpstream, VERSION } from '../worker/index.js';
import { DEVICE_PATHS, sha256Hex, signRelay, verifyRelay } from '../worker/protocol.js';

const SECRET='synthetic-connector-key-012345678901234567890';
const U1='https://synthetic-one.trycloudflare.com', U2='https://synthetic-two.trycloudflare.com';
const encoder=new TextEncoder();
class FakeR2 {
  data=null;etag=null;gets=0;puts=0;counter=0;conflict=false;
  async get(key){assert.equal(key,REGISTRY_KEY);this.gets++;const data=this.data,etag=this.etag;return data===null?null:{etag,json:async()=>JSON.parse(data)};}
  async put(key,value,options){
    assert.equal(key,REGISTRY_KEY);this.puts++;
    if(this.conflict){this.conflict=false;return null;}
    const condition=options.onlyIf;
    if(condition instanceof Headers&&condition.get('if-none-match')==='*'&&this.data!==null)return null;
    if(condition.etagMatches&&condition.etagMatches!==this.etag)return null;
    if(condition.etagDoesNotMatch==='*'&&this.data!==null)return null;
    this.data=String(value);this.etag=String(++this.counter);return {etag:this.etag};
  }
  state(){return this.data===null?null:JSON.parse(this.data);}
}
function fixture(options={}) {
  const bucket=new FakeR2(),calls=[];let clock=1000000;
  let behavior=async(url,init)=>new Response(JSON.stringify({ok:true,path:url.pathname}),{headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Set-Cookie':'private=bad','x-hht-relay-signature':'DO_NOT_FORWARD'}});
  let healthBehavior=null;
  const fetcher=async(input,init)=>{
    const url=new URL(input),headers=new Headers(init.headers),body=init.body || new Uint8Array();
    const purpose=url.pathname==='/__relay/health'?'health':'proxy';
    assert.equal(await verifyRelay(SECRET,{purpose,method:init.method,path:url.pathname+url.search,
      origin:headers.get('x-hht-relay-origin'),runId:headers.get('x-hht-relay-run'),timestamp:headers.get('x-hht-relay-time'),
      bodyHash:await sha256Hex(body),signature:headers.get('x-hht-relay-signature')},{now:clock}),true,'bridge receives valid canonical signature');
    assert.equal(init.redirect,'manual');assert.equal(init.cache,'no-store');
    for(const name of ['authorization','cookie','oai-sites-authorization','oai-authenticated-user-id','connection'])assert.equal(headers.has(name),false,'secret/browser header not forwarded');
    calls.push({url,init,headers});
    if(purpose==='health')return healthBehavior?healthBehavior(url,init):new Response(JSON.stringify({ok:true,service:'telematics-pc-bridge',version:VERSION,run_id:headers.get('x-hht-relay-run')}));
    return behavior(url,init);
  };
  const worker=createRelay({now:()=>clock,fetcher,...options}),env={BUCKET:bucket,CONNECTOR_SECRET:SECRET};
  const request=(path,init={})=>worker.fetch(new Request(PUBLIC_ORIGIN+path,init),env);
  const control=(operation,data,authorized=true)=>request('/__relay/'+operation,{method:'POST',headers:{'Content-Type':'application/json',...(authorized?{Authorization:'Bearer '+SECRET}:{})},body:JSON.stringify(data)});
  return {bucket,calls,worker,env,request,control,setBehavior:fn=>behavior=fn,setHealth:fn=>healthBehavior=fn,advance:ms=>clock+=ms,now:()=>clock};
}

test('shared signature contract binds every field and validates age',async()=>{
  const fields={purpose:'proxy',method:'POST',path:'/api/test?q=%E1%BB%95',origin:PUBLIC_ORIGIN,runId:'synthetic-run-one',timestamp:'1000000',bodyHash:await sha256Hex(encoder.encode('ổ gà'))};
  const signature=await signRelay(SECRET,fields);assert.match(signature,/^[a-f0-9]{64}$/);
  assert.equal(await verifyRelay(SECRET,{...fields,signature},{now:1000001}),true);
  for(const patch of [{method:'GET'},{path:'/api/other'},{origin:'https://evil.invalid'},{runId:'other-run'},{bodyHash:'0'.repeat(64)},{purpose:'health'}])
    assert.equal(await verifyRelay(SECRET,{...fields,...patch,signature},{now:1000001}),false);
  assert.equal(await verifyRelay(SECRET,{...fields,signature},{now:1030001}),false);
  assert.equal(await verifyRelay(SECRET,{...fields,signature},{now:994999}),false);
  assert.equal(await verifyRelay(SECRET,{...fields,signature:'x'.repeat(64)},{now:1000000}),false);
  assert.equal(await verifyRelay('short',{...fields,signature},{now:1000000}),false);
  await assert.rejects(()=>signRelay(SECRET,{...fields,path:'/api/test\nmalicious'}));
});

test('upstream validation excludes SSRF targets, redirects, credentials and spoof suffixes',()=>{
  assert.equal(validateUpstream(U1+'/'),U1);
  for(const value of ['http://one.trycloudflare.com','https://127.0.0.1','https://one.trycloudflare.com.evil.invalid','https://evil.invalid@one.trycloudflare.com',U1+':443',U1+'/api',U1+'?x=1',U1+'#x','https://one.trycloudflare.com.','https://a.b.trycloudflare.com','https://-bad.trycloudflare.com'])assert.throws(()=>validateUpstream(value));
});

test('unregistered portal returns honest offline UI and status without private data',async()=>{
  const f=fixture(),html=await f.request('/');assert.equal(html.status,503);assert.match(await html.text(),/Máy tính chạy hệ thống đang ngoại tuyến/);
  const response=await f.request('/api/dashboard');assert.equal(response.status,503);assert.equal((await response.json()).code,'pc_offline');
  const status=await (await f.request('/__relay/status')).json();assert.equal(status.online,false);assert.equal(status.service,'telematics-cloud-portal');
  assert(!JSON.stringify(status).includes('upstream'));assert(!JSON.stringify(status).includes(SECRET));assert.equal(f.calls.length,0);
});

test('map pages retain an origin-only cross-site Referer even if the PC supplied a stricter policy',async()=>{
  const f=fixture(),policy='strict-origin-when-cross-origin';
  assert.equal((await f.request('/')).headers.get('referrer-policy'),policy,'offline page uses the same safe browser policy');
  await f.control('register',{run_id:'synthetic-run-one',upstream:U1});
  f.setBehavior(()=>new Response('<!doctype html><title>Synthetic map</title>',{headers:{'Content-Type':'text/html','Referrer-Policy':'same-origin'}}));
  const page=await f.request('/');
  assert.equal(page.status,200);
  assert.equal(page.headers.get('referrer-policy'),policy,'cloud response overrides old PC policy so OSM tile requests include only the HTTPS portal origin');
});

test('control requires secret and successful matching bridge health before registration',async()=>{
  const f=fixture();assert.equal((await f.control('register',{run_id:'synthetic-run-one',upstream:U1},false)).status,401);
  assert.equal(f.bucket.puts,0);
  f.setHealth(()=>new Response(JSON.stringify({ok:true,service:'telematics-pc-bridge',version:VERSION,run_id:'wrong-run'})));
  assert.equal((await f.control('register',{run_id:'synthetic-run-one',upstream:U1})).status,502);assert.equal(f.bucket.state(),null);
  f.setHealth(null);const registered=await f.control('register',{run_id:'synthetic-run-one',upstream:U1});assert.equal(registered.status,200);
  assert.equal(f.bucket.state().lease_expires_at,f.now()+180000);
  const status=await (await f.request('/__relay/status')).json();assert.equal(status.online,true);
  assert(!JSON.stringify(status).includes(U1));assert(!JSON.stringify(status).includes('synthetic-run-one'));
});

test('all browser functions use signed proxy without a browser password; devices remain private',async()=>{
  const f=fixture();assert.equal((await f.control('register',{run_id:'synthetic-run-one',upstream:U1})).status,200);
  const response=await f.request('/api/live?device_id=synthetic',{headers:{Cookie:'browser=private',Authorization:'Bearer USER_SECRET','OAI-Sites-Authorization':'Bearer SITE_SECRET','oai-authenticated-user-id':'private-user'}});
  assert.equal(response.status,200);assert.equal(response.headers.has('set-cookie'),false);assert.equal(response.headers.has('access-control-allow-origin'),false);assert.equal(response.headers.has('x-hht-relay-signature'),false);
  const body=JSON.stringify({device_id:'synthetic',threshold:12});
  const mutation=await f.request('/api/device-config',{method:'POST',headers:{Origin:PUBLIC_ORIGIN,'Content-Type':'application/json'},body});assert.equal(mutation.status,200);
  const last=f.calls.at(-1);assert.equal(last.headers.get('origin'),PUBLIC_ORIGIN);assert.equal(last.headers.get('sec-fetch-site'),'same-origin');assert.equal(new TextDecoder().decode(last.init.body),body);
  const count=f.calls.length;
  for(const path of DEVICE_PATHS)assert.equal((await f.request(path)).status,403);
  for(const origin of [undefined,'https://evil.invalid','null'])assert.equal((await f.request('/api/routes/start',{method:'POST',headers:{...(origin?{Origin:origin}:{}),'Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await f.request('/api/routes/start',{method:'POST',headers:{Origin:PUBLIC_ORIGIN,'Sec-Fetch-Site':'cross-site'},body:'{}'})).status,403);
  assert.equal((await f.request('/api/stream')).status,409);assert.equal(f.calls.length,count);
});

test('registry cache is bounded and lease expiration never presents stale live data',async()=>{
  const f=fixture();await f.control('register',{run_id:'synthetic-run-one',upstream:U1});
  const gets=f.bucket.gets;for(let i=0;i<20;i++)assert.equal((await f.request('/api/live')).status,200);
  assert.equal(f.bucket.gets,gets,'cached registry prevents one R2 read per motion poll');
  f.advance(180001);assert.equal((await f.request('/api/live')).status,503);
  assert.equal((await (await f.request('/__relay/status')).json()).online,false);
  assert.equal((await f.control('heartbeat',{run_id:'synthetic-run-one'})).status,409);
});

test('restart replaces run; old heartbeat/disconnect/register cannot erase the new connector',async()=>{
  const f=fixture();await f.control('register',{run_id:'synthetic-run-one',upstream:U1});
  f.advance(100);await f.control('register',{run_id:'synthetic-run-two',upstream:U2});
  assert.equal(f.bucket.state().run_id,'synthetic-run-two');assert.equal(f.bucket.state().upstream,U2);
  for(const op of ['heartbeat','disconnect'])assert.equal((await f.control(op,{run_id:'synthetic-run-one'})).status,409);
  assert.equal((await f.control('register',{run_id:'synthetic-run-one',upstream:U1})).status,409);
  f.advance(200);assert.equal((await f.control('heartbeat',{run_id:'synthetic-run-two'})).status,200);assert.equal(f.bucket.state().lease_expires_at,f.now()+180000);
  assert.equal((await f.control('disconnect',{run_id:'synthetic-run-two'})).status,200);assert.equal(f.bucket.state().upstream,null);
  assert.equal((await f.request('/api/live')).status,503);
});

test('R2 compare-and-swap failures leave existing state intact',async()=>{
  const f=fixture();await f.control('register',{run_id:'synthetic-run-one',upstream:U1});const before=f.bucket.data;
  for(const operation of ['heartbeat','disconnect']){f.bucket.conflict=true;assert.equal((await f.control(operation,{run_id:'synthetic-run-one'})).status,409);assert.equal(f.bucket.data,before);}
  f.bucket.conflict=true;assert.equal((await f.control('register',{run_id:'synthetic-run-two',upstream:U2})).status,409);assert.equal(f.bucket.data,before);
});

test('response body streams immediately and header timeout cannot truncate an SD download',async()=>{
  const f=fixture({headerTimeoutMs:5});await f.control('register',{run_id:'synthetic-run-one',upstream:U1});
  let controller,signal;
  f.setBehavior((url,init)=>{signal=init.signal;return new Response(new ReadableStream({start(value){controller=value;value.enqueue(encoder.encode('first-'));}}),{headers:{'Content-Type':'application/octet-stream'}});});
  const response=await Promise.race([f.request('/api/sd/download'),new Promise((_,reject)=>setTimeout(()=>reject(Error('stream was buffered')),100))]);
  await new Promise(resolve=>setTimeout(resolve,20));assert.equal(signal.aborted,false,'header timeout was cleared after response headers');
  controller.enqueue(encoder.encode('last'));controller.close();assert.equal(await response.text(),'first-last');
});

test('upstream errors, foreign redirects and excessive bodies fail closed',async()=>{
  const f=fixture();await f.control('register',{run_id:'synthetic-run-one',upstream:U1});
  f.setBehavior(()=>{throw Error('do not expose internal hostname/secret');});const unavailable=await f.request('/api/live');assert.equal(unavailable.status,503);assert.equal((await unavailable.json()).code,'pc_unreachable');
  f.setBehavior(()=>new Response(null,{status:302,headers:{Location:'https://evil.invalid'}}));assert.equal((await f.request('/api/live')).status,502);
  f.setBehavior(()=>new Response(null,{status:302,headers:{Location:U1+'/safe?q=1'}}));assert.equal((await f.request('/safe')).headers.get('location'),'/safe?q=1');
  assert.equal((await f.request('/api/routes/start',{method:'POST',headers:{Origin:PUBLIC_ORIGIN},body:'x'.repeat(256*1024+1)})).status,413);
  assert.equal((await f.control('register',{run_id:'synthetic-run-one',upstream:U1,padding:'x'.repeat(5000)})).status,413);
});

test('header timeout produces bounded offline response rather than a stuck request',async()=>{
  const f=fixture({headerTimeoutMs:5});await f.control('register',{run_id:'synthetic-run-one',upstream:U1});
  f.setBehavior((url,init)=>new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true})));
  assert.equal((await f.request('/api/live')).status,503);
});

// A canceled invocation must never donate pending I/O to another invocation.
// In Workers that global promise can remain unresolved after its owner ends.
test('a slow registry read cannot hold another request hostage',async()=>{
  const f=fixture();await f.control('register',{run_id:'synthetic-run-one',upstream:U1});f.advance(2001);
  const original=f.bucket.get.bind(f.bucket);let release,entered;
  const began=new Promise(resolve=>entered=resolve);let reads=0;
  f.bucket.get=async key=>{if(++reads===1){entered();await new Promise(resolve=>release=resolve);}return original(key);};
  const first=f.request('/api/live?request=one');await began;
  const second=f.request('/api/live?request=two');let timer;
  try {
    const result=await Promise.race([second,new Promise(resolve=>timer=setTimeout(()=>resolve(null),250))]);
    assert.notEqual(result,null,'independent request must not await an earlier invocation registry promise');
    assert.equal(result.status,200);
  }finally{clearTimeout(timer);release();await Promise.all([first,second]);}
});

test('a slow health probe cannot hold another invocation hostage',async()=>{
  const f=fixture();await f.control('register',{run_id:'synthetic-run-one',upstream:U1});f.advance(2001);
  let release,entered,probes=0;const began=new Promise(resolve=>entered=resolve);
  f.setHealth(async(url,init)=>{
    if(++probes===1){entered();await new Promise(resolve=>release=resolve);}
    return new Response(JSON.stringify({ok:true,service:'telematics-pc-bridge',version:VERSION,run_id:new Headers(init.headers).get('x-hht-relay-run')}));
  });
  const first=f.request('/__relay/status');await began;const second=f.request('/__relay/status');let timer;
  try{
    const result=await Promise.race([second,new Promise(resolve=>timer=setTimeout(()=>resolve(null),250))]);
    assert.notEqual(result,null,'independent request must own its health fetch and timeout');
    assert.equal((await result.json()).online,true);
  }finally{clearTimeout(timer);release();await Promise.all([first,second]);}
});
