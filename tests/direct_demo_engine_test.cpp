#include "../Arduino/ESP32S3_Telematics/direct_demo_engine.h"
#include "../Arduino/ESP32S3_Telematics/direct_demo_command.h"
#include <cstdio>
#include <cstdlib>
#include <string>
#include <limits>
using namespace directdemo;
static unsigned checks=0;
#define CHECK(x) do { ++checks; if(!(x)) { std::fprintf(stderr,"FAIL line %d: %s\n",__LINE__,#x); std::exit(1); } } while(0)
static Point route[]={{20.9,105.82},{20.9,105.821},{20.9,105.822}};
static bool near(double a,double b,double epsilon=.01) { return fabs(a-b)<epsilon; }
static void advance(Engine &e,uint32_t &now,unsigned ticks,float speed=36,float radius=10,float rearm=20) {
  for(unsigned i=0;i<ticks;i++) { now+=100; e.step(now,true,speed,radius,rearm); }
}
int main() {
  Engine e; uint32_t now=0;
  CHECK(!e.snapshot().active()); CHECK(e.takeWarning()==-1);
  CHECK(e.start("bad session",route,3,2,now)!=nullptr);
  CHECK(e.start("s",route,1,2,now)!=nullptr);
  CHECK(e.start("s",route,3,NAN,now)!=nullptr);
  CHECK(e.start("s",route,3,.4,now)!=nullptr);
  CHECK(e.start("s",route,3,5.1,now)!=nullptr);
  Point bad[]={{20,100},{NAN,100}};
  CHECK(e.start("s",bad,2,2,now)!=nullptr);
  Point duplicate[]={{20,100},{20,100}};
  CHECK(e.start("s",duplicate,2,2,now)!=nullptr);
  Point shortRoute[]={{20,100},{20,100.000001}};
  CHECK(e.start("s",shortRoute,2,2,now)!=nullptr);
  Point longRoute[]={{20,100},{21,100}};
  CHECK(e.start("s",longRoute,2,2,now)!=nullptr);
  CHECK(e.start("s",route,3,2,now)==nullptr);
  CHECK(e.snapshot().state==State::CanStale); CHECK(e.snapshot().passIndex==1);
  CHECK(e.start("s",route,3,2,now)==nullptr); CHECK(e.snapshot().passIndex==1);
  CHECK(e.start("other",route,3,2,now)!=nullptr);
  advance(e,now,10,0); CHECK(near(e.snapshot().distanceM,0)); CHECK(e.snapshot().speed==0);
  advance(e,now,10); CHECK(near(e.snapshot().distanceM,20));
  CHECK(near(e.snapshot().speed,72)); CHECK(e.snapshot().point.lon>route[0].lon);
  const double previous=e.snapshot().distanceM;
  now+=100000; e.step(now,true,36,10,20); CHECK(near(e.snapshot().distanceM,previous+5));
  const double held=e.snapshot().distanceM;
  now+=100; e.step(now,false,36,10,20); CHECK(near(e.snapshot().distanceM,held));
  CHECK(e.snapshot().state==State::CanStale); CHECK(e.snapshot().speed==0);
  now+=100; e.step(now,true,NAN,10,20); CHECK(near(e.snapshot().distanceM,held));
  now+=100; e.step(now,true,181,10,20); CHECK(near(e.snapshot().distanceM,held));
  now+=100; e.step(now,true,-1,10,20); CHECK(near(e.snapshot().distanceM,held));
  CHECK(e.control("other","stop",now)!=nullptr); CHECK(e.snapshot().active());
  CHECK(e.control("s","nonsense",now)!=nullptr);
  CHECK(e.control("s","repeat",now)!=nullptr);
  CHECK(e.control("s","pause",now)==nullptr);
  advance(e,now,10); CHECK(near(e.snapshot().distanceM,held)); CHECK(e.snapshot().speed==0);
  CHECK(e.control("s","resume",now)==nullptr);
  advance(e,now,10); CHECK(near(e.snapshot().distanceM,held+20));
  bool added=false; const int pothole=e.detect(1,.996f,8,added);
  CHECK(pothole==0&&added); CHECK(e.takeWarning()==-1);
  const Point point=e.hazard(0).point;
  CHECK(e.detect(1,.998f,8,added)==0&&!added); CHECK(e.hazardCount()==1);
  CHECK(e.detect(2,.998f,8,added)==1&&added); CHECK(e.hazardCount()==2);
  CHECK(e.detect(3,.998f,8,added)==-1); CHECK(e.detect(1,NAN,8,added)==-1);
  CHECK(e.detect(1,.998f,NAN,added)==-1);
  advance(e,now,unsigned(ceil((e.snapshot().lengthM-e.snapshot().distanceM)/2.0))+1);
  CHECK(e.snapshot().state==State::Completed);
  CHECK(near(e.snapshot().distanceM,e.snapshot().lengthM)); CHECK(e.snapshot().speed==0);
  CHECK(e.takeWarning()==-1); // first encounter never speaks, departure does not speak
  CHECK(e.control("s","resume",now)!=nullptr);
  CHECK(e.control("s","repeat",now)==nullptr); CHECK(e.snapshot().passIndex==2);
  CHECK(near(e.snapshot().distanceM,0)); CHECK(e.hazardCount()==2);
  CHECK(e.takeWarning()==-1); // repeat teleport never makes a crossing
  advance(e,now,15,36,5,20); CHECK(e.takeWarning()==-1); // 15m from hazard, custom radius is 5m, not old 10/30m
  bool warned=false;
  for(unsigned i=0;i<15;i++) {
    advance(e,now,1,36,5,20);
    int index=e.takeWarning();
    if(index>=0) { CHECK(e.hazard(size_t(index)).warningDistance<=5.001f); warned=true; }
  }
  CHECK(warned); CHECK(distance(point,e.hazard(0).point)<.001);
  while(e.takeWarning()>=0) {}
  advance(e,now,2,0,5,20); CHECK(e.takeWarning()==-1);
  CHECK(e.control("s","stop",now)==nullptr); CHECK(!e.snapshot().active());
  advance(e,now,10); CHECK(e.snapshot().speed==0); CHECK(e.takeWarning()==-1);
  CHECK(e.control("s","stop",now)==nullptr);
  CHECK(e.start("s",route,3,2,now)!=nullptr); // no restart through stale start retries
  CHECK(e.start("next",route,3,2,now)==nullptr); CHECK(e.hazardCount()==0);
  Engine reboot; CHECK(!reboot.snapshot().active());

  // Millis wrap and large dt must not jump to the end.
  Engine wrap; CHECK(wrap.start("wrap",route,3,1,UINT32_MAX-50)==nullptr);
  wrap.step(49,true,36,10,20); CHECK(near(wrap.snapshot().distanceM,1));

  // Segment crossing cannot skip a small circle at maximum scaled speed.
  Engine fast; uint32_t t=0; CHECK(fast.start("fast",route,3,1,t)==nullptr);
  advance(fast,t,25); CHECK(fast.detect(1,.99,1,added)==0);
  advance(fast,t,160); CHECK(fast.control("fast","pause",t)==nullptr);
  CHECK(fast.control("fast","repeat",t)==nullptr);
  advance(fast,t,4,180,2,4);
  CHECK(fast.takeWarning()==-1);
  t+=250; fast.step(t,true,180,2,4);
  CHECK(fast.pendingWarning()==0); CHECK(!fast.hazard(0).warningReported);
  CHECK(fast.hazard(0).warningAtMs==t);
  fast.reportWarning(0); CHECK(fast.hazard(0).warningReported);
  CHECK(fast.pendingWarning()==0); // failed audio admission must not consume it
  CHECK(fast.pendingWarning(1)==-1);
  fast.dismissWarning(0); CHECK(fast.pendingWarning()==-1);
  CHECK(fast.takeWarning()==-1);
  CHECK(fast.hazard(0).warningDistance<=2.001);

  auto parse=[](const std::string &j,Command &c){return parseCommand(j.c_str(),j.size(),c);};
  Command c;
  const std::string prefix="{\"command\":{\"action\":\"direct_demo_start\",\"session_id\":\"test-01\",\"expires_in_ms\":20000,";
  CHECK(parse(prefix+"\"route_points\":[20.9,105.82,20.9,105.821]}}",c)==nullptr);
  CHECK(c.count==2&&c.start&&c.ttlMs==2000&&c.multiplier==2);
  CHECK(parse(prefix+"\"route_points\":[20.9,105.82,20.9]}}",c)!=nullptr);
  CHECK(parse(prefix+"\"route_points\":[20.9,105.82,20.9,105.821],\"speed_multiplier\":6}}",c)!=nullptr);
  CHECK(parse(prefix+"\"route_points\":[20.9,105.82,20.9,1e999]}}",c)!=nullptr);
  CHECK(parse(prefix+"\"route_points\":[20.9,105.82,20.9,105.821],\"session_id\":\"other\"}}",c)!=nullptr);
  std::string tooMany="";
  for(unsigned i=0;i<130;i++){ if(i)tooMany+=",";tooMany+=(i%2?"105.82":"20.9"); }
  CHECK(parse(prefix+"\"route_points\":["+tooMany+"]}}",c)!=nullptr);
  CHECK(parse("{\"command\":{\"action\":\"direct_demo_control\",\"session_id\":\"s\",\"operation\":\"pause\",\"expires_in_ms\":50}}",c)==nullptr);
  CHECK(!c.start&&c.ttlMs==50&&!strcmp(c.operation,"pause"));
  CHECK(parse("{\"command\":{\"action\":\"direct_demo_control\",\"session_id\":\"s\",\"operation\":\"pause\"}}",c)!=nullptr);
  CHECK(parse("{\"command\":{\"action\":\"direct_demo_control\",\"session_id\":\"s\",\"operation\":\"pause\",\"expires_in_ms\":0}}",c)!=nullptr);
  CHECK(parse("{\"command\":{\"action\":\"demo_infer\",\"session_id\":\"s\",\"expires_in_ms\":50}}",c)!=nullptr);
  std::printf("PASS direct demo engine/parser: %u checks\n",checks);
}
