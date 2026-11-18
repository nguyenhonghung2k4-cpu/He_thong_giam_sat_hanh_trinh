#include "../Arduino/ESP32S3_Telematics/direct_demo.h"
#include <thread>
#include <atomic>
#include <cstdio>
#include <cstdlib>
SerialMock Serial;
static unsigned checks=0;
#define CHECK(x) do { ++checks; if(!(x)) { std::fprintf(stderr,"FAIL line %d: %s\n",__LINE__,#x); std::exit(1); } } while(0)
static bool scopeCheckedAtCommandLog=false;
static uint32_t oldPass=1, newPass=0;
static directdemo::Point oldPoint;
static void checkScopeAtCommandLog() {
  // The command result has already been published at this log call, but the
  // final per-poll publication has not run. Model an audio-task observation
  // in that gap: an acknowledged control must expose its new scope already.
  scopeCheckedAtCommandLog=true;
  CHECK(!directDemoAudioCurrent("test",oldPass,oldPoint.lat,oldPoint.lon,10));
  if(newPass) {
    const auto point=directDemoSnapshot().point;
    CHECK(directDemoAudioCurrent("test",newPass,point.lat,point.lon,10));
  }
}
static void waitMs(unsigned ms) { std::this_thread::sleep_for(std::chrono::milliseconds(ms)); }
static String control(const char *op,int ttl=2000) {
  return String("{\"command\":{\"action\":\"direct_demo_control\",\"session_id\":\"test\",\"operation\":\"")+op+"\",\"expires_in_ms\":"+std::to_string(ttl)+"}}";
}
int main() {
  CHECK(!directDemoActive()); CHECK(directDemoSnapshotJson()=="null");
  const String start="{\"command\":{\"action\":\"direct_demo_start\",\"session_id\":\"test\",\"route_points\":[20.9,105.82,20.9,105.821],\"speed_multiplier\":2,\"expires_in_ms\":2000}}";
  std::atomic<bool> done{false}; bool ok=false;String result;
  std::thread worker([&]{ok=directDemoCommand(1,start,result);done=true;});
  waitMs(30); CHECK(!done); CHECK(!directDemoActive()); // queued is NOT applied
  CHECK(directDemoPoll(true,36,10,20));
  worker.join(); CHECK(done&&ok); CHECK(directDemoActive());
  CHECK(result.find("\"applied\":true")!=String::npos);
  CHECK(result.find("\"pass_index\":1")!=String::npos);
  const String accepted=result;
  CHECK(directDemoCommand(1,start,result)); CHECK(result==accepted);
  CHECK(directDemoSnapshot().passIndex==1);
  const auto location=directDemoSnapshot().point;
  CHECK(directDemoAudioCurrent("test",1,location.lat,location.lon,10));
  CHECK(!directDemoAudioCurrent("wrong",1,location.lat,location.lon,10));
  CHECK(!directDemoAudioCurrent("test",2,location.lat,location.lon,10));
  CHECK(!directDemoAudioCurrent("test",1,location.lat+.01,location.lon,10));
  directDemoPoll(false,36,10,20);
  CHECK(!directDemoAudioCurrent("test",1,location.lat,location.lon,10));
  directDemoPoll(true,36,10,20);
  CHECK(directDemoAudioCurrent("test",1,location.lat,location.lon,10));

  // Expired mailbox cannot be applied by a delayed main loop.
  done=false;
  std::thread expired([&]{ok=directDemoCommand(2,control("pause",10),result);done=true;});
  waitMs(50); CHECK(!directDemoPoll(true,36,10,20)); expired.join();
  CHECK(!ok&&result.find("command_expired_before_apply")!=String::npos);
  CHECK(directDemoSnapshot().state==directdemo::State::Running);
  CHECK(!directDemoCommand(2,control("pause"),result)); // expiry failure cached

  done=false;
  oldPoint=directDemoSnapshot().point;
  scopeCheckedAtCommandLog=false; Serial.onPrint=checkScopeAtCommandLog;
  std::thread pause([&]{ok=directDemoCommand(3,control("pause"),result);done=true;});
  waitMs(20); directDemoPoll(true,36,10,20); pause.join(); CHECK(ok);
  Serial.onPrint=nullptr; CHECK(scopeCheckedAtCommandLog);
  CHECK(directDemoSnapshot().state==directdemo::State::Paused);
  CHECK(!directDemoAudioCurrent("test",1,location.lat,location.lon,10));
  done=false;
  newPass=2; scopeCheckedAtCommandLog=false; Serial.onPrint=checkScopeAtCommandLog;
  std::thread repeat([&]{ok=directDemoCommand(4,control("repeat"),result);done=true;});
  waitMs(20); CHECK(directDemoPoll(true,36,10,20)); repeat.join(); CHECK(ok);
  Serial.onPrint=nullptr; CHECK(scopeCheckedAtCommandLog); newPass=0;
  CHECK(directDemoSnapshot().passIndex==2);
  CHECK(!directDemoAudioCurrent("test",1,location.lat,location.lon,10));
  const auto repeated=directDemoSnapshot().point;
  CHECK(directDemoAudioCurrent("test",2,repeated.lat,repeated.lon,10));
  CHECK(directDemoCommand(4,control("repeat"),result)); CHECK(directDemoSnapshot().passIndex==2);
  CHECK(result.find("\"pass_index\":2")!=String::npos);

  // The bounded wait cancels a mailbox the main loop never took.
  CHECK(!directDemoCommand(5,control("stop"),result));
  CHECK(result.find("direct_main_loop_timeout")!=String::npos);
  CHECK(!directDemoAudioCurrent("test",2,repeated.lat,repeated.lon,10)); // stale published motion
  CHECK(directDemoActive()); CHECK(!directDemoPoll(true,0,10,20)); CHECK(directDemoActive());
  done=false;
  oldPass=2; oldPoint=directDemoSnapshot().point;
  CHECK(directDemoAudioCurrent("test",oldPass,oldPoint.lat,oldPoint.lon,10));
  scopeCheckedAtCommandLog=false; Serial.onPrint=checkScopeAtCommandLog;
  std::thread stop([&]{ok=directDemoCommand(6,control("stop"),result);done=true;});
  waitMs(20); CHECK(directDemoPoll(true,0,10,20)); stop.join();
  Serial.onPrint=nullptr; CHECK(scopeCheckedAtCommandLog);
  CHECK(ok&&!directDemoActive()); CHECK(result.find("\"state\":\"stopped\"")!=String::npos);
  CHECK(!directDemoAudioCurrent("test",2,repeated.lat,repeated.lon,10));
  CHECK(directDemoCommand(6,control("stop"),result)); CHECK(!directDemoActive());
  std::printf("PASS direct demo production mailbox: %u checks\n",checks);
}
