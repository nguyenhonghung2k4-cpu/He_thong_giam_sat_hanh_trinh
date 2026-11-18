// Optional host reference test only; never linked into ESP32 firmware.
// It runs the original library via run_classifier, not precomputed scores.
#include "edge-impulse-sdk/classifier/ei_run_classifier.h"
#include <cstdio>
#include <cstdlib>
#include <cstdarg>
#include <cstring>
#include <chrono>

EI_IMPULSE_ERROR ei_run_impulse_check_canceled() { return EI_IMPULSE_OK; }
EI_IMPULSE_ERROR ei_sleep(int32_t) { return EI_IMPULSE_OK; }
uint64_t ei_read_timer_ms() { return (uint64_t)std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count(); }
uint64_t ei_read_timer_us() { return (uint64_t)std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now().time_since_epoch()).count(); }
void ei_printf(const char *format, ...) { va_list args; va_start(args, format); vfprintf(stderr, format, args); va_end(args); }
void ei_printf_float(float value) { fprintf(stderr, "%f", value); }
void ei_putchar(char c) { fputc(c, stderr); }
void *ei_malloc(size_t n) { return malloc(n); }
void *ei_calloc(size_t n, size_t s) { return calloc(n, s); }
void ei_free(void *p) { free(p); }
void DebugLog(const char *s) { fputs(s, stderr); }

static float values[EI_CLASSIFIER_DSP_INPUT_FRAME_SIZE];
static int read_values(size_t off, size_t len, float *out) { memcpy(out, values + off, len * sizeof(float)); return 0; }
int main() {
  size_t n = 0;
  while (scanf("%f", &values[n]) == 1) {
    if (++n != EI_CLASSIFIER_DSP_INPUT_FRAME_SIZE) continue;
    signal_t signal; signal.total_length = n; signal.get_data = read_values;
    ei_impulse_result_t result = {};
    auto status = run_classifier(&signal, &result, false);
    printf("{\"status\":%d,\"scores\":{", (int)status);
    for (size_t i = 0; i < EI_CLASSIFIER_LABEL_COUNT; ++i) printf("%s\"%s\":%.9f", i ? "," : "", result.classification[i].label, result.classification[i].value);
    printf("}}\n"); fflush(stdout); n = 0;
  }
  return n ? 2 : 0;
}
