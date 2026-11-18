#include <cassert>
#include <deque>
#include <initializer_list>
#include <limits>
#include "can_mock/Arduino.h"
#include "can_mock/driver/twai.h"

uint32_t mockNow=100;
MockSerial Serial;
bool mockTaskCreateSucceeds=false,mockYieldFromWorker=false;
unsigned mockTaskCreateCalls=0;
void (*mockTaskEntry)(void*)=nullptr;
static twai_status_info_t mockStatus;
static std::deque<twai_message_t> mockFrames;
static std::deque<esp_err_t> installResults,startResults,stopResults,clearResults,recoveryResults,statusResults;
static unsigned installCalls=0,startCalls=0,stopCalls=0,clearCalls=0,recoveryCalls=0,statusCalls=0,receiveCalls=0;
static unsigned raceOnStatusCall=0,recoveredOnStatusCall=0,queuedOnStatusCall=0;
static bool mockInstalled=false,busOffDuringStop=false;
static uint32_t mockAlerts=0,receiveAdvanceMs=0;
static esp_err_t alertResult=ESP_ERR_TIMEOUT,statusResult=ESP_OK,receiveResult=ESP_OK;

static esp_err_t nextResult(std::deque<esp_err_t> &results){
  if(results.empty())return ESP_OK;
  const esp_err_t result=results.front();results.pop_front();return result;
}
esp_err_t twai_driver_install(const twai_general_config_t *g,const twai_timing_config_t *t,const twai_filter_config_t *f){
  ++installCalls;
  assert(g->tx_io==17&&g->rx_io==18&&g->mode==TWAI_MODE_NORMAL);
  assert(g->rx_queue_len==64&&g->tx_queue_len==0&&t->bitrate==500000);
  assert(g->alerts_enabled==(TWAI_ALERT_BUS_OFF|TWAI_ALERT_BUS_RECOVERED|TWAI_ALERT_RX_QUEUE_FULL|TWAI_ALERT_BUS_ERROR|TWAI_ALERT_ERR_PASS));
  assert(f->acceptance_code==0&&f->acceptance_mask==0xFFFFFFFF&&f->single_filter);
  const esp_err_t result=nextResult(installResults);
  if(result!=ESP_OK)return result;
  assert(!mockInstalled);mockInstalled=true;mockStatus.state=TWAI_STATE_STOPPED;return ESP_OK;
}
esp_err_t twai_start(){
  ++startCalls;
  const esp_err_t result=nextResult(startResults);
  if(result!=ESP_OK)return result;
  assert(mockInstalled&&mockStatus.state==TWAI_STATE_STOPPED);
  // ESP-IDF start clears queued RX frames. Preserve TEC/REC in this mock so
  // persistent physical faults continue exercising the restart cooldown.
  mockFrames.clear();mockStatus.state=TWAI_STATE_RUNNING;return ESP_OK;
}
esp_err_t twai_stop(){
  ++stopCalls;
  if(busOffDuringStop){busOffDuringStop=false;mockStatus.state=TWAI_STATE_BUS_OFF;return ESP_ERR_INVALID_STATE;}
  const esp_err_t result=nextResult(stopResults);
  if(result!=ESP_OK)return result;
  assert(mockInstalled&&mockStatus.state==TWAI_STATE_RUNNING);
  mockStatus.state=TWAI_STATE_STOPPED;return ESP_OK;
}
esp_err_t twai_clear_receive_queue(){
  ++clearCalls;
  const esp_err_t result=nextResult(clearResults);
  if(result==ESP_OK)mockFrames.clear();
  return result;
}
esp_err_t twai_read_alerts(uint32_t *out,uint32_t timeout){assert(timeout==0);*out=mockAlerts;mockAlerts=0;return alertResult;}
esp_err_t twai_get_status_info(twai_status_info_t *out){
  ++statusCalls;
  if(statusCalls==raceOnStatusCall)mockStatus.state=TWAI_STATE_BUS_OFF;
  if(statusCalls==recoveredOnStatusCall)mockStatus.rx_error_counter=mockStatus.tx_error_counter=0;
  if(statusCalls==queuedOnStatusCall){
    twai_message_t m{};m.identifier=0x100;m.data_length_code=8;m.data[0]=1;mockFrames.push_back(m);
  }
  const esp_err_t queuedResult=nextResult(statusResults);
  if(queuedResult!=ESP_OK)return queuedResult;
  if(statusResult!=ESP_OK)return statusResult;
  *out=mockStatus;out->msgs_to_rx=uint32_t(mockFrames.size());return ESP_OK;
}
esp_err_t twai_initiate_recovery(){
  ++recoveryCalls;assert(mockStatus.state==TWAI_STATE_BUS_OFF);
  const esp_err_t result=nextResult(recoveryResults);
  if(result==ESP_OK)mockStatus.state=TWAI_STATE_RECOVERING;
  return result;
}
esp_err_t twai_receive(twai_message_t *out,uint32_t timeout){
  ++receiveCalls;assert(timeout==0);
  if(receiveResult!=ESP_OK)return receiveResult;
  if(mockFrames.empty())return ESP_ERR_TIMEOUT;
  if(mockStatus.state!=TWAI_STATE_RUNNING)return ESP_ERR_INVALID_STATE;
  *out=mockFrames.front();mockFrames.pop_front();mockNow+=receiveAdvanceMs;return ESP_OK;
}

