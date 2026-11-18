#include <cassert>
#include <cstdio>
#include <vector>
#include "../Arduino/ESP32S3_Telematics/audio_startup_sequence.h"

struct FakeTransport {
  bool muted = false, clearOk = true;
  size_t bytes = 0;
  int calls = 0, failAt = -1;
  std::vector<int> order;
  void mute() { muted = true; order.push_back(1); }
  bool clearDma() { assert(muted); order.push_back(2); return clearOk; }
  bool writeZeros(const uint8_t *data, size_t count) {
    assert(muted); assert(count <= 1024);
    for (size_t i = 0; i < count; ++i) assert(data[i] == 0);
    order.push_back(3);
    if (calls++ == failAt) return false;
    bytes += count;
    return true;
  }
};
int main() {
  FakeTransport ok;
  assert(audioPrimeMuted(ok, 8192));
  assert(ok.muted && ok.bytes == 9216 && ok.calls == 9);
  assert(ok.order[0] == 1 && ok.order[1] == 2);
  FakeTransport clearFail; clearFail.clearOk = false;
  assert(!audioPrimeMuted(clearFail, 8192));
  assert(clearFail.muted && clearFail.calls == 0);
  for (int at = 0; at < 9; ++at) {
    FakeTransport writeFail; writeFail.failAt = at;
    assert(!audioPrimeMuted(writeFail, 8192));
    assert(writeFail.muted && writeFail.calls == at + 1);
  }
  FakeTransport mono; assert(audioPrimeMuted(mono, 4096)); assert(mono.bytes == 5120);
  FakeTransport invalid; assert(!audioPrimeMuted(invalid, 0)); assert(invalid.muted);
  FakeTransport overflow; assert(!audioPrimeMuted(overflow, SIZE_MAX)); assert(overflow.muted);
  puts("PASS: production startup sequencer keeps amp muted, clears first, writes only zeros beyond DMA ring, rejects clear/write failures.");
}
