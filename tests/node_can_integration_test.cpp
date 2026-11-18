// Compile the actual .ino, not a second implementation of its scheduling logic.
// This is deterministic host simulation, not electrical CAN/ACK validation.
#include <cassert>
#include <vector>
#include "node_can_mock/Arduino.h"
#include "node_can_mock/driver/twai.h"
uint32_t mockNow = 0;
unsigned mockAdcReads = 0;
MockSerial Serial;
#include "../Arduino/NODE_ECU/NODE_ECU.ino"

struct Tx { uint32_t at; twai_message_t message; };
static std::vector<Tx> transmissions;
static twai_status_info_t driverStatus;
static bool installed = false, receiverPresent = true, hardwarePending = false;
static bool pendingSingle = false, emitSuccessOnStop = false;
static uint32_t pendingAt = 0, completionLatency = 1, pendingAlerts = 0;
static unsigned installs = 0, starts = 0, stops = 0, recoveries = 0;
static unsigned failInstalls = 0, failStarts = 0, failStops = 0, failStatusReads = 0, rejectTx = 0;

esp_err_t twai_driver_install(const twai_general_config_t *g,
    const twai_timing_config_t *t, const twai_filter_config_t *f) {
  ++installs;
  assert(g->tx_io == 17 && g->rx_io == 16 && g->mode == TWAI_MODE_NORMAL);
  assert(t->bitrate == 500000 && g->rx_queue_len == 8);
  // One application-owned transfer is also enforced by twai_transmit below.
  assert(g->tx_queue_len == 0);
  assert((g->alerts_enabled & (TWAI_ALERT_TX_SUCCESS | TWAI_ALERT_TX_FAILED)) ==
    (TWAI_ALERT_TX_SUCCESS | TWAI_ALERT_TX_FAILED));
  assert(f->acceptance_code == 0 && f->acceptance_mask == UINT32_MAX);
  if (failInstalls) { --failInstalls; return ESP_ERR_NO_MEM; }
  assert(!installed);
  installed = true; driverStatus.state = TWAI_STATE_STOPPED;
  return ESP_OK;
}
esp_err_t twai_start() {
  ++starts;
  if (failStarts) { --failStarts; return ESP_ERR_INVALID_STATE; }
  assert(installed && driverStatus.state == TWAI_STATE_STOPPED);
  driverStatus.state = TWAI_STATE_RUNNING;
  hardwarePending = false; driverStatus.msgs_to_tx = 0;
  return ESP_OK;
}
esp_err_t twai_stop() {
  ++stops;
  if (failStops) { --failStops; return ESP_ERR_INVALID_STATE; }
  assert(installed && driverStatus.state == TWAI_STATE_RUNNING);
  driverStatus.state = TWAI_STATE_STOPPED;
  hardwarePending = false; driverStatus.msgs_to_tx = 0;
  if (emitSuccessOnStop) pendingAlerts |= TWAI_ALERT_TX_SUCCESS;
  return ESP_OK;
}
esp_err_t twai_transmit(const twai_message_t *message, uint32_t wait) {
  assert(wait == 0 && installed);
  // Controller can enter bus-off between the production 100 ms status polls.
  if (driverStatus.state != TWAI_STATE_RUNNING) return ESP_ERR_INVALID_STATE;
  assert(!hardwarePending && !canTxPolicy.inFlight());
  assert(message->data_length_code == 8 && !message->rtr && !message->extd);
  assert(message->ss); // No unbounded hardware retry, including first heartbeat.
  if (rejectTx) { --rejectTx; return ESP_ERR_TIMEOUT; }
  transmissions.push_back({mockNow, *message});
  hardwarePending = true; pendingAt = mockNow; pendingSingle = message->ss;
  driverStatus.msgs_to_tx = 1;
  return ESP_OK;
}
esp_err_t twai_read_alerts(uint32_t *out, uint32_t wait) {
  assert(wait == 0);
  if (hardwarePending && mockNow - pendingAt >= completionLatency &&
      driverStatus.state == TWAI_STATE_RUNNING && (receiverPresent || pendingSingle)) {
    hardwarePending = false; driverStatus.msgs_to_tx = 0;
    if (receiverPresent) pendingAlerts |= TWAI_ALERT_TX_SUCCESS;
    else { pendingAlerts |= TWAI_ALERT_TX_FAILED; ++driverStatus.tx_failed_count; }
  }
  *out = pendingAlerts; pendingAlerts = 0;
  return *out ? ESP_OK : ESP_ERR_TIMEOUT;
}
esp_err_t twai_get_status_info(twai_status_info_t *out) {
  if (failStatusReads) { --failStatusReads; return ESP_ERR_INVALID_STATE; }
  *out = driverStatus; return ESP_OK;
}
esp_err_t twai_initiate_recovery() {
  ++recoveries;
  assert(driverStatus.state == TWAI_STATE_BUS_OFF);
  driverStatus.state = TWAI_STATE_RECOVERING;
  hardwarePending = false; driverStatus.msgs_to_tx = 0;
  return ESP_OK;
}
esp_err_t twai_receive(twai_message_t *, uint32_t wait) {
  assert(wait == 0); return ESP_ERR_TIMEOUT;
}

