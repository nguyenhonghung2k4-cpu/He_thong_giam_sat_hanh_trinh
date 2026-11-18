// Compile the actual queue/admission functions with FreeRTOS/I2S boundary fakes.
// This tests admission truthfulness, not amplifier sound or electrical timing.
import {readFileSync,mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const zig=process.argv[2];assert(zig,'Pass absolute Zig executable path');
const cpp=readFileSync(new URL('../Arduino/ESP32S3_Telematics/alerts.cpp',import.meta.url),'utf8');
const cut=(a,b)=>{const start=cpp.indexOf(a),end=cpp.indexOf(b,start);assert(start>=0&&end>start);return cpp.slice(start,end);};
const declarations=cut('struct AlertRequest {','struct WavView {');
const current=cut('static bool requestIsCurrent(','static uint16_t readU16(');
const finish=cut('static void finishAlert(','static void alertTask(');
const enqueue=cut('static bool enqueueAlert(','}  // namespace');
const direct=cut('bool alertDirectHazard(','void alertAudioSelfTest()');
const program=`
#include <cassert>
#include <cstdint>
#include <cstring>
#include <vector>
#include <cstdio>
constexpr uint8_t ALERT_POTHOLE=1,ALERT_SPEED_BUMP=2,ALERT_OVERSPEED=3;
constexpr uint32_t AUDIO_BOOT_INHIBIT_MS=12000,AUDIO_ALERT_MAX_AGE_MS=12000;
uint32_t now=20000,alertsStartedMs=0;
uint32_t millis(){return now;}
bool i2sReady=true,overspeedWanted=true,scopeCurrent=true,queueFull=false;
bool isOverspeedWanted(){return overspeedWanted;}
void setOverspeedWanted(bool x){overspeedWanted=x;}
bool directDemoAudioCurrent(const char*,uint32_t,double,double,float){return scopeCurrent;}
void *alertQueue=reinterpret_cast<void*>(1);
uint8_t pendingMask=0;
int pendingMux;
#define portENTER_CRITICAL(x) (void)(x)
#define portEXIT_CRITICAL(x) (void)(x)
constexpr int pdTRUE=1;
struct SerialStub{template<class...T>void printf(const char*,T...){};} Serial;
${declarations}
std::vector<AlertRequest> queued;
int xQueueSend(void*,const AlertRequest*r,int wait){assert(wait==0);if(queueFull)return 0;queued.push_back(*r);return pdTRUE;}
${current}
${finish}
${enqueue}
${direct}
int main(){
 assert(enqueueAlert(ALERT_POTHOLE));assert(queued.size()==1);
 assert(!enqueueAlert(ALERT_POTHOLE));assert(queued.size()==1);
 finishAlert(ALERT_POTHOLE);queueFull=true;
 assert(!enqueueAlert(ALERT_POTHOLE));assert(pendingMask==0);queueFull=false;
 i2sReady=false;assert(!enqueueAlert(ALERT_POTHOLE));i2sReady=true;
 alertQueue=nullptr;assert(!enqueueAlert(ALERT_POTHOLE));alertQueue=reinterpret_cast<void*>(1);
 now=100;assert(!enqueueAlert(ALERT_POTHOLE));assert(pendingMask==0);
 now=20000;scopeCurrent=false;assert(!alertDirectHazard(1,"S",1,20,105,10));
 scopeCurrent=true;assert(!alertDirectHazard(3,"S",1,20,105,10));
 assert(alertDirectHazard(1,"S",2,20,105,10));
 const auto request=queued.back();assert(!strcmp(request.directSession,"S")&&request.directPass==2&&request.radius==10);
 assert(requestIsCurrent(request));scopeCurrent=false;assert(!requestIsCurrent(request));scopeCurrent=true;
 assert(remainingAlertWait(request,4000)==150);assert(remainingAlertWait(request,1400)==150);
 assert(remainingAlertWait(request,50)==50);
 AlertRequest normal{};normal.code=1;normal.queuedAtMs=now;
 assert(remainingAlertWait(normal,4000)==4000);
 now+=11970;assert(remainingAlertWait(request,4000)==30);
 now+=30;assert(!requestIsCurrent(request));assert(remainingAlertWait(request,4000)==0);
 normal.code=ALERT_OVERSPEED;normal.queuedAtMs=now;overspeedWanted=false;assert(!requestIsCurrent(normal));
 now=10;normal.code=1;normal.queuedAtMs=UINT32_MAX-20;assert(requestIsCurrent(normal));
 puts("PASS actual audio admission: queue/duplicate/boot/I2S failures return false; scoped cancellation; bounded150ms direct gates; normal waits unchanged; expiry/rollover. Host mocks only.");
}
`;
const dir=mkdtempSync(join(tmpdir(),'audio-admission-')),source=join(dir,'test.cpp'),exe=join(dir,'test.exe');
writeFileSync(source,program);
const build=spawnSync(zig,['c++','-std=c++17','-Wall','-Wextra','-Werror',source,'-o',exe],{encoding:'utf8',windowsHide:true});
assert.equal(build.status,0,build.stderr||build.error?.message);
const run=spawnSync(exe,[],{encoding:'utf8',windowsHide:true});assert.equal(run.status,0,run.stderr||run.error?.message);process.stdout.write(run.stdout);
