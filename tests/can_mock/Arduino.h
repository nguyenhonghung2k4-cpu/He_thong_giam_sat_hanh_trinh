#pragma once
// Host-only driver contract tests. Never installed as an Arduino library.
#include <cmath>
#include <cstdint>
#include <cstddef>
#include <cstring>
#include <string>
#include <cstdarg>
#include <cstdio>
#include <cassert>
using String=std::string;
extern uint32_t mockNow;
inline uint32_t millis(){return mockNow;}
struct MockSerial {
  std::string output;
  bool writesAllowed=true;
  void println(const char *s){assert(writesAllowed);output+=s;output+='\n';}
  void printf(const char *fmt,...){
    assert(writesAllowed);
    char text[1024];va_list args;va_start(args,fmt);vsnprintf(text,sizeof(text),fmt,args);va_end(args);output+=text;
  }
};
extern MockSerial Serial;
using TaskHandle_t=void*;
using portMUX_TYPE=int;
#define portMUX_INITIALIZER_UNLOCKED 0
#define portENTER_CRITICAL(mux) ((void)(mux))
#define portEXIT_CRITICAL(mux) ((void)(mux))
#define pdMS_TO_TICKS(ms) (ms)
#define pdPASS 1
struct MockWorkerYield {};
extern bool mockTaskCreateSucceeds,mockYieldFromWorker;
extern unsigned mockTaskCreateCalls;
extern void (*mockTaskEntry)(void*);
inline void vTaskDelay(uint32_t ticks){
  assert(ticks==5);
  if(mockYieldFromWorker)throw MockWorkerYield{};
}
// Save the real worker entrypoint. Tests run one iteration and yield at delay.
inline int xTaskCreatePinnedToCore(void(*entry)(void*),const char *name,uint32_t stack,void *arg,int priority,TaskHandle_t *handle,int core){
  ++mockTaskCreateCalls;
  assert(std::strcmp(name,"can_rx")==0&&stack==4096&&arg==nullptr&&priority==2&&core==0);
  if(!mockTaskCreateSucceeds)return 0;
  mockTaskEntry=entry;*handle=reinterpret_cast<TaskHandle_t>(uintptr_t(1));return pdPASS;
}
