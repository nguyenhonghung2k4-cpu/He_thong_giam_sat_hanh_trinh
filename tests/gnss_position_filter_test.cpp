// Host test: c++ -std=c++11 -Wall -Wextra -Werror gnss_position_filter_test.cpp -o gnss_test
// Runs independently of Arduino, Wi-Fi, the SD card and the dashboard database.
#include <math.h>
// Arduino.h defines this macro before gnss.cpp includes the filter. Keep that
// compatibility covered even in the host-native suite.
#define radians(deg) ((deg) * 0.017453292519943295)
#include "../Arduino/ESP32S3_Telematics/gnss_position_filter.h"
#undef radians
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits>

using navigation::Fix;
using navigation::Output;
using navigation::PositionFilter;
static unsigned checks = 0;
static void require(bool condition, const char *message) {
  ++checks;
  if (!condition) { fprintf(stderr, "FAIL: %s\n", message); exit(1); }
}
static bool state(const Output &o, const char *value) { return strcmp(o.state, value) == 0; }
static Fix sample(uint32_t n, double northM = 0, double eastM = 0, float speed = 0.2f, uint32_t base = 0) {
  Fix f;
  f.lat = 20.90575 + northM / 111194.9266;
  f.lon = 105.8276 + eastM / (111194.9266 * cos(20.90575 * 0.017453292519943295));
  f.speedKph = speed;
  f.hdop = 1.1f;
  f.satellites = 12;
  f.nowMs = base + n * 1000U;
  f.sequence = n;
  f.valid = true;
  return f;
}
static double north(const Output &o) { return (o.lat - 20.90575) * 111194.9266; }
static void lockAtOrigin(PositionFilter &filter, uint32_t base = 0) {
  for (uint32_t n = 0; n <= 6; ++n) filter.update(sample(n, 0, 0, 0.2f, base));
  require(filter.current().valid && filter.current().stationary, "stationary acquisition within six seconds");
}

static void stationaryJitterAndDuplicates() {
  PositionFilter f;
  Fix s = sample(0);
  for (unsigned i = 0; i < 200; ++i) {
    s.nowMs = i * 5;
    require(!f.update(s).valid, "duplicate reads cannot satisfy startup acquisition");
  }
  for (uint32_t n = 1; n <= 7; ++n) f.update(sample(n, n % 2 ? 0.5 : -0.5, n % 3 ? 0.4 : -0.4));
  require(f.current().stationary, "small good-quality jitter reaches stationary state");
  const Output anchor = f.current();
  for (uint32_t n = 8; n < 308; ++n) {
    const Output &o = f.update(sample(n, n % 2 ? 1.0 : -1.0, n % 3 ? 0.8 : -0.8));
    require(o.valid && o.stationary && o.speedKph == 0, "stationary output is valid and zero-speed");
    require(o.lat == anchor.lat && o.lon == anchor.lon, "stationary anchor never creeps for five minutes");
    require(o.epoch == anchor.epoch, "ordinary stationary fixes preserve continuity epoch");
  }
}

static void isolatedJumpAndSpeedSpike() {
  PositionFilter f;
  lockAtOrigin(f);
  const Output anchor = f.current();
  const Output jump = f.update(sample(7, 180, 0, 0.2f));
  require(!jump.valid && state(jump, "rejected") && !jump.segmentValid, "isolated 180 m position jump rejected");
  require(jump.rejected == 1, "outlier diagnostic increments exactly once");
  Fix repeat = sample(7, 180);
  repeat.nowMs += 250;
  f.update(repeat);
  require(f.current().rejected == 1, "duplicate rejected sample not counted twice");
  const Output recovery = f.update(sample(8, 0.4));
  require(recovery.valid && recovery.stationary, "ordinary fix restores stationary anchor");
  require(recovery.lat == anchor.lat && recovery.lon == anchor.lon, "outlier does not move anchor");
  require(!recovery.segmentValid && recovery.epoch != anchor.epoch, "no trip bridge through rejection");
  f.update(sample(9, 4, 0, 30));
  require(f.current().stationary, "single fast-speed fix does not release stationary hold");
  f.update(sample(10, 0.1));
  require(f.current().stationary && f.current().lat == anchor.lat, "spike followed by quiet fix stays anchored");
}

