import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync('scripts/apps-script-email-leads/Code.gs', 'utf8');
const initial = 1793490000000;
const store = {lead_cursor_ms:String(initial), lead_start_ms:String(initial), LEAD_WEBHOOK_URL:'https://trade-pilot-ochre.vercel.app/api/webhooks/inbound-email-lead', LEAD_WEBHOOK_SECRET:'test'};
const rows = [
  {id:'abc1', time:initial + 1000, labels:['INBOX'], body:'Please quote our house'},
  {id:'abc2', time:initial + 2000, labels:['SPAM'], body:'Please paint our roof'},
  {id:'abc3', time:initial + 3000, labels:['SENT'], body:'Our quote'},
  {id:'old', time:initial - 1000, labels:['INBOX'], body:'Old mail'},
];
let fail = false;
let requests = [];
const props = {getProperty:k=>store[k] || null, setProperty:(k,v)=>{store[k]=v;}, getProperties:()=>({...store}), deleteProperty:k=>{delete store[k];}};
const messages = {
  list:(_user,options)=>{ assert.equal(options.includeSpamTrash,true); return {messages:rows.map(({id})=>({id}))}; },
  get:(_user,id,options)=>{
    const r=rows.find(x=>x.id===id);
    if(options.format==='metadata') return {id,internalDate:String(r.time),labelIds:r.labels};
    return {payload:{mimeType:'text/plain',headers:[{name:'From',value:'Customer <c@example.com>'},{name:'Subject',value:'Painting'},{name:'Message-ID',value:`<${id}@example.com>`}],body:{data:Buffer.from(r.body).toString('base64url')}}};
  },
  Attachments:{get:()=>{throw Error('unexpected attachment');}},
};
const context = {Gmail:{Users:{Messages:messages}}, PropertiesService:{getScriptProperties:()=>props}, LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock:()=>{}})},
  Utilities:{base64DecodeWebSafe:s=>Buffer.from(s,'base64url'),newBlob:b=>({getDataAsString:()=>b.toString('utf8')})},
  UrlFetchApp:{fetch:(_url,options)=>{const body=JSON.parse(options.payload);if (!body.scanner_heartbeat) requests.push(body); if(fail && body.gmail_message_id==='abc2')return {getResponseCode:()=>503,getContentText:()=>'{"ok":false}'};return {getResponseCode:()=>200,getContentText:()=>'{"ok":true}'};}}, console, Date:class extends Date {static now(){return initial+100000;}}};
vm.createContext(context);
vm.runInContext(source,context);
fail=true;
assert.throws(()=>context.processEmailLeads(),/retry pending/);
assert.equal(store.lead_cursor_ms,String(initial));
assert.ok(store.lead_message_abc1);
assert.equal(store.lead_message_abc2,undefined);
fail=false;
context.processEmailLeads();
assert.deepEqual(requests.map(x=>x.gmail_message_id),['abc1','abc2','abc2']);
assert.equal(requests[0].plain,rows[0].body);
assert.equal(requests[1].headers['Message-ID'],'<abc2@example.com>');
assert.ok(Number(store.lead_cursor_ms)>=initial+2000);
context.processEmailLeads();
assert.equal(requests.length,3);
console.log('Incoming lead forwarding checks passed');
