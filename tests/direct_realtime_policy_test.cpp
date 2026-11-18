#include <assert.h>
#include <stdio.h>
#include <math.h>
#include "../Arduino/ESP32S3_Telematics/direct_realtime_policy.h"
#include "../Arduino/NODE_ECU/node_pot_filter.h"
int main(){
 using namespace directrealtime;
 assert(!due(199,0)&&due(200,0));assert(due(100,UINT32_MAX-100));
 assert(fresh(500,0)&&!fresh(501,0));assert(fresh(10,UINT32_MAX-30));
 assert(canFreshAtSend(1200,1000,1300,1500));assert(!canFreshAtSend(1201,1000,1300,1500));
 assert(!canFreshAtSend(1000,1000,1501,1500));
 for(int compact=0;compact<2;compact++)for(int active=0;active<2;active++)
 for(int gate=0;gate<2;gate++)for(int phase=0;phase<2;phase++)
  assert(gateAllows(compact,active,gate,phase)==(!gate||(compact&&active&&phase)));
 LatestPacketSlot slot;Packet out;assert(!slot.take(out));
 char input[64];for(unsigned i=0;i<1000;i++){snprintf(input,sizeof(input),"{\"seq\":%u}",i);assert(slot.publish(input,strlen(input),i,50,true));}
 assert(slot.pending());assert(!slot.publish(nullptr,1,0,0,false));
 assert(!slot.publish(input,Capacity,0,0,false));assert(slot.take(out));
 assert(!strcmp(out.json,"{\"seq\":999}")&&out.capturedMs==999&&out.canWasFresh&&out.canAgeMs==50);
 assert(!slot.pending()&&!slot.take(out));
 float slow=0,fast=0;
 for(int i=0;i<3;i++){slow+=.25f*(4095-slow);fast=nodePotFilterStep(fast,4095);}
 assert(fast/4095>.95f&&slow/4095<.6f); // 300 ms vs old 800 ms to reach 90%.
 float value=2000;
 for(int i=0;i<100;i++){value=nodePotFilterStep(value,2000+(i%2?8:-8));assert(fabsf(value-2000)<3);}
 for(int i=0;i<3;i++)fast=nodePotFilterStep(fast,0);
 assert(fast<180); // deliberate turn-down also tracks quickly, no overshoot.
 puts("PASS compact policy: cadence/wrap, capture+CAN age, all audio gate combinations, bounded latest-only slot, adaptive pot step/noise response. No hardware claim.");
}