static void resumeAndSlowWalking() {
  PositionFilter fast;
  lockAtOrigin(fast);
  fast.update(sample(7, 5, 0, 18));
  require(fast.current().stationary, "first movement sample is only a candidate");
  fast.update(sample(8, 10, 0, 18));
  require(fast.current().valid && !fast.current().stationary, "two coherent moving fixes resume tracking");
  require(!fast.current().segmentValid, "hold-release displacement not charged as travelled distance");
  fast.update(sample(9, 15, 0, 18));
  require(fast.current().segmentValid, "next good movement has trusted segment");
  require(north(fast.current()) > 14.0, "moving smoothing adds less than one metre at 18 km/h");

  PositionFilter slow;
  lockAtOrigin(slow);
  uint32_t released = 0;
  for (uint32_t n = 7; n <= 40; ++n) {
    const double metres = (n - 6) * 0.4;  // 1.44 km/h below stationary speed threshold.
    slow.update(sample(n, metres, 0, 1.0f));
    if (!slow.current().stationary && slow.current().valid) { released = n; break; }
  }
  require(released != 0 && released <= 27, "coherent slow walking cannot remain locked forever");
  require(north(slow.current()) >= 6.0, "slow release publishes actual resumed position");
  for (uint32_t n = released + 1; n <= 180; ++n) {
    const Output &o = slow.update(sample(n, (n - 6) * 0.4, 0, 1.0f));
    require(o.valid && !o.stationary, "sustained slow walk does not repeatedly relock inside stop radius");
  }

  PositionFilter drifting;
  lockAtOrigin(drifting);
  for (uint32_t n = 7; n <= 20; ++n) drifting.update(sample(n, 7, 0, 0.2f));
  require(drifting.current().stationary && north(drifting.current()) < 0.01,
    "constant shifted cluster without movement evidence does not release hold");
}

static void slowMotionAtDifferentFixRates() {
  // Confirm displacement cumulatively, not PER sample. 0.10 m at 1 Hz and
  // 0.04 m at 10 Hz are both smaller than the significant-step threshold.
  const double stepM[] = {0.10, 0.04};
  const uint32_t intervalMs[] = {1000, 100};
  for (unsigned rate = 0; rate < 2; ++rate) {
    PositionFilter f;
    lockAtOrigin(f);
    bool released = false;
    for (uint32_t n = 1; n <= 250; ++n) {
      Fix move = sample(6 + n, n * stepM[rate], 0, 1.0f);
      move.nowMs = 6000U + n * intervalMs[rate];
      const Output &o = f.update(move);
      require(o.valid, "fresh slow motion remains a valid navigation sample");
      if (!o.stationary) released = true;
      if (released) require(!o.stationary, "slow continuous movement never relocks after release");
      if (n * stepM[rate] >= 8.0) require(released, "sub-20 cm fixes cumulatively release hold before eight metres");
    }
  }
  // Starting the receiver while already walking slowly must not create a
  // repeated stop/release sawtooth before any stationary anchor was obtained.
  PositionFilter startup;
  for (uint32_t n = 0; n <= 90; ++n) {
    const Output &o = startup.update(sample(n, n * 0.4, 0, 1.0f));
    if (n >= 2) require(o.valid && !o.stationary, "coherent low-speed startup is tracked as moving");
  }
}

static void stopAfterMotion() {
  PositionFilter f;
  for (uint32_t n = 0; n <= 9; ++n) f.update(sample(n, n * 4.0, 0, 14.4f));
  require(f.current().valid && !f.current().stationary, "startup may occur in a moving vehicle");
  for (uint32_t n = 10; n <= 17; ++n) f.update(sample(n, 36.0 + (n % 2 ? 0.2 : -0.2), 0, 0.2f));
  require(f.current().stationary, "pause after real motion locks within short confirmation interval");
  const double anchored = f.current().lat;
  f.update(sample(18, 36.7));
  require(f.current().lat == anchored, "stopped coordinate remains fixed");
}