static void reset() {
  mockNow = 0; mockAdcReads = 0; Serial.output.clear(); transmissions.clear();
  driverStatus = twai_status_info_t{};
  installed = false; receiverPresent = true; hardwarePending = false;
  pendingSingle = emitSuccessOnStop = false;
  pendingAt = pendingAlerts = 0; completionLatency = 1;
  installs = starts = stops = recoveries = 0;
  failInstalls = failStarts = failStops = failStatusReads = rejectTx = 0;
  ecu = EcuState{}; canTxPolicy = NodeCanTxPolicy{};
  temperaturePending = false; dtcDirty = true;
  canRunning = canRecovering = canInstalled = canBusOffSeen = false;
  temperatureRequestMs = lastRuntimeMs = lastHeartbeatMs = lastTemperatureMs = 0;
  lastDtcMs = lastSerialMs = lastRuntimeTxMs = 0;
  txQueued = txQueueRejected = txAckAlerts = txSingleQueued = txProbeQueued = 0;
  txFailedAlerts = txAborted = canBusOffEvents = canRecoveryAttempts = canRestartAttempts = 0;
  lastCanInitAttemptMs = lastCanRecoveryAttemptMs = lastCanStatusMs = lastCanAbortAttemptMs = 0;
  canRecoverySinceMs=0;canRecoveryClockStarted=false;
  canInitAttempts = 0; canLastError = ESP_OK; canStatus = twai_status_info_t{};
  filteredAdc = 0; adcFilterInitialized = false; speedReadySamples = 0;
  overspeedHighSamples = overspeedClearSamples = temperatureGoodSamples = temperatureBadSamples = 0;
  temperatureConversionCount = 0;
}
static void runFor(uint32_t duration) {
  const uint32_t began = mockNow;
  while (mockNow - began < duration) loop();
}
static unsigned countId(uint32_t id) {
  unsigned count = 0;
  for (const Tx &t : transmissions) if (t.message.identifier == id) ++count;
  return count;
}

static void healthyScheduling() {
  reset(); setup(); runFor(10000);
  assert(installs == 1 && starts == 1 && stops == 0 && recoveries == 0);
  assert(txQueueRejected == 0 && txAborted == 0 && txProbeQueued == 0);
  assert(canTxPolicy.ackFresh(mockNow));
  assert(ecu.speedReady && ecu.temperatureReady && ecu.temperatureValid);
  assert(ecu.speedX100 == 9002 && ecu.temperatureC == 25.0f);
  assert(countId(CAN_ID_HEARTBEAT) == 10);
  assert(countId(CAN_ID_RUNTIME) >= 99);
  assert(countId(CAN_ID_TEMPERATURE) >= 7 && countId(CAN_ID_DTC) >= 7);
  assert(ecu.sequence == countId(CAN_ID_RUNTIME));
  uint32_t previousHeartbeat = 0, previousRuntime = 0;
  for (const Tx &t : transmissions) {
    assert(t.message.ss);
    if (t.message.identifier == CAN_ID_HEARTBEAT) {
      if (previousHeartbeat) assert(t.at - previousHeartbeat <= 1000);
      previousHeartbeat = t.at;
      assert(t.message.data[0] == ECU_NODE_ID && t.message.data[1] == FW_MAJOR);
    }
    if (t.message.identifier == CAN_ID_RUNTIME) {
      if (previousRuntime) assert(t.at - previousRuntime <= 103);
      previousRuntime = t.at;
      assert(t.message.data[6] == 0x53 && t.message.data[7] == 0x02);
    }
  }
}

