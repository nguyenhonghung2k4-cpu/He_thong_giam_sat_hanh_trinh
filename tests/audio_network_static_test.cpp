#include "../Arduino/ESP32S3_Telematics/audio_pcm_math.h"
#include "../Arduino/ESP32S3_Telematics/latest_slot_policy.h"

constexpr bool testNewestTelemetryWins() {
  LatestSlot<int> slot;int a=1,b=2,c=3;
  if(slot.pending()||slot.take()!=nullptr)return false;
  if(slot.publish(&a)!=nullptr||slot.publish(&b)!=&a)return false;
  int *inflight=slot.take();
  if(inflight!=&b||slot.pending())return false;
  if(slot.publish(&c)!=nullptr)return false;
  if(slot.retry(inflight)!=&b)return false; // Retry B may not evict C.
  if(slot.take()!=&c||slot.pending())return false;
  return true;
}
constexpr bool testRetryWithoutNewer() {
  LatestSlot<int> slot;int a=1;
  slot.publish(&a);
  int *inflight=slot.take();
  for(int i=0;i<1000;++i){
    if(slot.retry(inflight)!=nullptr||!slot.pending())return false;
    inflight=slot.take();if(inflight!=&a)return false;
  }
  return !slot.pending();
}
constexpr bool test100PercentThroughoutClip() {
  for(size_t frame=0;frame<16000;++frame){
    const auto envelope=audioEnvelopeQ15(frame,16000,320);
    if(envelope>32768)return false;
    if(frame>=320&&frame<15680&&envelope!=32768)return false;
    if(audioScalePcm16(32767,100,envelope)<0||audioScalePcm16(-32768,100,envelope)>0)return false;
  }
  return true;
}
static_assert(testNewestTelemetryWins(),"newer telemetry must survive a concurrent failed send");
static_assert(testRetryWithoutNewer(),"retry retains one bounded sample");
static_assert(test100PercentThroughoutClip(),"100% gain must not overflow or attenuate clip middle");
