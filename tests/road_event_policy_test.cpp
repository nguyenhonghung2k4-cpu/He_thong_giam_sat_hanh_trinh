#include "../Arduino/ESP32S3_Telematics/road_event_policy.h"
#include "../Arduino/ESP32S3_Telematics/direct_demo_engine.h"
#include "../Arduino/ESP32S3_Telematics/motion_window_policy.h"
#include <cstdio>
#include <cstdlib>
#include <string>
static unsigned checks = 0;
#define CHECK(x) do { ++checks; if (!(x)) { std::fprintf(stderr,"FAIL line %d: %s\n",__LINE__,#x); std::exit(1); } } while (0)
using roadevent::State;
int main() {
  constexpr uint32_t fifoBudget=motionwindow::fifoFreshnessBudgetMs(10,16,180,25);
  CHECK(fifoBudget==250&&fifoBudget<320);
  CHECK(motionwindow::ready(true,200,200,250,200,50,1160,1000,fifoBudget));
  CHECK(motionwindow::ready(true,200,200,250,200,50,1250,1000,fifoBudget));
  CHECK(!motionwindow::ready(true,200,200,250,200,50,1251,1000,fifoBudget));
  CHECK(!motionwindow::ready(false,200,200,250,200,50,1100,1000,fifoBudget));
  CHECK(!motionwindow::ready(true,199,200,250,200,50,1100,1000,fifoBudget));
  CHECK(!motionwindow::ready(true,200,200,249,200,50,1100,1000,fifoBudget));
  CHECK(motionwindow::ready(true,200,200,250,200,50,49,UINT32_MAX-100,fifoBudget));
  // Every normal500ms tick should remain eligible for all phases of a160ms
  // FIFO service. The retired50ms check failed5 of the8 phase positions.
  for(uint32_t tick=500;tick<=4000;tick+=500)
    CHECK(motionwindow::ready(true,200,200,200+tick/10,200,50,tick,tick-tick%160,fifoBudget));
  roadevent::Gate gate;
  auto observe = [&](uint8_t kind, float score, uint32_t now, float threshold=.8f) {
    return gate.observe(kind,score,threshold,true,false,now);
  };
  CHECK(gate.observe(1,.999f,.8f,false,false,100).state==State::Warmup);
  CHECK(gate.observe(1,.999f,.8f,true,true,500).state==State::ScopeSettling);
  CHECK(!gate.observe(1,.999f,.8f,false,false,1000).confirmed);
  CHECK(observe(2,.79f,1500).state==State::BelowThreshold);
  auto d=observe(2,.96f,2000);
  CHECK(d.confirmed&&d.firstObservation&&d.windows==1);
  CHECK(d.state==State::Confirmed&&std::string(d.confirmation)=="strong_score");
  CHECK(observe(2,.999f,2500).state==State::Latched);
  // A different class is no longer blocked forever by the global latch, but
  // one alternating model result must NOT create a second kind of marker.
  d=observe(1,.999f,3000); CHECK(!d.confirmed&&d.state==State::PendingConfirmation);
  CHECK(observe(2,.999f,3500).state==State::Latched);
  CHECK(!observe(1,.999f,4000).confirmed);
  d=observe(1,.999f,4500); CHECK(d.confirmed&&d.windows==2);
  CHECK(std::string(d.confirmation)=="matching_windows");
  CHECK(observe(1,.999f,5000).state==State::Latched);
  CHECK(observe(2,.999f,5500).state==State::Latched);
  CHECK(observe(0,.999f,6000).state==State::Flat);
  CHECK(observe(1,.999f,6500).state==State::Latched); // a single clear window is insufficient
  observe(0,.99f,7000); observe(0,.99f,7500);
  CHECK(observe(2,.999f,8000).confirmed);
  gate.reset();
  CHECK(observe(2,.98f,8500,.99f).state==State::BelowThreshold); // do not lower configured threshold
  CHECK(!observe(2,.90f,9000).confirmed);
  d=observe(2,.91f,9500); CHECK(d.confirmed&&d.windows==2);
  gate.reset();
  CHECK(observe(1,.9f,10000).firstObservation);
  d=observe(1,.9f,12000); CHECK(!d.confirmed&&d.firstObservation&&d.windows==1);
  CHECK(observe(1,.9f,12500).confirmed);
  gate.reset();
  CHECK(!observe(1,.9f,UINT32_MAX-200).confirmed);
  CHECK(observe(1,.9f,299).confirmed); // elapsed arithmetic survives millis wrap
  gate.reset();
  CHECK(observe(1,NAN,100).state==State::Invalid);
  CHECK(observe(3,.99f,100).state==State::Invalid);
  CHECK(observe(1,.99f,100,.4f).state==State::Invalid);
  CHECK(!observe(1,.90f,1000).confirmed);
  gate.reset();
  CHECK(observe(2,.99f,1200).confirmed); // fresh scope cannot inherit old candidate/latch

  // The direct engine records the first inference position, not the later
  // confirmation/HTTP time. A new pass/session must reject an old snapshot.
  directdemo::Engine engine;
  directdemo::Point route[]={{20.9,105.82},{20.9,105.83}};
  CHECK(engine.start("first",route,2,2,0)==nullptr);
  engine.step(250,true,36,10,20);
  const auto first=engine.snapshot();
  engine.step(500,true,36,10,20);
  engine.step(750,true,36,10,20);
  bool added=false;
  CHECK(directdemo::distance(first.point,engine.snapshot().point)>9);
  CHECK(engine.detectAt(2,.91f,8,first,added)==0&&added);
  CHECK(directdemo::distance(first.point,engine.hazard(0).point)<.001);
  CHECK(engine.detectAt(2,.99f,8,first,added)==0&&!added); // known point is not duplicated
  CHECK(engine.control("first","pause",800)==nullptr);
  CHECK(engine.control("first","repeat",850)==nullptr);
  CHECK(engine.detectAt(1,.99f,8,first,added)==-1&&!added); // old pass cannot leak coordinates
  CHECK(engine.control("first","stop",900)==nullptr);
  CHECK(engine.start("second",route,2,2,1000)==nullptr);
  CHECK(engine.detectAt(1,.99f,8,first,added)==-1&&!added); // old session cannot leak either
  directdemo::Engine reboot;
  CHECK(reboot.detectAt(1,.99f,8,first,added)==-1&&!added);
  std::printf("PASS road event admission and first-inference coordinates: %u checks\n",checks);
}
