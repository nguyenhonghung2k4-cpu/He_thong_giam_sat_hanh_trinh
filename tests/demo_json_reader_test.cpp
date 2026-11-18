#include "../Arduino/ESP32S3_Telematics/demo_json_reader.h"
#include <assert.h>
#include <stdio.h>
#include <string>

static bool valid(const std::string &json){
  return DemoJsonReader(json.c_str(),json.size()).valid();
}
static bool readValues(const std::string &json,float *out,size_t count){
  DemoJsonReader reader(json.c_str(),json.size());DemoJsonSpan command,values;
  return reader.valid()&&reader.objectMember(reader.root(),"command",command)&&
         reader.objectMember(command,"values",values)&&reader.numberArray(values,out,count);
}
int main(){
  float values[600]={};
  assert(valid("{\"command\":{\"values\":[0,-1,1.2e-2],\"note\":\"quoted \\\"values\\\":[]\"}}"));
  assert(!valid("{\"command\":{\"values\":[0,]}}"));
  assert(!valid("{\"command\":{\"values\":[+1]}}"));
  assert(!valid("{\"command\":{\"values\":[01]}}"));
  assert(!valid("{\"command\":{\"values\":[.1]}}"));
  assert(!valid("{\"command\":{\"values\":[1.]}}"));
  assert(!valid("{\"command\":{\"values\":[1e]}}"));
  assert(!valid("{\"command\":{\"values\":[NaN]}}"));
  assert(!valid("{\"command\":{\"values\":[Infinity]}}"));
  assert(!valid("{\"command\":{\"values\":[0]}} garbage"));
  assert(!valid("{\"command\":{\"values\":[0]}}{}"));
  assert(!valid("{\"command\":{\"values\":[0],\"note\":\"\\q\"}}"));
  assert(!valid("{\"command\":{\"values\":[0],\"note\":\"\\u123x\"}}"));
  assert(!valid(std::string(32769,' ')));
  assert(!valid("[[[[[[[[[[[[[[0]]]]]]]]]]]]]]"));
  assert(readValues("{\"command\":{\"values\":[0,-16,16]}}",values,3));
  assert(values[1]==-16&&values[2]==16);
  assert(!readValues("{\"command\":{\"values\":[0,1]}}",values,3));
  assert(!readValues("{\"command\":{\"values\":[0,1,2,3]}}",values,3));
  assert(!readValues("{\"command\":{\"values\":[0,16.00001,0]}}",values,3));
  assert(!readValues("{\"command\":{\"values\":[0,1e999,0]}}",values,3));
  assert(!readValues("{\"command\":{\"values\":[0,null,0]}}",values,3));
  assert(!readValues("{\"command\":{\"values\":[0,{},0]}}",values,3));
  assert(!readValues("{\"command\":{\"values\":[0,1,2],\"values\":[3,4,5]}}",values,3));
  assert(!readValues("{\"command\":{\"note\":\"values\",\"other\":{\"values\":[0,1,2]}}}",values,3));
  std::string actual="{\"command\":{\"values\":[";
  for(size_t i=0;i<600;i++){if(i)actual+=',';actual+=(i%3==2?"0.9961":"0.0039");}
  actual+="]}}";
  assert(readValues(actual,values,600));
  assert(values[2]>0.99f&&values[0]>0.0f);
  const std::string metadata="{\"expires\":1791123456000}";
  DemoJsonReader epochReader(metadata.c_str(),metadata.size());DemoJsonSpan expiry;double epoch=0;
  assert(epochReader.valid()&&epochReader.objectMember(epochReader.root(),"expires",expiry)&&
         epochReader.number(expiry,epoch)&&epoch==1791123456000.0);
  puts("PASS: bounded demo JSON parser, strict numeric array, scope, model-sized window, epoch precision");
}
