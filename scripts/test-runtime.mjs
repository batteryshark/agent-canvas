// Native test: the real opencode 2 binary with isolated XDG directories, the built plugin, and a local
// deterministic fixture model. Run after `npm run build`. OPENCODE_BIN overrides the binary.
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,openSync,closeSync,existsSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {createServer as createHTTPServer} from 'node:http';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {OpenCode} from '@opencode/client';

const root=resolve('.');
for(const file of ['dist/opencode/index.js','dist/opencode/canvas-service.cjs'])if(!existsSync(join(root,file)))throw new Error(`Missing ${file}. Run npm run build first.`);
// realpath: OpenCode may canonicalize directories, and macOS temp paths are symlinks.
const home=realpathSync(mkdtempSync(join(tmpdir(),'canvas-native-'))),project=join(home,'project');
mkdirSync(join(root,'.runtime'),{recursive:true});
const freePort=async()=>{const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;};
const port=await freePort(),canvasPort=await freePort(),modelPort=await freePort(),password=randomBytes(24).toString('hex');
const env={...process.env,XDG_DATA_HOME:join(home,'data'),XDG_CONFIG_HOME:join(home,'config'),XDG_CACHE_HOME:join(home,'cache'),XDG_STATE_HOME:join(home,'state'),
  AGENT_CANVAS_HOME:join(home,'canvas'),AGENT_CANVAS_PORT:String(canvasPort),OPENCODE_SERVER_PASSWORD:password,CANVAS_TEST_MODEL_PORT:String(modelPort),OPENUI_TELEMETRY_DISABLED:'1'};
// Record the isolated service's PID so the real plugin can autostart it and the test can stop it.
const pidFile=join(home,'canvas.pid'),pidHook=join(home,'record-service.mjs');
writeFileSync(pidHook,`import {writeFileSync} from 'node:fs';if(process.argv[1]?.endsWith('canvas-service.cjs'))writeFileSync(${JSON.stringify(pidFile)},String(process.pid));`);
env.AGENT_CANVAS_NODE=process.execPath;
env.NODE_OPTIONS=`${env.NODE_OPTIONS||''} --import=${pathToFileURL(pidHook).href}`;
mkdirSync(join(home,'config/opencode'),{recursive:true});mkdirSync(project);mkdirSync(join(home,'model'));
writeFileSync(join(home,'model/package.json'),JSON.stringify({name:'canvas-test-model',type:'module',main:'index.js'}));
await build({entryPoints:[join(root,'test/runtime-model.ts')],outfile:join(home,'model/index.js'),bundle:true,platform:'node',format:'esm',logLevel:'warning'});
writeFileSync(join(home,'config/opencode/opencode.json'),JSON.stringify({plugins:[pathToFileURL(join(root,'dist/opencode')).href,pathToFileURL(join(home,'model')).href]}));

const OPENUI=[
  'root = Stack([header, chart, table, form])',
  'header = CardHeader("Release plan", "Pick the next milestone")',
  'chart = BarChart(["Q1", "Q2", "Q3"], [Series("Shipped", [4, 7, 9])])',
  'table = Table([Col("Milestone", ["Alpha", "Beta", "GA"]), Col("Status", ["done", "active", "planned"])])',
  'form = Form("next", Buttons([submit]), [choice])',
  'choice = FormControl("Next milestone", Select("milestone", [SelectItem("beta", "Beta"), SelectItem("ga", "GA")]))',
  'submit = Button("Choose milestone", @ToAssistant("Choose milestone"), "primary")',
].join('\n');
const BROKEN='root = Stack([header, Missing("x")])\nheader = CardHeader("Release plan")';
const HTML=`<!doctype html>
<html><head><meta charset="utf-8"><title>Layout choice</title>
<style>body{font-family:var(--font-sans);background:var(--background);color:var(--foreground);padding:16px}</style></head>
<body><h1>Pick a layout</h1>
<form data-canvas-action="Choose layout">
<label><input type="radio" name="layout" value="A" checked> Sidebar</label>
<label><input type="radio" name="layout" value="B"> Top bar</label>
<button type="submit">Send to the agent</button>
</form>
<script>document.querySelector('h1').textContent+=' (revision '+canvas.view.revision+')';</script>
</body></html>`;

