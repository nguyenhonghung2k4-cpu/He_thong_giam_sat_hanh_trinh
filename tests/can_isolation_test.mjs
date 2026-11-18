// Usage: node tests/can_isolation_test.mjs <path-to-zig.exe>
// Builds the actual two diagnostic sketches against temporary host API stubs.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const testDir=path.dirname(fileURLToPath(import.meta.url));
const project=path.dirname(testDir),zig=process.argv[2];
assert(zig,'Pass the path to the Zig compiler as the first argument.');
assert.equal(readFileSync(path.join(project,'CAN_Isolation_Test/CAN_Node_Only/can_isolation.h'),'utf8'),readFileSync(path.join(project,'CAN_Isolation_Test/CAN_S3_Only/can_isolation.h'),'utf8'),'Shared diagnostic headers must be identical');
const work=mkdtempSync(path.join(tmpdir(),'can-isolation-host-'));
mkdirSync(path.join(work,'driver'));
writeFileSync(path.join(work,'Arduino.h'),`#pragma once
#include <cstdint>
#include <cstring>
#include <cstdio>
#include <cstdarg>
#include <string>
using esp_err_t=int;
constexpr esp_err_t ESP_OK=0,ESP_ERR_TIMEOUT=1,ESP_ERR_INVALID_STATE=2;
inline const char* esp_err_to_name(esp_err_t e){return e==ESP_OK?"ESP_OK":e==ESP_ERR_TIMEOUT?"ESP_ERR_TIMEOUT":"ESP_ERR_INVALID_STATE";}
extern uint32_t mockNow;
inline uint32_t millis(){return mockNow;}
inline void delay(uint32_t n){mockNow+=n;}
constexpr int OUTPUT=1,LOW=0;
void pinMode(int,int);void digitalWrite(int,int);
struct MockSerial {std::string output;void begin(unsigned){};void println(const char*s){output+=s;output+='\\n';}
void printf(const char*f,...){char b[2048];va_list a;va_start(a,f);vsnprintf(b,sizeof(b),f,a);va_end(a);output+=b;}};
extern MockSerial Serial;
`);
writeFileSync(path.join(work,'driver/gpio.h'),`#pragma once
#include <Arduino.h>
using gpio_num_t=int;
constexpr gpio_num_t GPIO_NUM_7=7;
esp_err_t gpio_set_level(gpio_num_t,int);
`);
writeFileSync(path.join(work,'driver/twai.h'),`#pragma once
#include <Arduino.h>
#include <driver/gpio.h>
constexpr int TWAI_MODE_NORMAL=0;
enum twai_state_t{TWAI_STATE_STOPPED,TWAI_STATE_RUNNING,TWAI_STATE_BUS_OFF,TWAI_STATE_RECOVERING};
constexpr uint32_t TWAI_ALERT_TX_SUCCESS=1,TWAI_ALERT_TX_FAILED=2,TWAI_ALERT_BUS_OFF=4,TWAI_ALERT_BUS_RECOVERED=8,TWAI_ALERT_BUS_ERROR=16;
struct twai_general_config_t{int tx_io,rx_io,mode;uint32_t tx_queue_len,rx_queue_len,alerts_enabled;};
struct twai_timing_config_t{int bitrate;};
struct twai_filter_config_t{uint32_t acceptance_code,acceptance_mask;bool single_filter;};
struct twai_status_info_t{twai_state_t state=TWAI_STATE_STOPPED;uint32_t tx_error_counter=0,rx_error_counter=0,bus_error_count=0,rx_missed_count=0,rx_overrun_count=0;};
struct twai_message_t{uint32_t identifier=0;uint8_t data_length_code=0,data[8]={};bool extd=false,rtr=false,ss=false;};
#define TWAI_GENERAL_CONFIG_DEFAULT(tx,rx,mode) {(tx),(rx),(mode),5,5,0}
#define TWAI_TIMING_CONFIG_500KBITS() {500000}
#define TWAI_FILTER_CONFIG_ACCEPT_ALL() {0,UINT32_MAX,true}
esp_err_t twai_driver_install(const twai_general_config_t*,const twai_timing_config_t*,const twai_filter_config_t*);
esp_err_t twai_start();
esp_err_t twai_transmit(const twai_message_t*,uint32_t);
esp_err_t twai_read_alerts(uint32_t*,uint32_t);
esp_err_t twai_get_status_info(twai_status_info_t*);
esp_err_t twai_initiate_recovery();
esp_err_t twai_receive(twai_message_t*,uint32_t);
`);
for(const [name,node] of [['node',1],['s3',0]]){
 const exe=path.join(work,`can-isolation-${name}${process.platform==='win32'?'.exe':''}`);
 const compiled=spawnSync(zig,['c++','-std=c++11','-Wall','-Wextra','-Werror',`-DTEST_NODE=${node}`,'-I',work,path.join(testDir,'can_isolation_test.cpp'),'-o',exe],{encoding:'utf8'});
 process.stdout.write(compiled.stdout??'');process.stderr.write(compiled.stderr??'');
 assert.equal(compiled.status,0,`Compile ${name}: ${compiled.error??''}`);
 const ran=spawnSync(exe,[],{encoding:'utf8'});
 process.stdout.write(ran.stdout??'');process.stderr.write(ran.stderr??'');
 assert.equal(ran.status,0,`Run ${name}: ${ran.error??''}`);
}
console.log(`Temporary test artifacts: ${work}`);
