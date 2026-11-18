import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serveMapTile } from '../worker/map-tiles.js';
import { createRelay, PUBLIC_ORIGIN } from '../worker/index.js';
const path='/map-tiles/16/52027/28861.png';
const png=new Uint8Array([137,80,78,71,13,10,26,10]);
class MemoryCache{
  rows=new Map();puts=0;
  async match(key){return this.rows.get(key.url)?.clone();}
  async put(key,response){this.puts++;this.rows.set(key.url,new Response(await response.arrayBuffer(),{headers:response.headers,status:response.status}));}
}
test('visible map tiles are same-origin, bounded and cached without the PC registry',async()=>{
  const cache=new MemoryCache();let requests=0;
  const fetcher=async(url,init)=>{
    requests++;assert.equal(url,'https://tile.openstreetmap.org/16/52027/28861.png');
    const h=new Headers(init.headers);
    assert.match(h.get('User-Agent'),/^HanhTrinhSafetyDashboard\/11\.6\.1/);
    assert.equal(h.get('Referer'),PUBLIC_ORIGIN+'/');
    for(const name of ['cookie','authorization','cache-control','pragma','x-hht-relay-signature'])assert.equal(h.has(name),false);
    assert.equal(init.redirect,'manual','Workers supports manual/follow; redirects must not be followed');
    return new Response(png,{headers:{'content-type':'image/png','cache-control':'public,max-age=3600','etag':'"tile-1"'}});
  };
  const request=()=>new Request(PUBLIC_ORIGIN+path,{headers:{Cookie:'private-do-not-forward'}});
  const first=await serveMapTile(request(),{origin:PUBLIC_ORIGIN,fetcher,cache});
  assert.equal(first.status,200);assert.equal(first.headers.get('cache-control'),'public,max-age=3600');assert.equal(first.headers.get('etag'),'"tile-1"');
  assert.deepEqual(new Uint8Array(await first.arrayBuffer()),png);
  const second=await serveMapTile(request(),{origin:PUBLIC_ORIGIN,fetcher,cache});
  assert.deepEqual(new Uint8Array(await second.arrayBuffer()),png);assert.equal(requests,1);assert.equal(cache.puts,1);
  const relay=createRelay({fetcher});
  const independent=await relay.fetch(request(),{});
  assert.equal(independent.status,200,'map does not wait for lease, R2, private connector or PC');
});
test('tile route is not an open proxy and invalid zoom/coordinates never fetch',async()=>{
  let calls=0;const fetcher=()=>{calls++;throw Error('unexpected fetch');};
  for(const p of ['/map-tiles/20/0/0.png','/map-tiles/1/2/0.png','/map-tiles/1/0/2.png','/map-tiles/1/-1/0.png','/map-tiles/1/0/0.jpg','/map-tiles/1/00/0.png',path+'?url=https://evil.invalid']){
    assert.equal((await serveMapTile(new Request(PUBLIC_ORIGIN+p),{fetcher})).status,404);
  }
  assert.equal((await serveMapTile(new Request(PUBLIC_ORIGIN+path,{method:'POST'}),{fetcher})).status,405);assert.equal(calls,0);
});
test('missing upstream cache metadata receives seven day fallback; private/error responses are not stored',async()=>{
  const cache=new MemoryCache(),request=new Request(PUBLIC_ORIGIN+path);
  const response=await serveMapTile(request,{cache,fetcher:async()=>new Response(png,{headers:{'content-type':'image/png'}})});
  assert.equal(response.headers.get('cache-control'),'public, max-age=604800');assert.equal(cache.puts,1);
  const fresh=new MemoryCache();
  const privateTile=await serveMapTile(request,{cache:fresh,fetcher:async()=>new Response(png,{headers:{'content-type':'image/png','cache-control':'private,no-store'}})});
  assert.equal(privateTile.status,200);assert.equal(fresh.puts,0);
  for(const fake of [()=>new Response('denied',{status:403}),()=>new Response('<html>not a map</html>',{headers:{'content-type':'text/html'}}),()=>new Response(png,{headers:{'content-type':'image/png','content-length':String(2*1024*1024)}}),()=>{throw Error('network');}]){
    const failed=await serveMapTile(request,{cache:fresh,fetcher:async()=>fake()});assert.equal(failed.status,502);assert.equal(failed.headers.get('cache-control'),'no-store');
  }
  assert.equal(fresh.puts,0);
});
