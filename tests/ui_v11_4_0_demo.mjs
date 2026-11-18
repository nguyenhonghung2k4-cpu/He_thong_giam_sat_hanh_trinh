// Minimal DOM bootstrap/interaction test. No browser prediction is generated;
// ACK fixture is MOCKED solely to verify how the UI displays a server result.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
class Element{
  constructor(tag='div'){this.tag=tag;this.children=[];this.dataset={};this.handlers={};this.textContent='';this.classList={toggle(){}};this.clientWidth=300;}
  append(...items){this.children.push(...items);}replaceChildren(...items){this.children=[...items];}setAttribute(){}addEventListener(name,fn){this.handlers[name]=fn;}
  getContext(){return {scale(){},clearRect(){},beginPath(){},moveTo(){},lineTo(){},stroke(){}};}
}
const ids=new Map(['demo-tinyml-status','demo-tinyml-gateway','demo-tinyml-samples'].map(id=>[id,new Element()]));
const walk=node=>[node,...node.children.flatMap(walk)];
const document={getElementById:id=>ids.get(id)||null,createElement:tag=>new Element(tag),querySelectorAll:selector=>[...ids.values()].flatMap(walk).filter(node=>selector==='[data-demo-sample]'?node.dataset.demoSample:node.className==='demo-tinyml-wave')};
const session='ui-bootstrap-session',device='blackbox-esp32s3-auto-demo';let position=null,interval=null,posted=null;
const catalog={ok:true,demo:{running:true,session_id:session,device_id:device},gateway:{online:true,device_id:'mock-gateway'},samples:['pothole','speed_bump'].map(id=>({id,frequency_hz:100,frame_samples:200,units:'g',source_file:'MOCK_UI_FIXTURE_ONLY.csv',source_start_row:1,values:Array(600).fill(0)}))};
const window={devicePixelRatio:1,telematicsDashboard:{getDisplayedVehiclePosition:()=>position},setTimeout,clearInterval(){},setInterval(fn){interval=fn;return 1;},addEventListener(){},dispatchEvent(){}};
const fetch=async(path,options={})=>{
  let body=catalog;
  if(options.method==='POST'){posted=JSON.parse(options.body);position={lat:30,lon:120,device_id:device,boot_id:session};body={ok:true,command:{id:42}};}
  else if(path.includes('/api/device-commands/'))body={ok:true,command:{status:'done',result:{label:'duong_bang_phang',confidence:.98,map_point_created:false,test_transport_mock:true}}};
  return {ok:true,status:200,json:async()=>body};
};
const source=readFileSync(join(dirname(fileURLToPath(import.meta.url)),'..','WebDashboard_Online','public','demo-tinyml.js'),'utf8');
vm.runInNewContext(source,{window,document,fetch,AbortSignal,requestAnimationFrame:fn=>fn(),clearInterval,CustomEvent:class{constructor(type,options){this.type=type;this.detail=options?.detail;}},console});
await new Promise(setImmediate);
let buttons=document.querySelectorAll('[data-demo-sample]');assert.equal(buttons.length,2);assert.ok(buttons.every(b=>b.disabled));assert.match(ids.get('demo-tinyml-status').textContent,/Đang chờ vị trí/);
position={lat:20.904123,lon:105.826789,device_id:device,boot_id:session};await interval();assert.ok(buttons.every(b=>!b.disabled));assert.match(ids.get('demo-tinyml-status').textContent,/Chọn mẫu/);
await buttons[0].handlers.click();assert.deepEqual(posted.position,{lat:20.904123,lon:105.826789});assert.equal(posted.session_id,session);assert.equal(posted.sample_id,'pothole');assert.match(ids.get('demo-tinyml-status').textContent,/Đường bằng phẳng/);assert.match(ids.get('demo-tinyml-status').textContent,/20\.904123/);assert.match(ids.get('demo-tinyml-status').textContent,/Không tạo điểm/);
const resultText=ids.get('demo-tinyml-status').textContent;await interval();assert.equal(ids.get('demo-tinyml-status').textContent,resultText,'Catalog polling overwrote actual last result');
position={...position,boot_id:'old-session'};await interval();assert.ok(buttons.every(b=>b.disabled),'Old displayed session could send sample');
console.log('PASS UI bootstrap: readiness gate, enabled idle hint, synchronous visible-coordinate capture, actual ACK label not selected sample, last result retained, session isolation.');