// The fixture model: what it does depends only on the last user message and how many tool results follow it.
const text=m=>{const c=m?.content;return typeof c==='string'?c:Array.isArray(c)?c.map(p=>typeof p==='string'?p:p?.text??JSON.stringify(p)).join('\n'):JSON.stringify(c??'');};
function respond(messages){
  let lastUser=-1;messages.forEach((m,i)=>{if(m.role==='user')lastUser=i;});
  const said=text(messages[lastUser]),step=messages.slice(lastUser+1).filter(m=>m.role==='tool').length;
  const call=(name,args)=>({name,args}),reply=content=>({content});
  const input=/\[Agent Canvas\] .*? \(view ([0-9a-f-]{36}), revision \d+\)/.exec(said);
  if(input)return step===0?call('canvas_read',{viewId:input[1]}):reply('Received your Canvas input.');
  const revise=/Revise project view ([0-9a-f-]{36})/.exec(said);
  if(revise)return [
    call('canvas_read',{viewId:revise[1]}),
    call('canvas_show',{viewId:revise[1],expectedRevision:1,title:'Revised by the second conversation',summary:'Revised plan.',format:'openui',source:OPENUI.replace('Pick the next milestone','Revised in the second conversation')}),
  ][step]??reply('Revised the project view.');
  const read=/Read project view ([0-9a-f-]{36})/.exec(said);
  if(read)return step===0?call('canvas_read',{viewId:read[1]}):reply('Read the latest project view.');
  if(said.includes('Show the release plan in Agent Canvas'))return [
    call('canvas_guide',{topic:'openui'}),
    call('canvas_show',{title:'Release plan',summary:'Shipped work and the next milestone.',format:'openui',source:BROKEN}),
    call('canvas_show',{title:'Release plan',summary:'Shipped work and the next milestone.',format:'openui',source:OPENUI}),
    call('canvas_show',{title:'Layout choice',summary:'Pick a layout for the settings page.',format:'html',source:HTML}),
  ][step]??reply('The Canvas views are ready.');
  return reply('A plain reply without Canvas.');
}
const modelRequests=[];
const modelServer=createHTTPServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  const body=JSON.parse(raw);modelRequests.push(body);
  const next=respond(body.messages);
  const delta=next.name
    ?{role:'assistant',tool_calls:[{index:0,id:`call_${randomUUID().replaceAll('-','')}`,type:'function',function:{name:next.name,arguments:JSON.stringify(next.args)}}]}
    :{role:'assistant',content:next.content};
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  for(const item of [{choices:[{index:0,delta,finish_reason:null}]},{choices:[{index:0,delta:{},finish_reason:next.name?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}}])res.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',...item})}\n\n`);
  res.end('data: [DONE]\n\n');
});
await new Promise(r=>modelServer.listen(modelPort,'127.0.0.1',r));
const lastIsTool=(body,pattern)=>body.messages.at(-1)?.role==='tool'&&pattern.test(text(body.messages.at(-1)));
const toolSaw=pattern=>modelRequests.some(b=>b.messages.some(m=>m.role==='tool'&&pattern.test(text(m))));

