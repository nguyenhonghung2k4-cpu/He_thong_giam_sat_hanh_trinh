#pragma once
// Host-only support for compiling the actual NODE_ECU.ino in integration tests.
#include <cmath>
#include <cstdint>
#include <cstring>
#include <cstdarg>
#include <cstdio>
#include <string>
extern uint32_t mockNow;
extern unsigned mockAdcReads;
inline uint32_t millis() { return mockNow; }
inline void delay(uint32_t ms) { mockNow += ms; }
constexpr int INPUT = 0, ADC_11db = 0;
inline void pinMode(uint8_t, int) {}
inline void analogReadResolution(int) {}
inline void analogSetPinAttenuation(uint8_t, int) {}
inline int analogRead(uint8_t) { ++mockAdcReads; return 2048; }
template <class T> inline T constrain(T value, T low, T high) {
  return value < low ? low : value > high ? high : value;
}
struct MockSerial {
  std::string output;
  void begin(unsigned) {}
  void println(const char *s) { output += s; output += '\n'; }
  void printf(const char *fmt, ...) {
    char buffer[2048];
    va_list args; va_start(args, fmt);
    vsnprintf(buffer, sizeof(buffer), fmt, args); va_end(args);
    output += buffer;
  }
};
extern MockSerial Serial;