// Test the shipped implementation, not a copied recovery algorithm.
#include "../Arduino/ESP32S3_Telematics/can_bus.cpp"

// Production is a process singleton. Reset private state ONLY between cases;
// test actions use public APIs or the captured production worker entrypoint.
static void reset(uint32_t now=100,bool worker=false){
  mockNow=now;Serial=MockSerial();mockStatus=twai_status_info_t();mockFrames.clear();
  installResults.clear();startResults.clear();stopResults.clear();clearResults.clear();recoveryResults.clear();statusResults.clear();
  installCalls=startCalls=stopCalls=clearCalls=recoveryCalls=statusCalls=receiveCalls=0;
  raceOnStatusCall=recoveredOnStatusCall=queuedOnStatusCall=0;
  mockInstalled=busOffDuringStop=false;mockAlerts=receiveAdvanceMs=0;
  alertResult=ESP_ERR_TIMEOUT;statusResult=receiveResult=ESP_OK;
  mockTaskCreateSucceeds=worker;mockYieldFromWorker=false;mockTaskCreateCalls=0;mockTaskEntry=nullptr;
  canWorkerHandle=nullptr;canSnapshotMux=portMUX_INITIALIZER_UNLOCKED;
  workerEcu=EcuData();publishedEcu=EcuData();workerDiagnostics=CanDiagnostics();publishedDiagnostics=CanDiagnostics();
  beginCalled=false;lastInitAttempt=lastRecoveryAttempt=lastStatusPoll=0;recoveryPending=false;
  serviceClockStarted=passiveObserved=passiveRestartPending=passiveRestartAttempted=false;
  queueFlushRequired=false;
  lastServiceCompleted=passiveSince=runningSince=lastPassiveRestart=0;
  runtimeLayout=RuntimeLayout::SpeedX100Adc;legacyEvidence=speedEvidence=speedValidFrames=0;
}
static void frame(uint32_t id,std::initializer_list<uint8_t> bytes,bool remote=false,bool extended=false){
  assert(bytes.size()<=8);
  twai_message_t m{};m.identifier=id;m.data_length_code=uint8_t(bytes.size());m.rtr=remote;m.extd=extended;
  size_t n=0;for(uint8_t v:bytes)m.data[n++]=v;mockFrames.push_back(m);
}
static void heartbeat(){frame(0x100,{1,2,1,0,7,0,0,0});}
static void runtime(){frame(0x101,{0x50,0x46,0xFF,0x0F,0x30,2,0x53,2});}
static void temperature(){frame(0x102,{0xA5,0x0B,0,1});}
static void validSet(){heartbeat();runtime();temperature();}
static void workerStep(){
  assert(mockTaskEntry);mockYieldFromWorker=true;Serial.writesAllowed=false;
  bool yielded=false;
  try{mockTaskEntry(nullptr);}catch(const MockWorkerYield &){yielded=true;}
  Serial.writesAllowed=true;mockYieldFromWorker=false;assert(yielded);
}
static void pollAfter(EcuData &e,uint32_t elapsed){mockNow+=elapsed;canPoll(e);}
static void tickFor(EcuData &e,uint32_t elapsed){
  while(elapsed){const uint32_t step=elapsed>250?250:elapsed;pollAfter(e,step);elapsed-=step;}
}
static void beginRunning(EcuData &e,uint32_t now=100,bool worker=false){
  reset(now,worker);assert(canBegin());assert(installCalls==1&&startCalls==1&&mockTaskCreateCalls==1);
  if(worker)workerStep();
  canPoll(e);
}
static void assertInvalid(const EcuData &e){assert(!e.online&&!e.vehicleSpeedValid&&!e.rpmValid&&!e.overspeed&&!e.temperatureValid);}