static void invalidStaleReacquisition() {
  PositionFilter f;
  lockAtOrigin(f);
  const uint32_t epoch = f.current().epoch;
  Fix repeat = sample(6);
  repeat.nowMs = 9001;
  require(!f.update(repeat).valid && state(f.current(), "stale"), "same sequence expires after freshness timeout");
  Fix far = sample(10, 800);
  require(!f.update(far).valid, "reconnection far away requires new acquisition");
  f.update(sample(11, 800.4));
  const Output o = f.update(sample(12, 800.1));
  require(o.valid && !o.segmentValid && o.epoch > epoch, "far reacquisition changes epoch with no connecting segment");
  require(north(o) > 799, "reacquisition does not slowly drag old anchor to new position");

  Fix bad = sample(13, 800);
  bad.hdop = 5;
  require(!f.update(bad).valid && state(f.current(), "invalid"), "poor HDOP invalidates navigation immediately");
  f.update(sample(14, 800));
  f.update(sample(15, 800));
  require(f.update(sample(16, 800)).valid && !f.current().segmentValid, "quality recovery requires confirmation and breaks segment");

  PositionFilter gap;
  lockAtOrigin(gap);
  require(!gap.update(sample(50, 20)).valid, "unobserved long gap detected even if no loop calls occurred during gap");
  require(state(gap.current(), "acquiring"), "first fresh fix after long gap starts acquisition");

  // A stale held sample cannot become valid again just by calling update() or
  // changing its speed/quality fields. A genuinely new sequence is required.
  PositionFilter stopped;
  lockAtOrigin(stopped);
  Fix old = sample(6);
  for (uint32_t now = 9001; now <= 11001; now += 100) {
    old.nowMs = now;
    old.speedKph = 6;
    require(!stopped.update(old).valid, "repeated stale fix stays invalid without new receiver location");
  }
  require(!stopped.update(sample(12)).valid, "first returning sample does not bypass reacquisition");
  require(!stopped.update(sample(13)).valid, "second returning sample does not bypass reacquisition");
  require(stopped.update(sample(14)).valid && !stopped.current().segmentValid,
    "third returning sample is valid but does not connect the gap");
}

static void sustainedOutlierRecovery() {
  PositionFilter f;
  lockAtOrigin(f);
  const uint32_t originalEpoch = f.current().epoch;
  for (uint32_t n = 7; n <= 13; ++n) f.update(sample(n, 200 + (n % 2 ? 0.1 : -0.1)));
  require(f.current().valid && north(f.current()) > 199, "coherent changed location recovers rather than rejecting forever");
  require(f.current().epoch > originalEpoch, "recovery identifies discontinuous anchor epoch");
}

static void numericValidationAndWrap() {
  const float nan = std::numeric_limits<float>::quiet_NaN();
  const double inf = std::numeric_limits<double>::infinity();
  for (unsigned which = 0; which < 9; ++which) {
    PositionFilter f;
    lockAtOrigin(f);
    Fix bad = sample(7);
    switch (which) {
      case 0: bad.lat = nan; break;
      case 1: bad.lon = inf; break;
      case 2: bad.speedKph = nan; break;
      case 3: bad.speedKph = -1; break;
      case 4: bad.speedKph = 250; break;
      case 5: bad.hdop = nan; break;
      case 6: bad.satellites = 3; break;
      case 7: bad.lat = 90.1; break;
      case 8: bad.valid = false; break;
    }
    require(!f.update(bad).valid && state(f.current(), "invalid"), "nonfinite/out-of-range/invalid fix cannot reach navigation");
  }
  PositionFilter wrap;
  const uint32_t base = UINT32_MAX - 4000U;
  lockAtOrigin(wrap, base);
  const Output anchor = wrap.current();
  for (uint32_t n = 7; n <= 12; ++n) wrap.update(sample(n, 0.2, 0, 0.2f, base));
  require(wrap.current().valid && wrap.current().stationary && wrap.current().lat == anchor.lat,
    "32-bit millis rollover does not cause artificial movement or staleness");
  Fix repeat = sample(12, 0.2, 0, 0.2f, base);
  repeat.nowMs += 3001;
  require(!wrap.update(repeat).valid, "stale age remains correct across millis wrap");
}

static void roadSpeedLatencyAndGeofence() {
  PositionFilter f;
  // 72 km/h at 1 Hz: a 10 m geofence can be traversed between fixes. The
  // filter cannot guarantee alerts absent raw samples; test added lag only.
  for (uint32_t n = 0; n <= 10; ++n) {
    const Output &o = f.update(sample(n, n * 20.0, 0, 72));
    if (n >= 3) {
      require(o.valid && !o.stationary && o.segmentValid, "road-speed movement is accepted and continuous");
      require(n * 20.0 - north(o) < 1.5, "adaptive smoothing adds under 1.5 m lag at 72 km/h");
    }
  }
  PositionFilter approach;
  uint32_t entered = 0;
  // A known hazard at north=50 m. Raw first enters 10 m radius at t=8 s.
  for (uint32_t n = 0; n <= 12; ++n) {
    const Output &o = approach.update(sample(n, n * 5.0, 0, 18));
    if (!entered && o.valid && fabs(north(o) - 50.0) <= 10.0) entered = n;
  }
  require(entered >= 8 && entered <= 9, "moving filter delays 10 m approach by at most one 1 Hz sample at 18 km/h");
}

