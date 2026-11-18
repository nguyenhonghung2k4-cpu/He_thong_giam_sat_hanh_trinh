import { DEVICE_PATHS, sha256Hex, signRelay } from './protocol.js';
import { serveMapTile } from './map-tiles.js';

export const PUBLIC_ORIGIN = 'https://giam-sat-hanh-trinh-hh-2026.pleasantgoldfish16.chatgpt.site';
export const VERSION = '11.6.1';
export const REGISTRY_KEY = 'hht-relay/upstream-v1.json';
const LEASE_MS = 180000, CACHE_MS = 2000, HEALTH_TIMEOUT_MS = 5000;
const BODY_LIMIT = 256 * 1024, CONTROL_LIMIT = 4096;
const RUN = /^[A-Za-z0-9_-]{8,100}$/;
const MUTATIONS = new Set(['POST','DELETE','PUT','PATCH']);
const METHODS = new Set(['GET','HEAD','POST','DELETE','PUT','PATCH']);
const HOP = new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade']);

class RelayError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export function validateUpstream(value) {
  if (typeof value !== 'string' || value.length > 253 || !/^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.trycloudflare\.com\/?$/.test(value))
    throw new RelayError(422,'invalid_upstream','Địa chỉ kết nối không hợp lệ.');
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.port || u.username || u.password || u.pathname !== '/' || u.search || u.hash)
    throw new RelayError(422,'invalid_upstream','Địa chỉ kết nối không hợp lệ.');
  return u.origin;
}
function originFor(env) {
  const value = env.PUBLIC_ORIGIN || PUBLIC_ORIGIN, u = new URL(value);
  if (u.protocol !== 'https:' || u.origin !== value) throw new Error('Invalid public origin configuration.');
  return value;
}
function baseHeaders() {
  return { 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff',
    // Public map tiles need an origin Referer; never disclose paths or queries.
    'Referrer-Policy':'strict-origin-when-cross-origin', 'X-Frame-Options':'DENY' };
}
function json(status, payload, extra = {}) {
  return new Response(JSON.stringify(payload), { status, headers:{...baseHeaders(),'Content-Type':'application/json; charset=utf-8',...extra} });
}
function offline(pathname, reason = 'pc_offline') {
  if (pathname.startsWith('/api/') || pathname.startsWith('/__relay/'))
    return json(503,{ok:false,online:false,code:reason,error:'Máy tính chạy hệ thống đang ngoại tuyến. Hãy mở START_ONLINE.bat trên máy tính.'},{'Retry-After':'3'});
  const html = `<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hệ thống đang ngoại tuyến</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f3f8fb;color:#173349;font:16px/1.6 system-ui,sans-serif}main{max-width:560px;padding:28px}h1{font-size:27px;line-height:1.3}p{color:#567185}button{font:inherit;padding:10px 18px;background:#087f9b;border:0;border-radius:7px;color:white;cursor:pointer}.dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:#d96b30;margin-right:8px}</style><main><p><span class="dot"></span>HỆ THỐNG GIÁM SÁT HÀNH TRÌNH</p><h1>Máy tính chạy hệ thống đang ngoại tuyến</h1><p>Link truy cập này không thay đổi. Mở bộ khởi chạy Online trên máy tính và giữ máy có Internet. Trang sẽ tự kiểm tra lại; không hiển thị dữ liệu xe cũ như dữ liệu trực tiếp.</p><button onclick="location.reload()">Thử kết nối lại</button><p id="state" role="status">Đang chờ máy tính kết nối…</p></main><script>async function retry(){try{const r=await fetch('/__relay/status',{cache:'no-store'});const s=await r.json();if(s.online){location.reload();return}}catch{}setTimeout(retry,3000)}setTimeout(retry,3000)</script></html>`;
  return new Response(html,{status:503,headers:{...baseHeaders(),'Content-Type':'text/html; charset=utf-8','Retry-After':'3',
    'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"}});
}
async function bytesOf(request, limit) {
  const declared = request.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new RelayError(413,'body_too_large','Yêu cầu quá lớn.');
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader(), chunks=[]; let size=0;
  try {
    for (;;) {
      const {value,done}=await reader.read(); if(done)break;
      size+=value.byteLength; if(size>limit)throw new RelayError(413,'body_too_large','Yêu cầu quá lớn.');
      chunks.push(value);
    }
  } catch(error) { await reader.cancel().catch(()=>{}); throw error; }
  finally { reader.releaseLock(); }
  const body = new Uint8Array(size); let offset=0;
  for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength;}
  return body;
}
async function equalSecret(actual, expected) {
  if (typeof expected !== 'string' || expected.length < 32 || !actual || actual.length > 1024) return false;
  const encoder=new TextEncoder(), a=new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(actual))),
    b=new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(expected)));
  let difference=0; for(let i=0;i<a.length;i++)difference|=a[i]^b[i];return difference===0;
}
function validState(value) {
  if (!value || !RUN.test(value.run_id || '') || !Number.isSafeInteger(value.lease_expires_at)) return null;
  if (value.upstream !== null) { try { value.upstream=validateUpstream(value.upstream); } catch { return null; } }
  return {...value, retired_runs:Array.isArray(value.retired_runs)?value.retired_runs.filter(id=>RUN.test(id)).slice(-32):[]};
}