static void missingReceiverAndReconnect() {
  reset(); receiverPresent = false; setup(); runFor(12000);
  assert(!canTxPolicy.everAcked() && !canTxPolicy.ackFresh(mockNow));
  assert(installs == 1 && stops == 0 && txAborted == 0);
  assert(txSingleQueued == txQueued && txProbeQueued >= 4 && txProbeQueued <= 6);
  assert(ecu.speedReady && ecu.temperatureReady && mockAdcReads >= 120 * 32);
  assert(countId(CAN_ID_RUNTIME) == 0 && countId(CAN_ID_TEMPERATURE) == 0);
  for (size_t i = 0; i < transmissions.size(); ++i) {
    assert(transmissions[i].message.identifier == CAN_ID_HEARTBEAT);
    assert(transmissions[i].message.ss);
    if (i >= 2) assert(transmissions[i].at - transmissions[i - 1].at >= 1000);
  }
  const uint32_t sensorSamples = mockAdcReads;
  receiverPresent = true; runFor(5000);
  assert(canTxPolicy.ackFresh(mockNow) && txSingleQueued > 10);
  assert(countId(CAN_ID_RUNTIME) > 0 && countId(CAN_ID_TEMPERATURE) > 0);
  assert(mockAdcReads > sensorSamples && installs == 1);
}

static void transientRetriesAndStaleCompletions() {
  reset(); completionLatency = 200; setup(); runFor(6000);
  assert(stops == 0 && txAborted == 0 && txProbeQueued == 0);
  assert(canTxPolicy.everAcked() && countId(CAN_ID_HEARTBEAT) >= 5);
  assert(countId(CAN_ID_RUNTIME) > 0 && countId(CAN_ID_TEMPERATURE) > 0);
  reset(); receiverPresent = false; emitSuccessOnStop = true; completionLatency=500;
  setup(); runFor(251);
  assert(stops == 1 && txAborted == 1 && !canTxPolicy.everAcked());
  assert(pendingAlerts == 0 && txAckAlerts == 0); // Abort drain consumed old success.
  pendingAlerts = TWAI_ALERT_TX_SUCCESS; serviceCanAlerts();
  assert(!canTxPolicy.everAcked() && !canTxPolicy.ready());
  runFor(1500);
  assert(!canTxPolicy.everAcked()); // Failed new probe did not revive old ACK.
  reset(); setup(); runFor(1); // Queue the initial heartbeat, then stall the loop.
  mockNow += 10000;
  serviceCanAlerts(); // Driver exposes the coalesced bit only after the stall.
  assert(txAckAlerts == 1 && !canTxPolicy.everAcked());
  assert(!canTxPolicy.ready() && canTxPolicy.probing());
  assert(canTxPolicy.waitRemaining(mockNow) == 500);
  runFor(600);
  assert(canTxPolicy.ackFresh(mockNow)); // Only a new, timely probe proves freshness.
}

static void startupStateAndQueueErrors() {
  reset(); failInstalls = 1; failStarts = 1; setup(); runFor(4200);
  assert(installs == 2 && starts >= 2 && canTxPolicy.ackFresh(mockNow));
  assert(ecu.speedReady && ecu.temperatureReady);
  reset(); rejectTx = 1; setup(); runFor(1600);
  assert(txQueueRejected == 1 && txProbeQueued == 1 && txSingleQueued > 0);
  assert(canTxPolicy.ackFresh(mockNow) && stops == 0);
  reset(); failStatusReads = 1; setup(); runFor(600);
  assert(canRunning && canTxPolicy.ackFresh(mockNow) && installs == 1);
  reset(); receiverPresent = false; failStops = 1; completionLatency=1000; setup(); runFor(600);
  assert(stops == 2 && txAborted == 1 && !canRunning);
  assert(!canTxPolicy.everAcked());
}

