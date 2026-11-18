#pragma once
#include <string>
#include <mutex>
#include <chrono>
#include <cstdint>
#include <cstdio>
using String=std::string;
inline uint32_t millis() {
  static const auto start=std::chrono::steady_clock::now();
  return uint32_t(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now()-start).count());
}
struct SerialMock {
  void (*onPrint)() = nullptr;
  template<typename... Args> void printf(const char *,Args...) { if(onPrint) onPrint(); }
};
extern SerialMock Serial;
using portMUX_TYPE=std::mutex;
#define portMUX_INITIALIZER_UNLOCKED {}
#define portENTER_CRITICAL(m) (m)->lock()
#define portEXIT_CRITICAL(m) (m)->unlock()
