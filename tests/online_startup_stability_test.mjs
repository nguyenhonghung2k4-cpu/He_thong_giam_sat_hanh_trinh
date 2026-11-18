// Pure synthetic startup/lease checks. No real tunnel, key, config, DB or cloud.
import assert from 'node:assert/strict';
import { registerAndVerify,maintainPortal,runWasReplaced,retryDelayMs,tunnelConnectionReady,VERSION } from '../WebDashboard_Online/tools/start-online.mjs';

const settings={publicUrl:'https://synthetic-startup.example',connectorSecret:'synthetic-startup-test-key-not-production'};
const runId='synthetic_startup_run_001',upstream='https://synthetic-startup.trycloudflare.com';
const okMarker={ok:true,service:'telematics-online-bridge',version:VERSION,run_id:runId,requires_login:false,access_mode:'public'};
const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
assert(!tunnelConnectionReady('Your quick Tunnel has been created! https://synthetic-startup.trycloudflare.com'));
assert(!tunnelConnectionReady('precheck complete hard_fail=false'));
assert(tunnelConnectionReady('INF Registered tunnel connection connIndex=0 protocol=http2'));
assert.deepEqual([1,2,3,4,9].map(retryDelayMs),[1000,2000,4000,5000,5000]);

let tick=1000,registers=0,access=0,registered=0;
const delays=[],retries=[];
await registerAndVerify(settings,runId,upstream,{
  now:()=>tick,wait:async ms=>{delays.push(ms);tick+=ms;},
  onRegistered:()=>registered++,onRetry:(_error,state)=>retries.push(state),
  fetcher:async url=>{
    if(url.endsWith('/__relay/register')){registers++;return reply({ok:true,lease_expires_at:tick+180000});}
    access++;return access<3?reply({ok:false,code:'pc_offline'},503):reply(okMarker);
  },
});
assert.equal(registers,1,'an accepted run is not rewritten for each transient GET failure');
assert.equal(registered,1);assert.equal(access,3);assert.deepEqual(delays,[1000,2000]);
assert(retries.every(state=>state.registered===true),'retry must not be reported as verified READY');

tick=0;registers=0;const deadlineWaits=[];
await assert.rejects(()=>registerAndVerify(settings,runId,upstream,{
  now:()=>tick,deadlineMs:2000,wait:async ms=>{deadlineWaits.push(ms);tick+=ms;},
  fetcher:async()=>{registers++;return reply({ok:false,code:'bridge_health_failed'},502);},
}),error=>error.code==='bridge_health_failed');
assert.equal(registers,2);assert.deepEqual(deadlineWaits,[1000,1000],'retries stay within the deadline');

let conflictCalls=0;const conflicts=[];
const result=await maintainPortal(settings,runId,upstream,{
  wait:async ms=>conflicts.push(ms),fetcher:async url=>{
    assert(url.endsWith('/__relay/heartbeat'),'CAS retry does not register or steal a run');
    return ++conflictCalls<3?reply({ok:false,code:'registry_changed'},409):reply({ok:true});
  },
});
assert.equal(result.reconnected,false);assert.equal(conflictCalls,3);assert.deepEqual(conflicts,[250,500]);
await assert.rejects(()=>maintainPortal(settings,runId,upstream,{
  wait:async()=>{},fetcher:async()=>reply({ok:false,code:'registry_changed'},409),
}),error=>error.code==='registry_changed'&&!runWasReplaced(error));
assert(!runWasReplaced({status:409,code:'lease_expired'}));
assert(runWasReplaced({status:409,code:'retired_run'}));
assert(runWasReplaced({status:409,code:'stale_run'}));
await assert.rejects(()=>registerAndVerify(settings,runId,upstream,{
  fetcher:async url=>url.endsWith('/__relay/register')?reply({ok:true}):reply({...okMarker,run_id:'synthetic_newer_run_001'}),
  wait:async()=>assert.fail('a replaced run must not keep retrying'),
}),error=>runWasReplaced(error));
console.log('PASS startup stability: connected tunnel gate, bounded exponential retries, single registration through transient verification failures, same-run CAS heartbeat retries, exact stale-run stop, no fake readiness. Synthetic only.');
