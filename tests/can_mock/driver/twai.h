#pragma once
#include <cstdint>
#include <esp_err.h>
using gpio_num_t=int;
constexpr int TWAI_MODE_NORMAL=0;
enum twai_state_t{TWAI_STATE_STOPPED,TWAI_STATE_RUNNING,TWAI_STATE_BUS_OFF,TWAI_STATE_RECOVERING};
constexpr uint32_t TWAI_ALERT_BUS_OFF=1,TWAI_ALERT_BUS_RECOVERED=2,TWAI_ALERT_RX_QUEUE_FULL=4,TWAI_ALERT_BUS_ERROR=8,TWAI_ALERT_ERR_PASS=16;
struct twai_general_config_t{int tx_io,rx_io,mode;uint32_t rx_queue_len,tx_queue_len,alerts_enabled;};
struct twai_timing_config_t{int bitrate;};
struct twai_filter_config_t{uint32_t acceptance_code,acceptance_mask;bool single_filter;};
struct twai_status_info_t{
  twai_state_t state=TWAI_STATE_STOPPED;
  uint32_t msgs_to_tx=0,msgs_to_rx=0,tx_error_counter=0,rx_error_counter=0,tx_failed_count=0;
  uint32_t rx_missed_count=0,rx_overrun_count=0,arb_lost_count=0,bus_error_count=0;
};
struct twai_message_t{uint32_t identifier=0;uint8_t data_length_code=0,data[8]{};bool extd=false,rtr=false;};
#define TWAI_GENERAL_CONFIG_DEFAULT(tx,rx,mode) {(tx),(rx),(mode),5,5,0}
#define TWAI_TIMING_CONFIG_500KBITS() {500000}
#define TWAI_FILTER_CONFIG_ACCEPT_ALL() {0,0xFFFFFFFF,true}
esp_err_t twai_driver_install(const twai_general_config_t*,const twai_timing_config_t*,const twai_filter_config_t*);
esp_err_t twai_start();
esp_err_t twai_stop();
esp_err_t twai_clear_receive_queue();
esp_err_t twai_read_alerts(uint32_t*,uint32_t);
esp_err_t twai_get_status_info(twai_status_info_t*);
esp_err_t twai_initiate_recovery();
esp_err_t twai_receive(twai_message_t*,uint32_t);
