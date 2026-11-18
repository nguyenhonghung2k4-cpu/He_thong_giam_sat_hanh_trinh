// Executes the shipped diagnostic sketches with deterministic host driver stubs.
// Does not emulate electrical signalling, TWAI interrupts or a real bus ACK.
#include <cassert>
#include <cstdio>
#include <deque>
#include <vector>
#include <Arduino.h>
#include <driver/gpio.h>
#include <driver/twai.h>
uint32_t mockNow=0;
MockSerial Serial;
static twai_status_info_t mockStatus{};
static uint32_t mockAlerts=0;
static unsigned installCalls=0,startCalls=0,recoveryCalls=0,ampWrites=0;
static esp_err_t installResult=ESP_OK,startResult=ESP_OK,recoveryResult=ESP_OK,transmitResult=ESP_OK;
static std::deque<twai_message_t> received;
static std::vector<twai_message_t> transmitted;
void pinMode(int pin,int mode){assert(pin==7&&mode==OUTPUT);}
void digitalWrite(int pin,int level){assert(pin==7&&level==LOW);++ampWrites;}
esp_err_t gpio_set_level(gpio_num_t pin,int level){assert(pin==7&&level==0);++ampWrites;return ESP_OK;}
esp_err_t twai_driver_install(const twai_general_config_t *g,const twai_timing_config_t *t,const twai_filter_config_t *f){
  ++installCalls;
  assert(g->tx_io==17&&g->rx_io==(TEST_NODE?16:18));
  assert(g->mode==TWAI_MODE_NORMAL&&t->bitrate==500000);
  assert(g->tx_queue_len==4&&g->rx_queue_len==16);
  assert(g->alerts_enabled==(TWAI_ALERT_TX_SUCCESS|TWAI_ALERT_TX_FAILED|TWAI_ALERT_BUS_OFF|TWAI_ALERT_BUS_RECOVERED|TWAI_ALERT_BUS_ERROR));
  assert(f->acceptance_code==0&&f->acceptance_mask==UINT32_MAX&&f->single_filter);
  mockStatus.state=TWAI_STATE_STOPPED;return installResult;
}
esp_err_t twai_start(){++startCalls;if(startResult==ESP_OK)mockStatus.state=TWAI_STATE_RUNNING;return startResult;}
esp_err_t twai_transmit(const twai_message_t *m,uint32_t wait){
  assert(wait==0&&m->ss&&!m->extd&&!m->rtr&&m->data_length_code==8);
  assert(mockStatus.state==TWAI_STATE_RUNNING);
  if(transmitResult==ESP_OK)transmitted.push_back(*m);return transmitResult;
}
esp_err_t twai_read_alerts(uint32_t *out,uint32_t wait){assert(wait==0);*out=mockAlerts;mockAlerts=0;return *out?ESP_OK:ESP_ERR_TIMEOUT;}
esp_err_t twai_get_status_info(twai_status_info_t *out){*out=mockStatus;return ESP_OK;}
esp_err_t twai_initiate_recovery(){++recoveryCalls;if(recoveryResult==ESP_OK)mockStatus.state=TWAI_STATE_RECOVERING;return recoveryResult;}
esp_err_t twai_receive(twai_message_t *out,uint32_t wait){
  assert(wait==0);if(received.empty())return ESP_ERR_TIMEOUT;
  *out=received.front();received.pop_front();return ESP_OK;
}
#if TEST_NODE
#include "../CAN_Isolation_Test/CAN_Node_Only/CAN_Node_Only.ino"
#else
#include "../CAN_Isolation_Test/CAN_S3_Only/CAN_S3_Only.ino"
#endif
static void reset(){
  using namespace canisolation;
  mockNow=0;mockStatus={};mockAlerts=0;installCalls=startCalls=recoveryCalls=ampWrites=0;
  installResult=startResult=recoveryResult=transmitResult=ESP_OK;received.clear();transmitted.clear();Serial.output.clear();
  installed=starting=recoveryStarted=haveEcho=recoveryAttempted=restartAttempted=outstanding=false;
  lastSend=lastPrint=lastRecovery=lastRestart=sequence=expectedSequence=lastEchoSequence=0;
  rx=validRx=queued=txOk=txFailed=rejected=lastEcho=lastValid=0;
}
static void at(uint32_t now){mockNow=now;loop();}
static twai_message_t frame(uint32_t id,uint32_t seq){
  twai_message_t m{};m.identifier=id;m.data_length_code=8;
  m.data[0]='C';m.data[1]='A';m.data[2]='N';m.data[3]=1;
  for(unsigned i=0;i<4;++i)m.data[4+i]=uint8_t(seq>>(8*i));return m;
}
static void bootAndAlerts(){
  using namespace canisolation;reset();setup();
  assert(installCalls==1&&startCalls==1&&installed&&starting);
  assert(ampWrites==(TEST_NODE?0U:2U));
  assert(!haveEcho&&txOk==0&&validRx==0);
  mockAlerts=TWAI_ALERT_TX_FAILED;at(250);assert(txFailed==1&&txOk==0&&!haveEcho);
  mockAlerts=TWAI_ALERT_TX_SUCCESS;at(300);assert(txOk==1&&!haveEcho&&validRx==0);
  assert(Serial.output.find("QUEUED is not delivered")!=std::string::npos);
  reset();installResult=ESP_ERR_INVALID_STATE;setup();at(1200);
  assert(!installed&&!starting&&startCalls==0&&transmitted.empty());
  assert(Serial.output.find("INIT_FAILED")!=std::string::npos);
}
static void nodeReplyOwnership(){
#if TEST_NODE
  using namespace canisolation;reset();setup();
  received.push_back(frame(ReplyId,0));at(300);assert(!haveEcho&&validRx==0);
  transmitResult=ESP_ERR_TIMEOUT;at(1000);
  assert(sequence==1&&!outstanding&&queued==0&&rejected==1);
  received.push_back(frame(ReplyId,1));at(1100);assert(!haveEcho&&validRx==0);
  transmitResult=ESP_OK;at(2000);
  assert(sequence==2&&outstanding&&queued==1&&transmitted.size()==1&&txOk==0);
  received.push_back(frame(ReplyId,1));received.push_back(frame(RequestId,2));
  auto bad=frame(ReplyId,2);bad.extd=true;received.push_back(bad);
  bad=frame(ReplyId,2);bad.rtr=true;received.push_back(bad);
  bad=frame(ReplyId,2);bad.data_length_code=7;received.push_back(bad);
  bad=frame(ReplyId,2);bad.data[0]='X';received.push_back(bad);
  at(2100);assert(!haveEcho&&validRx==0&&outstanding);
  received.push_back(frame(ReplyId,2));at(2200);
  assert(haveEcho&&validRx==1&&!outstanding&&lastEchoSequence==2&&lastEcho==2200);
  received.push_back(frame(ReplyId,2));at(2300);assert(validRx==1&&lastEcho==2200);
  at(3000);assert(outstanding&&sequence==3);
  at(4000);assert(outstanding&&sequence==4);
  received.push_back(frame(ReplyId,3));at(4100);assert(validRx==1&&outstanding);
  at(5000);assert(Serial.output.find("STALE_NO_RECENT_ECHO")!=std::string::npos);
  received.push_back(frame(ReplyId,5));at(5100);assert(validRx==2&&lastEchoSequence==5);
#endif
}
static void s3EchoOnlyValidRequests(){
#if !TEST_NODE
  using namespace canisolation;reset();setup();at(5000);assert(transmitted.empty());
  received.push_back(frame(ReplyId,9));auto bad=frame(RequestId,9);bad.data[3]=2;received.push_back(bad);
  bad=frame(RequestId,9);bad.rtr=true;received.push_back(bad);
  at(5100);assert(validRx==0&&transmitted.empty());
  received.push_back(frame(RequestId,12345));at(5200);
  assert(validRx==1&&queued==1&&txOk==0&&transmitted.size()==1);
  assert(isTest(transmitted[0],ReplyId)&&frameSequence(transmitted[0])==12345);
  transmitResult=ESP_ERR_TIMEOUT;received.push_back(frame(RequestId,12346));at(5300);
  assert(validRx==2&&queued==1&&rejected==1&&txOk==0);
#endif
}
static void boundedRecovery(){
  using namespace canisolation;reset();setup();at(1000);
  mockStatus.state=TWAI_STATE_BUS_OFF;recoveryResult=ESP_ERR_INVALID_STATE;at(1200);
  assert(recoveryCalls==1&&!recoveryStarted);
  at(1202);at(2199);assert(recoveryCalls==1);
  recoveryResult=ESP_OK;at(2200);assert(recoveryCalls==2&&recoveryStarted);
  const auto priorTx=transmitted.size();at(3000);assert(transmitted.size()==priorTx);
  mockStatus.state=TWAI_STATE_STOPPED;startResult=ESP_ERR_INVALID_STATE;at(3200);
  assert(startCalls==2&&restartAttempted);
  at(3202);at(4199);assert(startCalls==2);
  startResult=ESP_OK;at(4200);
  assert(startCalls==3&&!recoveryStarted&&!recoveryAttempted&&!restartAttempted&&!outstanding);
#if TEST_NODE
  received.push_back(frame(ReplyId,1));at(4300);assert(!haveEcho&&validRx==0);
  at(5199);assert(transmitted.size()==priorTx);at(5200);assert(transmitted.size()==priorTx+1);
#endif
  // Rate-limit arithmetic continues working across the uint32 millis wrap.
  mockNow=UINT32_MAX-500U;mockStatus.state=TWAI_STATE_BUS_OFF;recoveryResult=ESP_ERR_INVALID_STATE;loop();
  const unsigned before=recoveryCalls;at(498);assert(recoveryCalls==before);
  at(499);assert(recoveryCalls==before+1);
}
int main(){
  bootAndAlerts();nodeReplyOwnership();s3EchoOnlyValidRequests();boundedRecovery();
  std::printf("PASS: CAN isolation %s actual sketch; normal ACK mode, pins, single-shot, reply ownership, bounded recovery (mock driver only).\n",TEST_NODE?"NODE":"S3");
}
