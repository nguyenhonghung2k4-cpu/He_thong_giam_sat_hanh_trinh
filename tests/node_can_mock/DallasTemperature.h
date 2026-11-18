#pragma once
#include "OneWire.h"
constexpr float DEVICE_DISCONNECTED_C = -127.0f;
struct DallasTemperature {
  explicit DallasTemperature(OneWire *) {}
  void begin() {}
  void setResolution(int) {}
  void setWaitForConversion(bool) {}
  void requestTemperatures() {}
  float getTempCByIndex(int) { return 25.0f; }
  unsigned getDeviceCount() { return 1; }
};