static void healthyTransientAndBurstBackoff() {
  reset();setup();runFor(2000);
  const uint32_t ackBefore=txAckAlerts;
  receiverPresent=false;
  while(txFailedAlerts==0)loop();
  assert(canTxPolicy.ready() && canTxPolicy.transientFailures()==1);
  assert(txAckAlerts==ackBefore && stops==0 && txAborted==0);
  receiverPresent=true;runFor(250);
  assert(canTxPolicy.ackFresh(mockNow) && canTxPolicy.transientFailures()==0);
  const uint32_t queuedBefore=txQueued,failuresBefore=txFailedAlerts;
  receiverPresent=false;
  while(txFailedAlerts-failuresBefore<3)loop();
  assert(txQueued-queuedBefore==3 && canTxPolicy.probing());
  assert(canTxPolicy.waitRemaining(mockNow)>0 && stops==0);
  const uint32_t atBackoff=txQueued;
  runFor(400);assert(txQueued==atBackoff);
  receiverPresent=true;runFor(1000);
  assert(canTxPolicy.ackFresh(mockNow) && installs==1 && starts==1 && stops==0);
}

static void stalledRecoveryIsVisibleNotBlindlyReset() {
  reset();setup();runFor(2000);
  driverStatus.state=TWAI_STATE_BUS_OFF;
  hardwarePending=false;driverStatus.msgs_to_tx=0;
  runFor(200);
  assert(canRecovering && canRecoveryClockStarted && recoveries==1);
  const uint32_t queuedBefore=txQueued,samplesBefore=mockAdcReads;
  const uint32_t recoveryBegan=canRecoverySinceMs;
  runFor(6000);
  assert(canRecovering && canRecoverySinceMs==recoveryBegan);
  assert(txQueued==queuedBefore && mockAdcReads>samplesBefore);
  assert(installs==1 && recoveries==1 && starts==1 && stops==0);
  assert(Serial.output.find("STALLED")!=std::string::npos);
  assert(!canTxPolicy.ackFresh(mockNow));
  // Only actual driver completion allows legal start; newest heartbeat ACK is
  // still required. A stalled warning never synthesizes STOPPED or success.
  driverStatus.state=TWAI_STATE_STOPPED;runFor(2000);
  assert(!canRecovering && !canRecoveryClockStarted && starts==2);
  assert(canTxPolicy.ackFresh(mockNow));
}

static void busOffWithoutAlertsAndRollover() {
  reset(); setup(); runFor(800);
  driverStatus.state = TWAI_STATE_BUS_OFF;
  hardwarePending = false; driverStatus.msgs_to_tx = 0;
  runFor(400);
  assert(recoveries == 1 && canRecovering && canBusOffEvents == 1);
  assert(!canTxPolicy.ready());
  driverStatus.state = TWAI_STATE_STOPPED; // Recovery completes without an alert.
  runFor(1500);
  assert(starts == 2 && canTxPolicy.ackFresh(mockNow) && installs == 1);
  reset(); mockNow = UINT32_MAX - 1500U; setup(); runFor(4000);
  assert(canTxPolicy.ackFresh(mockNow) && stops == 0);
  assert(countId(CAN_ID_HEARTBEAT) == 4 && countId(CAN_ID_RUNTIME) >= 39);
}

int main() {
  healthyScheduling();
  missingReceiverAndReconnect();
  transientRetriesAndStaleCompletions();
  startupStateAndQueueErrors();
  busOffWithoutAlertsAndRollover();
  healthyTransientAndBurstBackoff();
  stalledRecoveryIsVisibleNotBlindlyReset();
  std::puts("PASS: actual NODE_ECU.ino single-shot scheduling/fairness, missing receiver, transient/burst faults, reconnect, stop/drain, recovery stall visibility, init/status/queue errors, bus-off and rollover (mock TWAI; no hardware).");
}