static void epochAndDateLineContinuity() {
  PositionFilter f;
  for (uint32_t n = 0; n <= 8; ++n) f.update(sample(n, n * 2.0, 0, 7.2f));
  const uint32_t movingEpoch = f.current().epoch;
  bool firstHoldSeen = false;
  for (uint32_t n = 9; n <= 18; ++n) {
    const Output &o = f.update(sample(n, 16.0, 0, 0.1f));
    if (!firstHoldSeen && o.stationary) {
      firstHoldSeen = true;
      require(o.epoch != movingEpoch && !o.segmentValid,
        "first hold snap breaks distance/geofence continuity exactly once");
    }
  }
  require(firstHoldSeen, "clean stop establishes hold");
  const uint32_t stationaryEpoch = f.current().epoch;
  f.update(sample(19, 17.0));
  require(f.current().epoch == stationaryEpoch && f.current().segmentValid,
    "later stationary samples keep same epoch without repeated breaks");
  f.update(sample(20, 21.0, 0, 18));
  const Output &resume = f.update(sample(21, 26.0, 0, 18));
  require(!resume.stationary && resume.epoch != stationaryEpoch && !resume.segmentValid,
    "resume starts new navigation epoch without charging held displacement");

  PositionFilter dateline;
  for (uint32_t n = 0; n <= 12; ++n) {
    Fix s = sample(n, 0, 0, 18);
    s.lat = 0;
    s.lon = 179.9998 + n * 5.0 / 111194.9266;
    if (s.lon > 180.0) s.lon -= 360.0;
    const Output &o = dateline.update(s);
    if (n >= 2) {
      require(o.valid && !o.stationary && o.rejected == 0, "crossing longitude wrap is not an impossible jump");
      require(fabs(o.lon) > 179.99, "longitude smoothing takes the short way across the date line");
    }
  }
}

#include "../Arduino/ESP32S3_Telematics/geofence_policy.h"

static void resumeNearHazardPolicy() {
  PositionFilter f;
  lockAtOrigin(f);
  const Output held = f.current();
  f.update(sample(7, 12, 0, 43.2f));
  const Output moving = f.update(sample(8, 24, 0, 43.2f));
  require(navigation::confirmedResume(held.valid, held.stationary, moving.valid, moving.stationary,
                                      held.epoch != moving.epoch), "normal hold release allows current-point geofence");
  require(!moving.segmentValid, "resume still cannot charge anchor displacement");
  const float distance = float(fabs(north(moving) - 21.0));
  require(navigation::geofenceShouldWarn(true, distance, INFINITY, distance, false, 10, 0.2f),
          "already-armed hazard 21 m from hold warns when resumed position is 3 m inside");
  require(!navigation::geofenceShouldWarn(false, distance, INFINITY, distance, false, 10, 0.2f),
          "new/unarmed hazard cannot warn during hold release");
  require(!navigation::confirmedResume(false, true, true, false, true), "outage reacquisition is not resume");
  require(!navigation::confirmedResume(true, false, true, false, true), "ordinary epoch break is not resume");
  require(!navigation::geofenceShouldWarn(true, 15, 21, 0, false, 10, 0.2f), "no bridge over invalid anchor segment");
  require(navigation::geofenceShouldWarn(true, 15, 21, 0, true, 10, 0.2f), "real segment may cross warning circle");
}

int main() {
  stationaryJitterAndDuplicates();
  isolatedJumpAndSpeedSpike();
  resumeAndSlowWalking();
  slowMotionAtDifferentFixRates();
  stopAfterMotion();
  invalidStaleReacquisition();
  sustainedOutlierRecovery();
  numericValidationAndWrap();
  roadSpeedLatencyAndGeofence();
  epochAndDateLineContinuity();
  resumeNearHazardPolicy();
  printf("PASS: GNSS position filter (%u deterministic checks)\n", checks);
  return 0;
}
