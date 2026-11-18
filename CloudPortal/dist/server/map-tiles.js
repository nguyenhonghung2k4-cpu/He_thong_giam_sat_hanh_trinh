// Only the user's current Leaflet viewport is requested. No prefetch, bulk
// download or offline archive. See operations.osmfoundation.org/policies/tiles/.
const TILE_RE=/^\/map-tiles\/(\d{1,2})\/(0|[1-9]\d{0,6})\/(0|[1-9]\d{0,6})\.png$/;
const FALLBACK_TTL=7*24*60*60;
function failure(status,code){return new Response(JSON.stringify({ok:false,code}),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}
export async function serveMapTile(request,{fetcher=fetch,ctx,origin=new URL(request.url).origin,cache=globalThis.caches?.default}={}){
  if(!['GET','HEAD'].includes(request.method))return failure(405,'map_method_not_allowed');
  const url=new URL(request.url),match=TILE_RE.exec(url.pathname);
  if(!match||url.search)return failure(404,'invalid_map_tile');
  const [z,x,y]=match.slice(1).map(Number),bound=2**z;
  if(z>19||x>=bound||y>=bound)return failure(404,'invalid_map_tile');
  const key=new Request(origin+url.pathname,{method:'GET'});
  let cached;
  try{cached=await cache?.match(key);}catch{}
  if(cached)return new Response(request.method==='HEAD'?null:cached.body,{status:cached.status,headers:cached.headers});
  const headers=new Headers({
    'User-Agent':`HanhTrinhSafetyDashboard/11.6.1 (+${origin}/)`,
    // Origin only: identify this map service, never leak GPS/user query strings.
    'Referer':origin+'/', 'Accept':'image/png',
  });
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
  let upstream,bytes;
  try{
    // Workers supports manual/follow, not Node's redirect:'error'. Inspect
    // redirects ourselves so no request can escape the fixed tile origin.
    upstream=await fetcher(`https://tile.openstreetmap.org/${z}/${x}/${y}.png`,{method:'GET',headers,redirect:'manual',signal:controller.signal});
    if(!upstream.ok||!/^image\/png(?:;|$)/i.test(upstream.headers.get('content-type')||'')){
      await upstream.body?.cancel();return failure(502,'map_provider_unavailable');
    }
    // Small bounded PNGs are fully consumed in this invocation before caching.
    const size=Number(upstream.headers.get('content-length'));
    if(size>1024*1024){await upstream.body?.cancel();return failure(502,'map_tile_too_large');}
    bytes=await upstream.arrayBuffer();
    if(bytes.byteLength>1024*1024)return failure(502,'map_tile_too_large');
  }catch{return failure(502,'map_provider_unavailable');}
  finally{clearTimeout(timer);}
  const out=new Headers({'Content-Type':'image/png','X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin'});
  for(const name of ['cache-control','expires','etag','last-modified'])if(upstream.headers.has(name))out.set(name,upstream.headers.get(name));
  if(!out.has('cache-control')&&!out.has('expires'))out.set('Cache-Control',`public, max-age=${FALLBACK_TTL}`);
  const response=new Response(bytes,{status:200,headers:out});
  if(cache&&!/\b(?:no-store|private)\b/i.test(out.get('cache-control')||'')){
    const save=cache.put(key,response.clone()).catch(()=>{});
    if(ctx?.waitUntil)ctx.waitUntil(save);else await save;
  }
  return request.method==='HEAD'?new Response(null,{status:200,headers:out}):response;
}
