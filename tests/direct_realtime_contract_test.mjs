import fs from 'node:fs';import assert from 'node:assert/strict';
const root=new URL('../Arduino/ESP32S3_Telematics/',import.meta.url);
const read=f=>fs.readFileSync(new URL(f,root),'utf8');
const network=read('telemetry_network.cpp'),ino=read('ESP32S3_Telematics.ino'),audio=read('alerts.cpp');
const fast=network.slice(network.indexOf('static void serviceDirectRealtime()'),network.indexOf('static void uploaderTask('));
assert.match(fast,/HttpFlightGuard flight\(true\)/);assert.match(fast,/directrealtime::fresh/);assert.match(fast,/canFreshAtSend/);
assert(!/storageQueue|storageAppendLog|storageQueueEvent/.test(fast),'Motion must never create extra SD records');
assert.match(fast,/WiFiClient client;HTTPClient http;/);assert.match(fast,/http\.end\(\)/);
assert.match(network,/powerAcquireHttp\(compactDirect\?25:HTTP_POWER_ARBITER_TIMEOUT_MS\)/);
assert.match(network,/httpAudioGate=true;\s*directAudioRealtimeAllowed=false/);
assert(audio.indexOf('networkAllowDirectRealtimeForAudio();')>audio.indexOf('delay(AUDIO_AMP_SETTLE_MS);'));
assert.match(audio,/storageEnterAudioCritical/);assert.match(audio,/storageExitAudioCritical/);
assert.match(ino,/directrealtime::due/);assert.match(ino,/snapshot\.captureMs/);
for(const file of ['config.h','config.example.h']){
 const config=read(file);
 assert(/TELEMETRY_PERIOD_MS\s*=\s*1000/.test(config),file+': durable cadence unchanged');
 assert(/AUDIO_PCM_GAIN_PERCENT\s*=\s*100/.test(config),file+': preserve PCM100');
 assert(/11\.6\.1-MARKER-FIFO-FIX/.test(config),file+': current release identity');
}
console.log('PASS realtime source contract: single uploader/socket ownership, fixed latest-only capture, SD isolation, unchanged durable cadence and PCM100, quiet-start then narrow audio exception. Compile/runtime tests separate.');
