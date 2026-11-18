#include "../Arduino/ESP32S3_Telematics/storage_policy.h"
using storage_policy::EventTickets;
using storage_policy::chooseLane;

// Real implementation evaluated by a C++17 compiler, with no target board,
// SD card, mocking of the algorithm or host-runtime dependencies required.
constexpr bool testExactOutOfOrderAck() {
  EventTickets<3> tickets;
  const auto a=tickets.reserve(),b=tickets.reserve();
  if(!a||!b||a==b||tickets.durable(a))return false;
  tickets.markDurable(b); // B commits before A: never infer A was committed.
  if(tickets.durable(a)||!tickets.durable(b))return false;
  tickets.markDurable(a);
  return tickets.durable(a)&&tickets.durable(b)&&!tickets.durable(0)&&!tickets.durable(999);
}
constexpr bool testBoundedOwnership() {
  EventTickets<2> tickets;
  const auto a=tickets.reserve(),b=tickets.reserve();
  if(tickets.reserve()!=0)return false;
  tickets.release(a); // HTTP succeeded, but pending worker still owns A.
  if(tickets.reserve()!=0)return false;
  tickets.markDurable(a); // Now free A; no historical range assumption.
  const auto c=tickets.reserve();
  if(!c||c==a||c==b||tickets.durable(c)||tickets.durable(a))return false;
  tickets.markDurable(b);
  if(tickets.reserve()!=0)return false; // Durable B still has a caller.
  tickets.release(b);
  return tickets.reserve()!=0;
}
constexpr bool testCancelAndRepeatedRelease() {
  EventTickets<1> tickets;
  const auto a=tickets.reserve();tickets.cancel(a);
  const auto b=tickets.reserve();
  tickets.release(a);tickets.markDurable(a);tickets.cancel(0);
  if(!b||tickets.durable(b)||tickets.reserve()!=0)return false;
  tickets.markDurable(b);tickets.release(b);tickets.release(b);
  return tickets.reserve()!=0;
}
constexpr bool testFairness() {
  uint8_t cursor=0;bool eligible[3]={true,true,true};int counts[3]={};
  for(int i=0;i<400;++i){const int lane=chooseLane(cursor,eligible);if(lane<0)return false;++counts[lane];}
  if(counts[0]!=200||counts[1]!=100||counts[2]!=100)return false;
  eligible[0]=false;counts[1]=counts[2]=0;
  for(int i=0;i<200;++i){const int lane=chooseLane(cursor,eligible);if(lane==0||lane<0)return false;++counts[lane];}
  return counts[1]==100&&counts[2]==100;
}
constexpr bool testEligibilityCombinations() {
  for(unsigned mask=0;mask<8;++mask)for(uint8_t initial=0;initial<4;++initial){
    uint8_t cursor=initial;bool eligible[3]={bool(mask&1),bool(mask&2),bool(mask&4)};
    const int chosen=chooseLane(cursor,eligible);
    if(!mask){if(chosen!=-1)return false;}
    else if(chosen<0||chosen>2||!eligible[chosen])return false;
    if(cursor>=4)return false;
  }
  return true;
}
static_assert(testExactOutOfOrderAck(),"out-of-order event writes must use exact ACK");
static_assert(testBoundedOwnership(),"bounded tracker must preserve both owners");
static_assert(testCancelAndRepeatedRelease(),"stale ticket operations must not affect new events");
static_assert(testFairness(),"blocked event lane must not starve offline/daily telemetry");
static_assert(testEligibilityCombinations(),"scheduler must never choose blocked or absent work");
