#include <cassert>
#include <cstdint>
#include <cstdio>
#include "../Arduino/NODE_ECU/node_can_tx_policy.h"

static void initialAndOwnership() {
  NodeCanTxPolicy p;
  assert(!p.ready() && !p.inFlight() && !p.everAcked());
  assert(!p.probing()); // First heartbeat is single-shot, before probe backoff.
  assert(p.maySend(0, true) && !p.maySend(0, false));
  assert(!p.acknowledged(1) && !p.everAcked());
  p.queued(5);
  assert(!p.maySend(5, true) && !p.maySend(5, false));
  assert(!p.pendingExpired(254) && p.pendingExpired(255));
  assert(p.acknowledged(254));
  assert(p.ready() && p.everAcked() && !p.probing());
  assert(p.maySend(255, true) && p.maySend(255, false));
  assert(p.ackFresh(2754) && !p.ackExpired(2754));
  assert(!p.ackFresh(2755) && p.ackExpired(2755));
  assert(!p.maySend(2755, true) && !p.maySend(2755, false));
}

static void boundedReconnect() {
  NodeCanTxPolicy p;
  uint32_t now = 100;
  const uint32_t waits[] = {500, 1000, 2000, 4000, 4000, 4000};
  for (uint32_t wait : waits) {
    p.failed(now);
    assert(!p.ready() && p.probing() && !p.inFlight());
    assert(p.waitRemaining(now) == wait);
    assert(!p.maySend(now + wait - 1, true));
    assert(p.maySend(now + wait, true));
    assert(!p.maySend(now + wait, false));
    assert(!p.acknowledged(now + wait - 1)); // Aborted, unowned completion.
    p.queued(now + wait);
    assert(!p.maySend(now + wait, true));
    now += wait + 1;
  }
  assert(p.failureStreak() == 4);
  assert(p.acknowledged(now));
  assert(p.ready() && !p.probing() && p.failureStreak() == 0);
  p.failed(now + 1);
  assert(p.waitRemaining(now + 1) == 500); // Success resets backoff.
}

static void clockWrap() {
  NodeCanTxPolicy p;
  p.queued(UINT32_MAX - 100U);
  assert(p.pendingAge(99) == 200);
  assert(!p.pendingExpired(148) && p.pendingExpired(149));
  assert(p.acknowledged(UINT32_MAX - 10U));
  assert(p.ackAge(9) == 20 && p.ackFresh(9));
  assert(p.ackFresh(2489) && p.ackExpired(2490));
  p.failed(UINT32_MAX - 100U);
  assert(p.waitRemaining(398) == 1);
  assert(p.waitRemaining(399) == 0 && p.maySend(399, true));
}

static void delayedAlertsAreNotFreshAcks() {
  NodeCanTxPolicy p;
  p.queued(100);
  assert(!p.acknowledged(350)); // Exact pending-age deadline is expired.
  assert(!p.ready() && !p.everAcked() && !p.inFlight());
  assert(p.probing() && p.waitRemaining(350) == 500);
  p.queued(850);
  assert(p.acknowledged(851));
  p.queued(900);
  assert(!p.acknowledged(5000)); // Delayed/coalesced bit after foreground stall.
  assert(p.everAcked() && p.ackAge(5000) == 4149 && !p.ackFresh(5000));
  NodeCanTxPolicy wrap;
  wrap.queued(UINT32_MAX - 100U);
  assert(!wrap.acknowledged(149));
  assert(!wrap.everAcked() && wrap.probing());
}

static void isolatedFailuresAndBurst() {
  NodeCanTxPolicy p;
  p.transmissionFailed(0); // No owned transfer: cannot alter startup state.
  assert(!p.probing() && p.maySend(0,true));
  p.queued(1); assert(p.acknowledged(2));
  p.queued(100); p.transmissionFailed(101);
  assert(p.ready() && p.ackFresh(101) && p.transientFailures()==1);
  assert(p.ackAge(101)==99); // Failed transmission is never a fresh ACK.
  p.queued(200); assert(p.acknowledged(201));
  assert(p.transientFailures()==0);
  p.queued(300); p.transmissionFailed(301);
  p.queued(400); p.transmissionFailed(401);
  assert(p.ready() && p.transientFailures()==2);
  p.queued(500); p.transmissionFailed(501);
  assert(p.probing() && !p.ackFresh(501) && p.waitRemaining(501)==500);
  assert(!p.maySend(1000,true) && p.maySend(1001,true));
  p.queued(1001); assert(p.acknowledged(1002));
  p.queued(3400); p.transmissionFailed(3503); // ACK is stale, no tolerance.
  assert(p.probing() && p.waitRemaining(3503)==500);
}

int main() {
  initialAndOwnership();
  boundedReconnect();
  clockWrap();
  delayedAlertsAreNotFreshAcks();
  isolatedFailuresAndBurst();
  std::puts("PASS: NODE policy ownership, isolated failure tolerance, bounded burst/reconnect, real ACK freshness and millis rollover (host only).");
}