const log=openSync(join(home,'runtime.log'),'w',0o600),children=[];
let serviceStopped=false;
function stopService(){if(serviceStopped)return;try{process.kill(Number(readFileSync(pidFile,'utf8')),'SIGTERM');serviceStopped=true;}catch{}}
process.on('exit',()=>{for(const child of children)child.kill('SIGTERM');stopService();});
function launch(command,args){const c=spawn(command,args,{env,cwd:project,stdio:['ignore',log,log]});children.push(c);return c;}
const timeout=async(fn,description,ms=30000)=>{const deadline=Date.now()+ms;let last;while(Date.now()<deadline){try{const value=await fn();if(value)return value;}catch(e){last=e;}await new Promise(r=>setTimeout(r,200));}throw new Error(`Timed out: ${description}. ${last?.message||''}`);};
try {
  launch(process.env.OPENCODE_BIN||'opencode',['serve','--hostname','127.0.0.1','--port',String(port),'--print-logs']);
  const api=OpenCode.make({baseUrl:`http://127.0.0.1:${port}`,headers:{Authorization:`Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`}});
  const info=await timeout(()=>api.server.info(),'server startup');
  const plugins=await timeout(async()=>{const p=await api.plugin.list();return p.data.some(x=>x.id==='agent-canvas')&&p.data.some(x=>x.id==='canvas-runtime-test-model')?p:undefined;},'plugin load');
  console.log('Runtime',info.version,'plugins',JSON.stringify(plugins.data.filter(p=>p.source.type!=='builtin')));
  const canvasPlugin=plugins.data.find(p=>p.id==='agent-canvas');
  assert.equal(canvasPlugin.state.status,'active',`Canvas plugin must load: ${JSON.stringify(canvasPlugin.state)}`);
  const config=JSON.parse(readFileSync(join(home,'canvas/connection.json'),'utf8'));
  assert.equal(config.endpoint,`http://127.0.0.1:${canvasPort}`);
  await timeout(async()=>Number(readFileSync(pidFile,'utf8'))>0&&(await fetch(`${config.endpoint}/health`)).ok,'the plugin autostarts its packaged service');
  async function canvas(path,body,token=config.token){const r=await fetch(`${config.endpoint}${path}`,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const value=await r.json();if(!r.ok)throw new Error(JSON.stringify(value));return value;}
  const newSession=title=>api.session.create({title,location:{directory:project},model:{providerID:'canvas-test',id:'fixture'},permissions:[{action:'*',resource:'*',effect:'allow'}]});
  const settle=sessionID=>api.session.wait({sessionID},{signal:AbortSignal.timeout(20000)});
  const snapshot=key=>canvas('/api/snapshot',undefined,key);
  const delivered=(key,id,what)=>timeout(async()=>(await snapshot(key)).interactions.find(a=>a.id===id&&a.status==='delivered'),what);

  // 1. The agent reads the guide, repairs an invalid view, then shows an OpenUI view and an HTML page.
  const session=await newSession('Agent Canvas runtime validation');
  await api.session.prompt({sessionID:session.id,text:'Show the release plan in Agent Canvas.'});
  const registered=await timeout(()=>canvas('/agent/resolve',{sessionId:session.id,directory:project}),'session registration');
  const shown=await timeout(async()=>{const s=await snapshot(registered.viewerKey);return s.views.length>=2?s:undefined;},'both canvas_show calls');
  await settle(session.id);
  const firstTurn=modelRequests.find(b=>JSON.stringify(b.messages).includes('Show the release plan in Agent Canvas'));
  const toolNames=(firstTurn.tools??[]).map(t=>t.function?.name??t.name);
  for(const name of ['canvas_guide','canvas_show','canvas_read','canvas_pin'])assert.ok(toolNames.includes(name),`${name} must be a direct tool (codemode off); got ${toolNames.join(', ')}`);
  assert.match(JSON.stringify(firstTurn.messages),/Agent Canvas is available/,'the system note reaches the model');
  assert.ok(toolSaw(/Component Signatures/),'canvas_guide returns the OpenUI reference');
  assert.ok(toolSaw(/Unknown component[\s\S]*Nothing was saved/),'invalid content returns repairable errors to the model');
  assert.equal(shown.views.length,2,'the invalid view was not saved');
  const openuiView=shown.views.find(v=>v.revision.format==='openui'),htmlView=shown.views.find(v=>v.revision.format==='html');
  assert.ok(openuiView&&htmlView,'one OpenUI view and one HTML view');
  assert.equal(openuiView.revision.title,'Release plan');
  assert.equal(htmlView.revision.title,'Layout choice');
  for(const view of [openuiView,htmlView])assert.ok(toolSaw(new RegExp(`- View: ${view.id}[\\s\\S]*- Revision: 1[\\s\\S]*- Link: ${config.publicUrl.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}/#key=`)),`canvas_show returns the id, revision and link of ${view.revision.title}`);

  // 2. The user sends input from the HTML page; a duplicate submission is admitted once.
  await canvas('/api/pin',{viewId:openuiView.id,name:'Release plan',expectedRevision:1},registered.viewerKey);
  const note='Keep the old header.';
  const input={id:randomUUID(),sessionKey:registered.key,viewId:htmlView.id,revision:1,action:'Choose layout',data:{layout:'B'},notes:note};
  const queued=await canvas('/api/submit',input,registered.viewerKey);
  const repeated=await canvas('/api/submit',input,registered.viewerKey);
  assert.equal(repeated.messageId,queued.messageId,'a repeated submission is the same interaction');
  await assert.rejects(canvas('/api/submit',{...input,action:'Choose layout A'},registered.viewerKey),/different input/);
  const firstDelivery=await delivered(registered.viewerKey,input.id,'delivery of the HTML input');
  assert.equal(firstDelivery.sessionKey,registered.key);
  await timeout(()=>modelRequests.some(b=>lastIsTool(b,/Choose layout.*Keep the old header/)),'the agent reads the input back with canvas_read');
  await settle(session.id);
  const messages=await api.message.list({sessionID:session.id,limit:200});
  const admitted=messages.data.filter(m=>m.type==='user'&&m.text.includes(note));
  assert.equal(admitted.length,1,'exactly one user message despite the duplicate submission');
  assert.ok(admitted[0].text.startsWith(`[Agent Canvas] Layout choice (view ${htmlView.id}, revision 1)\nAction: Choose layout`),admitted[0].text);

  // 3. A second conversation finds the pinned view, revises it, and the first keeps its snapshot.
  const second=await newSession('Second Canvas conversation');
  await api.session.prompt({sessionID:second.id,text:`Revise project view ${openuiView.id}`});
  const secondKey=await timeout(()=>canvas('/agent/resolve',{sessionId:second.id,directory:project}),'second registration');
  await timeout(async()=>(await snapshot(secondKey.viewerKey)).views.find(v=>v.id===openuiView.id)?.revision.number===2,'cross-session revision');
  await settle(second.id);
  assert.ok(toolSaw(/pinned as project view "Release plan"/),'the second conversation reads the pinned project view');
  const kept=(await snapshot(registered.viewerKey)).views.find(v=>v.id===openuiView.id);
  assert.equal(kept.revision.number,1,'the first conversation keeps its snapshot');
  assert.equal(kept.revision.title,'Release plan');
  assert.equal(kept.latest,2);
  await assert.rejects(canvas('/api/submit',{id:randomUUID(),sessionKey:registered.key,viewId:openuiView.id,revision:1,action:'Choose milestone',data:null,notes:''},registered.viewerKey),/newer revision/,'a stale revision cannot submit');
  await api.session.prompt({sessionID:session.id,text:`Read project view ${openuiView.id}`});
  const latestRead=await timeout(()=>modelRequests.find(b=>JSON.stringify(b.messages).includes(`Read project view ${openuiView.id}`)&&b.messages.at(-1)?.role==='tool'),'the first conversation reads the project view');
  assert.match(text(latestRead.messages.at(-1)),/Revised by the second conversation/,'canvas_read returns the latest project revision');
  await settle(session.id);

  // 4. Input from the project view reaches the conversation that sent it, not the one that created the view.
  const secondNote='This input belongs to the second conversation.';
  const secondInput={id:randomUUID(),sessionKey:secondKey.key,viewId:openuiView.id,revision:2,action:'Choose milestone',data:{form:{milestone:'ga'}},notes:secondNote};
  await canvas('/api/submit',secondInput,secondKey.viewerKey);
  await delivered(secondKey.viewerKey,secondInput.id,'delivery to the consuming conversation');
  await timeout(()=>modelRequests.some(b=>lastIsTool(b,/This input belongs to the second conversation/)),'the second conversation answers its input');
  await settle(second.id);
  const secondMessages=await api.message.list({sessionID:second.id,limit:200});
  assert.equal(secondMessages.data.filter(m=>m.type==='user'&&m.text.startsWith('[Agent Canvas]')&&m.text.includes(secondNote)).length,1);
  const firstMessages=await api.message.list({sessionID:session.id,limit:200});
  assert.equal(firstMessages.data.filter(m=>m.type==='user'&&m.text.includes(secondNote)).length,0);

  // 5. Ordinary chat keeps working while Canvas is down.
  stopService();
  await timeout(async()=>{try{await fetch(`${config.endpoint}/health`);return false;}catch{return true;}},'service shutdown');
  const beforeOutage=modelRequests.length;
  await api.session.prompt({sessionID:session.id,text:'Reply without Canvas while its service is offline.'},{signal:AbortSignal.timeout(15000)});
  await timeout(()=>modelRequests.length>beforeOutage,'a model request during the outage',15000);
  await settle(session.id);
  const outage=await api.message.list({sessionID:session.id,limit:200});
  assert.ok(outage.data.some(m=>m.type==='assistant'&&JSON.stringify(m).includes('A plain reply without Canvas.')),'the reply arrives during the outage');

  const report={passed:true,version:info.version,sessionId:session.id,checks:[
    'native plugin load','packaged service autostart','direct tools and system note','canvas_guide returns the OpenUI reference',
    'invalid content returns repairable errors','canvas_show openui','canvas_show html','viewer input admitted exactly once',
    'duplicate submission suppressed','reused submission id with different input rejected','agent reads input back with canvas_read',
    'pinned project view','cross-session revision','original snapshot preserved','stale revision cannot submit','latest revision read',
    'project view input targets the consuming conversation','ordinary chat survives a Canvas outage',
  ],log:join(home,'runtime.log')};
  writeFileSync(join(root,`.runtime/native-${info.version}.json`),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
} catch(error) {
  console.error('Log:',join(home,'runtime.log'));
  console.error(readFileSync(join(home,'runtime.log'),'utf8').split('\n').filter(l=>/ERROR|WARN/.test(l)).join('\n').slice(-6000));
  throw error;
} finally {
  for(const c of children)c.kill('SIGTERM');
  stopService();
  await Promise.all(children.map(c=>new Promise(r=>{if(c.exitCode!==null)return r();c.once('exit',r);setTimeout(()=>{c.kill('SIGKILL');r();},3000).unref();})));
  modelServer.closeAllConnections();await new Promise(r=>modelServer.close(r));
  closeSync(log);
}
