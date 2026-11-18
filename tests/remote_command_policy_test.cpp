#include "../Arduino/ESP32S3_Telematics/remote_command_policy.h"
#include <assert.h>
#include <stdio.h>
int main() {
  assert(remoteAudioMayPlay(200,true,true,true,true,42,41));
  assert(!remoteAudioMayPlay(200,true,true,false,false,42,41)); // cancelled, HTTP still 200
  assert(!remoteAudioMayPlay(200,true,true,true,false,42,41)); // stale/config changed
  assert(!remoteAudioMayPlay(-1,true,true,true,true,42,41)); // lost ACK
  assert(!remoteAudioMayPlay(200,true,false,true,true,42,41));
  assert(!remoteAudioMayPlay(200,false,true,true,true,42,41));
  assert(!remoteAudioMayPlay(200,true,true,true,true,42,42)); // duplicate after actual play
  assert(!remoteAudioMayPlay(200,true,true,true,true,0,41));
  assert(remoteAudioMayPlay(200,true,true,true,true,42,41)); // repeat after lost ACK may play once
  assert(remoteCommandPollInterval(false,500,3000)==3000);
  assert(remoteCommandPollInterval(true,500,3000)==500);
  assert(remoteCommandPollInterval(true,0,3000)==500);
  assert(remoteCommandPollInterval(true,100000,3000)==3000);
  puts("PASS remote command policy: cancelled/expired/duplicate voice blocked; bounded demo-only fast polling.");
}