static void startupRetryAndDecode(){
  reset();installResults={ESP_ERR_NO_MEM,ESP_OK};startResults={ESP_ERR_INVALID_STATE,ESP_OK};EcuData e;
  assert(!canBegin());assert(installCalls==1);
  mockNow=2099;canPoll(e);assert(installCalls==1);
  mockNow=2100;canPoll(e);assert(installCalls==2&&startCalls==1);
  assert(canGetDiagnostics().installed&&!e.online);
  pollAfter(e,999);assert(startCalls==1);
  mockAlerts=TWAI_ALERT_BUS_RECOVERED;alertResult=ESP_OK;
  pollAfter(e,1);assert(startCalls==2&&canGetDiagnostics().state==TWAI_STATE_RUNNING);
  alertResult=ESP_ERR_TIMEOUT;
  // Short, remote, extended, unknown and malformed frames count as raw RX,
  // but cannot increment valid per-ID counters or make the ECU online.
  runtime();frame(0x100,{1,2,1});frame(0x100,{1,2,1,0,1,0,0,0},true);
  frame(0x100,{1,2,1,0,1,0,0,0},false,true);frame(0x321,{1,2,3,4});
  twai_message_t malformed{};malformed.identifier=0x100;malformed.data_length_code=9;mockFrames.push_back(malformed);
  canPoll(e);assert(!e.online&&!e.vehicleSpeedValid&&e.rxFrameCount==1);
  pollAfter(e,100);validSet();frame(0x103,{9,2,1,0});canPoll(e);
  assert(e.online&&e.uptimeSec==7&&e.vehicleSpeedValid&&e.vehicleSpeedKph==180&&e.overspeed);
  assert(e.temperatureValid&&std::fabs(e.temperatureC-29.81f)<0.001f);
  assert(e.dtcCode==9&&e.dtcSeverity==2&&e.dtcActive);
  const CanDiagnostics d=canGetDiagnostics();assert(d.rejectedRx==5&&d.rawRx==10&&e.rxFrameCount==5);
  assert(d.idRx[0]==1&&d.idRx[1]==2&&d.idRx[2]==1&&d.idRx[3]==1);
  for(unsigned i=0;i<4;++i)assert(d.lastIdMs[i]==mockNow);
  assert(!d.workerRunning&&d.workerResponsive&&d.serviceSeen&&d.serviceAgeMs==0);
  // A fresh heartbeat must not revive speed whose own ID has gone stale.
  tickFor(e,1500);assert(e.vehicleSpeedValid);
  tickFor(e,1);heartbeat();canPoll(e);assert(e.online&&!e.vehicleSpeedValid&&!e.overspeed);
  tickFor(e,1500);assert(!e.temperatureValid);
  tickFor(e,1501);assertInvalid(e);
  assert(canBegin()&&installCalls==2&&mockTaskCreateCalls==1);
  canPrintDiagnostics(e);assert(Serial.output.find("TEC=")!=std::string::npos);
  assert(Serial.output.find("RX task=FALLBACK")!=std::string::npos);
  assert(Serial.output.find("0x103 count=1")!=std::string::npos);
  std::puts("PASS: install/start retry boundaries, real decoder, per-ID counts and freshness.");
}
static void noAlertBusOffRecovery(){
  EcuData e;beginRunning(e);validSet();canPoll(e);assert(e.online);
  tickFor(e,1000);mockStatus.state=TWAI_STATE_BUS_OFF;pollAfter(e,250);
  assert(recoveryCalls==1&&canGetDiagnostics().state==TWAI_STATE_RECOVERING);assertInvalid(e);
  const uint32_t raw=canGetDiagnostics().rawRx;validSet();pollAfter(e,250);
  assert(canGetDiagnostics().rawRx==raw&&mockFrames.size()==3&&recoveryCalls==1);
  mockStatus.state=TWAI_STATE_STOPPED;pollAfter(e,250);assert(startCalls==1);
  pollAfter(e,500);assert(startCalls==2&&canGetDiagnostics().recoveryStarts==1&&mockFrames.empty());assertInvalid(e);
  runtime();temperature();canPoll(e);assertInvalid(e);
  heartbeat();canPoll(e);assert(e.online&&!e.vehicleSpeedValid&&!e.temperatureValid);
  runtime();temperature();canPoll(e);assert(e.vehicleSpeedValid&&e.temperatureValid);
  assert(canGetDiagnostics().idRx[0]==2&&canGetDiagnostics().idRx[1]==3&&canGetDiagnostics().idRx[2]==3);
  assert(installCalls==1&&mockTaskCreateCalls==1&&stopCalls==0);
  std::puts("PASS: missed-alert BUS_OFF recovery, queue discard and new-heartbeat requirement.");
}
static void quietHealthyAndContinuousPassive(){
  EcuData e;beginRunning(e);tickFor(e,60000);
  assert(stopCalls==0&&startCalls==1&&recoveryCalls==0&&clearCalls==0);
  mockStatus.rx_error_counter=127;mockStatus.tx_error_counter=127;tickFor(e,10000);assert(stopCalls==0);
  mockStatus.rx_error_counter=128;pollAfter(e,250);tickFor(e,2750);assert(stopCalls==0);
  mockStatus.rx_error_counter=0;pollAfter(e,250);assert(stopCalls==0);
  mockStatus.tx_error_counter=128;pollAfter(e,250);tickFor(e,2750);assert(stopCalls==0);
  pollAfter(e,250);assert(stopCalls==1&&startCalls==2&&canGetDiagnostics().passiveRestarts==1);
  assert(installCalls==1&&mockTaskCreateCalls==1);
  std::puts("PASS: healthy silence never resets; passive requires 3 continuous seconds at TEC/REC >=128.");
}
static void passiveProgressAndMillisecondBoundary(){
  EcuData e;beginRunning(e);mockStatus.rx_error_counter=128;pollAfter(e,250);
  // Even rejected IDs prove physical RX progress and inhibit passive restart.
  for(unsigned n=0;n<24;++n){frame(0x321,{1,2,3,4});pollAfter(e,250);}
  assert(stopCalls==0&&canGetDiagnostics().rawRx==24&&canGetDiagnostics().rejectedRx==24);
  // Receiving across a millis() boundary must not underflow noRxAge.
  receiveAdvanceMs=1;frame(0x321,{1,2,3,4});pollAfter(e,250);receiveAdvanceMs=0;
  assert(stopCalls==0&&canGetDiagnostics().lastRxMs==mockNow);
  tickFor(e,2750);assert(stopCalls==0);pollAfter(e,250);
  assert(stopCalls==1&&canGetDiagnostics().passiveRestarts==1);
  std::puts("PASS: raw RX progress inhibits reset, including receive crossing a millisecond boundary.");
}
static void passiveCooldownAndWrap(){
  // First restart happens before wrap; its 15-second cooldown expires after it.
  EcuData e;beginRunning(e,std::numeric_limits<uint32_t>::max()-6000);
  mockStatus.rx_error_counter=128;pollAfter(e,250);tickFor(e,2750);assert(stopCalls==0);
  pollAfter(e,250);assert(stopCalls==1&&startCalls==2);const uint32_t first=mockNow;
  tickFor(e,14750);assert(stopCalls==1&&uint32_t(mockNow-first)==14750);
  pollAfter(e,250);assert(stopCalls==2&&startCalls==3&&uint32_t(mockNow-first)==15000);
  const CanDiagnostics d=canGetDiagnostics();assert(d.passiveRestartAttempts==2&&d.passiveRestarts==2&&d.workerResponsive);
  assert(clearCalls==0&&installCalls==1&&mockTaskCreateCalls==1);
  std::puts("PASS: passive restart cooldown and service clocks remain correct across uint32 millis wrap.");
}
static void passiveRestartInvalidatesHeartbeatAndRetriesStart(){
  EcuData e;beginRunning(e);validSet();canPoll(e);const uint32_t frames=e.rxFrameCount;
  mockStatus.rx_error_counter=128;pollAfter(e,250);tickFor(e,2750);
  startResults={ESP_ERR_INVALID_STATE,ESP_OK};pollAfter(e,250);
  assert(stopCalls==1&&startCalls==2&&canGetDiagnostics().state==TWAI_STATE_STOPPED);assertInvalid(e);
  assert(canGetDiagnostics().passiveRestartAttempts==1&&canGetDiagnostics().passiveRestarts==0);
  validSet();tickFor(e,750);assert(startCalls==2&&mockFrames.size()==3);
  pollAfter(e,250);assert(startCalls==3&&mockFrames.empty()&&canGetDiagnostics().passiveRestarts==1);assertInvalid(e);
  assert(e.rxFrameCount==frames&&canGetDiagnostics().idRx[0]==1);
  mockStatus.rx_error_counter=0;runtime();temperature();canPoll(e);assertInvalid(e);
  heartbeat();canPoll(e);assert(e.online&&!e.vehicleSpeedValid&&!e.temperatureValid);
  runtime();temperature();canPoll(e);assert(e.vehicleSpeedValid&&e.temperatureValid);
  assert(e.rxFrameCount==frames+5&&installCalls==1&&mockTaskCreateCalls==1);
  std::puts("PASS: failed passive start retries safely, preserves counters and requires fresh heartbeat.");
}
static void passiveStateRacesAndFailures(){
  EcuData e;beginRunning(e);mockStatus.rx_error_counter=128;pollAfter(e,250);tickFor(e,2750);
  raceOnStatusCall=statusCalls+2;pollAfter(e,250);
  assert(stopCalls==0&&startCalls==1); // Pre-stop status changed to BUS_OFF.
  pollAfter(e,250);assert(recoveryCalls==1&&canGetDiagnostics().state==TWAI_STATE_RECOVERING);
  assertInvalid(e);
  beginRunning(e);mockStatus.rx_error_counter=128;pollAfter(e,250);tickFor(e,2750);
  busOffDuringStop=true;pollAfter(e,250);
  assert(stopCalls==1&&startCalls==1&&canGetDiagnostics().passiveRestarts==0);
  assert(canGetDiagnostics().lastError==ESP_ERR_INVALID_STATE);
  pollAfter(e,250);assert(recoveryCalls==1&&canGetDiagnostics().state==TWAI_STATE_RECOVERING);assertInvalid(e);
  beginRunning(e);mockStatus.rx_error_counter=128;pollAfter(e,250);tickFor(e,2750);
  stopResults={ESP_ERR_INVALID_STATE,ESP_OK};pollAfter(e,250);
  assert(stopCalls==1&&startCalls==1&&canGetDiagnostics().passiveRestartAttempts==1);
  tickFor(e,14750);assert(stopCalls==1);pollAfter(e,250);
  assert(stopCalls==2&&startCalls==2&&canGetDiagnostics().passiveRestartAttempts==2&&canGetDiagnostics().passiveRestarts==1);
  std::puts("PASS: pre-stop BUS_OFF race, stop-time race and failed-stop cooldown do not flood driver APIs.");
}
static void workerLivenessAndStaleQueue(){
  EcuData e;reset(100,true);assert(canBegin());
  assert(!canGetDiagnostics().serviceSeen&&!canGetDiagnostics().workerResponsive);
  const unsigned receives=receiveCalls;validSet();canPoll(e);
  assert(receiveCalls==receives&&!e.online&&mockFrames.size()==3); // No second owner.
  workerStep();canPoll(e);assert(e.online&&e.vehicleSpeedValid&&e.temperatureValid);
  CanDiagnostics d=canGetDiagnostics();assert(d.workerRunning&&d.workerResponsive&&d.serviceCycles==1&&d.lastServiceMs==100);
  mockNow+=1000;assert(canGetDiagnostics().workerResponsive);
  mockNow+=1;d=canGetDiagnostics();assert(d.workerRunning&&!d.workerResponsive&&d.serviceAgeMs==1001);
  canPrintDiagnostics(e);assert(Serial.output.find("RX task=STALE")!=std::string::npos);
  assert(Serial.output.find("CAN service stalled")!=std::string::npos);
  validSet();workerStep();canPoll(e);assertInvalid(e);
  d=canGetDiagnostics();assert(d.queueFlushes==1&&d.rawRx==3&&d.idRx[0]==1&&d.serviceCycles==2&&d.workerResponsive);
  assert(mockFrames.empty()&&clearCalls==1&&installCalls==1&&mockTaskCreateCalls==1);
  runtime();temperature();workerStep();canPoll(e);assertInvalid(e);
  heartbeat();workerStep();canPoll(e);assert(e.online&&!e.vehicleSpeedValid&&!e.temperatureValid);
  runtime();temperature();workerStep();canPoll(e);assert(e.vehicleSpeedValid&&e.temperatureValid);
  assert(canGetDiagnostics().idRx[0]==2&&canGetDiagnostics().idRx[1]==3&&canGetDiagnostics().idRx[2]==3);
  std::puts("PASS: actual worker entrypoint is Serial-free, liveness is age-based and stalled queues are discarded.");
}
static void preStopRechecksQueueCountersAndStatus(){
  EcuData e;beginRunning(e);mockStatus.rx_error_counter=128;pollAfter(e,250);tickFor(e,2750);
  // An ISR can enqueue RX after the draining loop but before the stop check.
  queuedOnStatusCall=statusCalls+2;pollAfter(e,250);
  assert(stopCalls==0&&mockFrames.size()==1&&canGetDiagnostics().rxPending==1);
  pollAfter(e,250);assert(e.online&&mockFrames.empty()&&canGetDiagnostics().idRx[0]==1&&stopCalls==0);
  tickFor(e,2750);assert(stopCalls==0);pollAfter(e,250);assert(stopCalls==1);
  beginRunning(e);mockStatus.rx_error_counter=128;pollAfter(e,250);tickFor(e,2750);
  recoveredOnStatusCall=statusCalls+2;pollAfter(e,250);
  assert(stopCalls==0&&canGetDiagnostics().rxErrorCounter==0);
  tickFor(e,5000);assert(stopCalls==0);
  mockStatus.rx_error_counter=128;pollAfter(e,250);tickFor(e,2750);assert(stopCalls==0);
  pollAfter(e,250);assert(stopCalls==1); // New uninterrupted passive interval.
  beginRunning(e);mockStatus.rx_error_counter=128;pollAfter(e,250);tickFor(e,2750);
  statusResults={ESP_OK,ESP_ERR_INVALID_STATE};pollAfter(e,250);
  assert(stopCalls==0&&canGetDiagnostics().statusErrors==1);
  assert(canGetDiagnostics().lastError==ESP_ERR_INVALID_STATE&&canGetDiagnostics().workerResponsive);
  pollAfter(e,250);assert(stopCalls==1&&canGetDiagnostics().passiveRestarts==1);
  std::puts("PASS: pre-stop recheck cancels restart on newly queued RX, recovered counters or status-query failure.");
}
static void failedBusOffRecoveryIsRateLimited(){
  EcuData e;beginRunning(e);tickFor(e,1000);mockStatus.state=TWAI_STATE_BUS_OFF;
  recoveryResults={ESP_ERR_INVALID_STATE,ESP_OK};pollAfter(e,250);
  assert(recoveryCalls==1&&canGetDiagnostics().state==TWAI_STATE_BUS_OFF);
  assert(canGetDiagnostics().recoveryAttempts==1&&canGetDiagnostics().lastError==ESP_ERR_INVALID_STATE);
  tickFor(e,750);assert(recoveryCalls==1);
  pollAfter(e,250);assert(recoveryCalls==2&&canGetDiagnostics().state==TWAI_STATE_RECOVERING);
  mockStatus.state=TWAI_STATE_STOPPED;tickFor(e,1000);
  assert(startCalls==2&&canGetDiagnostics().recoveryStarts==1&&canGetDiagnostics().recoveryAttempts==3);
  assertInvalid(e);assert(installCalls==1&&mockTaskCreateCalls==1&&stopCalls==0);
  std::puts("PASS: failed BUS_OFF recovery observes the one-second retry interval and keeps one driver owner.");
}
static void failedFlushMustRemainPending(){
  EcuData e;beginRunning(e,100,true);validSet();workerStep();canPoll(e);assert(e.online);
  mockNow+=1001;validSet();clearResults={ESP_ERR_INVALID_STATE,ESP_ERR_INVALID_STATE,ESP_OK};
  const unsigned receives=receiveCalls;
  workerStep();canPoll(e);assertInvalid(e);assert(clearCalls==1&&mockFrames.size()==3&&receiveCalls==receives);
  mockNow+=5;workerStep();canPoll(e);assertInvalid(e);
  assert(clearCalls==2&&mockFrames.size()==3&&receiveCalls==receives&&canGetDiagnostics().receiveErrors==2);
  mockNow+=5;workerStep();canPoll(e);assertInvalid(e);
  assert(clearCalls==3&&mockFrames.empty()&&canGetDiagnostics().queueFlushes==1&&canGetDiagnostics().rawRx==3);
  validSet();workerStep();canPoll(e);assert(e.online&&e.vehicleSpeedValid&&canGetDiagnostics().rawRx==6);
  std::puts("PASS: failed queue flush remains pending; no stale frame is re-dated on following service cycles.");
}
static void errorCountersAndBatchBound(){
  EcuData e;beginRunning(e);alertResult=ESP_ERR_INVALID_STATE;statusResult=ESP_ERR_INVALID_STATE;receiveResult=ESP_ERR_INVALID_STATE;
  pollAfter(e,250);CanDiagnostics d=canGetDiagnostics();assert(d.statusErrors==2&&d.receiveErrors==1&&d.workerResponsive);
  alertResult=ESP_ERR_TIMEOUT;statusResult=receiveResult=ESP_OK;
  mockStatus.rx_missed_count=3;mockStatus.rx_overrun_count=4;mockStatus.bus_error_count=5;
  for(unsigned n=0;n<65;++n)heartbeat();
  pollAfter(e,250);
  d=canGetDiagnostics();assert(d.rawRx==64&&d.idRx[0]==64&&mockFrames.size()==1);
  assert(d.rxMissed==3&&d.rxOverrun==4&&d.busErrors==5);
  canPoll(e);assert(canGetDiagnostics().rawRx==65&&mockFrames.empty());
  std::puts("PASS: driver API errors are observable and a service iteration processes at most 64 frames.");
}
int main(){
  startupRetryAndDecode();noAlertBusOffRecovery();quietHealthyAndContinuousPassive();
  passiveProgressAndMillisecondBoundary();passiveCooldownAndWrap();
  passiveRestartInvalidatesHeartbeatAndRetriesStart();passiveStateRacesAndFailures();
  preStopRechecksQueueCountersAndStatus();failedBusOffRecoveryIsRateLimited();
  workerLivenessAndStaleQueue();failedFlushMustRemainPending();errorCountersAndBatchBound();
  std::puts("PASS: all production CAN host tests (mock TWAI/FreeRTOS; not physical-bus verification).");
}