export function createRelay({ now = Date.now, fetcher = (...args)=>fetch(...args), headerTimeoutMs = 12000 } = {}) {
  // Only completed plain data may survive between Worker invocations. Pending
  // R2/fetch promises belong to the invocation that created them; sharing one
  // can strand every later caller when its owner is canceled.
  let registryCache=null, revision=0, healthCache=null;
  const current = state => Boolean(state?.upstream && state.lease_expires_at > now());
  async function readRegistry(env, force = false) {
    if (!env.BUCKET) throw new RelayError(503,'relay_not_configured','Cổng truy cập chưa được cấu hình.');
    if (!force && registryCache && registryCache.until > now()) return registryCache.row;
    const before=revision;
    const object=await env.BUCKET.get(REGISTRY_KEY);
    const state=object ? validState(await object.json()) : null;
    const row={state,etag:object?.etag || null};
    if (revision===before) registryCache={row,until:now()+CACHE_MS};
    return row;
  }
  async function writeRegistry(env, row, state) {
    const condition=row.etag?{etagMatches:row.etag}:new Headers({'If-None-Match':'*'});
    const result=await env.BUCKET.put(REGISTRY_KEY,JSON.stringify(state),{onlyIf:condition,httpMetadata:{contentType:'application/json'}});
    if(!result)throw new RelayError(409,'registry_changed','Phiên kết nối đã thay đổi; thử lại.');
    revision++;registryCache={row:{state,etag:result.etag},until:now()+CACHE_MS};healthCache=null;
  }
  async function signedHeaders(secret, {method,path,origin,runId,body,purpose='proxy'}) {
    const fields={purpose,method,path,origin,runId,timestamp:String(now()),bodyHash:await sha256Hex(body)};
    return { 'x-hht-relay-time':fields.timestamp,'x-hht-relay-run':runId,'x-hht-relay-origin':origin,
      'x-hht-relay-signature':await signRelay(secret,fields) };
  }
  async function probe(env,state,origin,force=false) {
    if(!current(state))return false;
    const cacheKey=state.run_id+'|'+state.upstream;
    if(!force&&healthCache?.key===cacheKey&&healthCache.until>now())return healthCache.ok;
    return await (async()=>{
      const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),HEALTH_TIMEOUT_MS);
      let ok=false;
      try {
        const headers=await signedHeaders(env.CONNECTOR_SECRET,{purpose:'health',method:'GET',path:'/__relay/health',origin,runId:state.run_id,body:new Uint8Array()});
        const response=await fetcher(state.upstream+'/__relay/health',{method:'GET',headers,redirect:'manual',cache:'no-store',signal:controller.signal});
        if(response.status===200){
          const data=JSON.parse(new TextDecoder().decode(await bytesOf(response,4096)));
          // Allow the previous authenticated bridge during a rolling patch.
          ok=data.ok===true&&data.service==='telematics-pc-bridge'&&['11.6.0',VERSION].includes(data.version)&&data.run_id===state.run_id;
        }else await response.body?.cancel();
      }catch{ok=false;}finally{clearTimeout(timer);}
      healthCache={key:cacheKey,ok,until:now()+CACHE_MS};return ok;
    })();
  }
  async function control(request,env,url,origin) {
    if(request.method!=='POST')return json(405,{ok:false,code:'method_not_allowed'},{Allow:'POST'});
    const auth=request.headers.get('authorization') || '';
    if(!auth.startsWith('Bearer ')||!await equalSecret(auth.slice(7),env.CONNECTOR_SECRET))return json(401,{ok:false,code:'connector_auth_required'});
    if(!String(request.headers.get('content-type')||'').toLowerCase().startsWith('application/json'))return json(415,{ok:false,code:'json_required'});
    let data;try{data=JSON.parse(new TextDecoder().decode(await bytesOf(request,CONTROL_LIMIT)));}catch(error){if(error instanceof RelayError)throw error;throw new RelayError(400,'invalid_json','Yêu cầu JSON không hợp lệ.');}
    if(!data || !RUN.test(data.run_id || ''))throw new RelayError(422,'invalid_run_id','Phiên kết nối không hợp lệ.');
    const row=await readRegistry(env,true), before=row.state;
    if(url.pathname==='/__relay/register') {
      const upstream=validateUpstream(data.upstream);
      if(before?.retired_runs.includes(data.run_id))throw new RelayError(409,'retired_run','Phiên cũ không thể đăng ký lại.');
      const next={upstream,run_id:data.run_id,lease_expires_at:now()+LEASE_MS,
        retired_runs:[...(before?.retired_runs || []),...(before&&before.run_id!==data.run_id?[before.run_id]:[])].slice(-32)};
      if(!await probe(env,next,origin,true))throw new RelayError(502,'bridge_health_failed','Chưa xác nhận được kết nối tới máy tính.');
      // Probe time is not charged against the new connector's lease.
      next.lease_expires_at=now()+LEASE_MS;
      await writeRegistry(env,row,next);
      return json(200,{ok:true,service:'telematics-cloud-portal',version:VERSION,run_id:next.run_id,lease_expires_at:next.lease_expires_at});
    }
    if(!before || before.run_id!==data.run_id)throw new RelayError(409,'stale_run','Phiên kết nối đã được thay thế.');
    if(url.pathname==='/__relay/heartbeat') {
      if(!current(before))throw new RelayError(409,'lease_expired','Phiên hết hạn; đăng ký kết nối lại.');
      const next={...before,lease_expires_at:now()+LEASE_MS};await writeRegistry(env,row,next);
      return json(200,{ok:true,run_id:next.run_id,lease_expires_at:next.lease_expires_at});
    }
    await writeRegistry(env,row,{...before,upstream:null,lease_expires_at:0});
    return json(200,{ok:true,run_id:before.run_id,online:false});
  }
  async function proxy(request,env,url,origin,state) {
    const body=await bytesOf(request,BODY_LIMIT), path=url.pathname+url.search;
    const headers=new Headers(await signedHeaders(env.CONNECTOR_SECRET,{method:request.method,path,origin,runId:state.run_id,body}));
    for(const name of ['accept','accept-language','content-type','if-none-match','if-modified-since','range','user-agent'])
      if(request.headers.has(name))headers.set(name,request.headers.get(name));
    if(MUTATIONS.has(request.method)||request.headers.has('origin'))headers.set('origin',origin);
    headers.set('sec-fetch-site','same-origin');
    const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),headerTimeoutMs);
    let upstream;
    try {
      upstream=await fetcher(state.upstream+path,{method:request.method,headers,body:['GET','HEAD'].includes(request.method)?undefined:body,
        redirect:'manual',cache:'no-store',signal:controller.signal});
    }catch{
      healthCache={key:state.run_id+'|'+state.upstream,ok:false,until:now()+CACHE_MS};
      return offline(url.pathname,'pc_unreachable');
    }finally{
      // Header timeout must not truncate a large, actively streaming SD export.
      clearTimeout(timer);
    }
    const responseHeaders=new Headers();
    for(const [name,value] of upstream.headers) {
      if(HOP.has(name)||name==='set-cookie'||name.startsWith('access-control-')||name.startsWith('x-hht-'))continue;
      responseHeaders.set(name,value);
    }
    const location=responseHeaders.get('location');
    if(location){
      const target=new URL(location,state.upstream);
      if(target.origin!==state.upstream){await upstream.body?.cancel();return json(502,{ok:false,code:'upstream_redirect_denied'});}
      responseHeaders.set('location',target.pathname+target.search+target.hash);
    }
    for(const [name,value] of Object.entries(baseHeaders()))responseHeaders.set(name,value);
    return new Response(upstream.body,{status:upstream.status,statusText:upstream.statusText,headers:responseHeaders});
  }
  return {async fetch(request,env,ctx){
    let url;
    try {
      url=new URL(request.url);const origin=originFor(env);
      // Visible map tiles do not traverse the PC/tunnel or share telemetry I/O.
      if(url.pathname.startsWith('/map-tiles/'))return await serveMapTile(request,{fetcher,ctx,origin});
      if(['/__relay/register','/__relay/heartbeat','/__relay/disconnect'].includes(url.pathname))return await control(request,env,url,origin);
      if(!METHODS.has(request.method)||request.headers.has('upgrade'))return json(405,{ok:false,code:'method_not_allowed'});
      if(DEVICE_PATHS.has(url.pathname))return json(403,{ok:false,code:'device_endpoint_not_public'});
      if(url.pathname==='/api/stream')return json(409,{ok:false,code:'use_http_polling'});
      if(url.pathname.startsWith('/__relay/')&&!['/__relay/status','/__relay/health'].includes(url.pathname))return json(404,{ok:false,code:'not_found'});
      if(MUTATIONS.has(request.method)&&
        (request.headers.get('origin')!==origin||request.headers.get('sec-fetch-site')==='cross-site'))
        return json(403,{ok:false,code:'cross_origin_denied'});
      const {state}=await readRegistry(env);
      if(['/__relay/status','/__relay/health'].includes(url.pathname)) {
        if(request.method!=='GET')return json(405,{ok:false,code:'method_not_allowed'},{Allow:'GET'});
        const online=current(state)&&await probe(env,state,origin);
        return json(200,{ok:true,service:'telematics-cloud-portal',version:VERSION,online:Boolean(online),server_now:now(),
          ...(!online?{reason:current(state)?'pc_unreachable':'pc_offline'}:{})});
      }
      if(!current(state))return offline(url.pathname);
      if(!env.CONNECTOR_SECRET || env.CONNECTOR_SECRET.length<32)return offline(url.pathname,'relay_not_configured');
      return await proxy(request,env,url,origin,state);
    }catch(error){
      if(error instanceof RelayError)return json(error.status,{ok:false,code:error.code,error:error.message});
      return offline(url?.pathname || '/api/','relay_unavailable');
    }
  }};
}
export default createRelay();
