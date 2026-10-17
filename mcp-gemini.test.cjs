'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs');
const path=require('node:path');
const Module=require('node:module');
const http=require('node:http');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {StreamableHTTPClientTransport}=require('@modelcontextprotocol/sdk/client/streamableHttp.js');

test('MCP through the real HTTP router: initialize, list, call, validate, cancel; no real Gemini',async()=>{
  const filename=path.join(__dirname,'server.js'),app=new Module(filename,module);
  app.filename=filename;app.paths=Module._nodeModulePaths(__dirname);
  app._compile(fs.readFileSync(filename,'utf8').replace('const PORT = 3210;','let PORT = 3210;').replace('port:PORT,jobDirectory:', 'port:PORT,jobWaitMs:10,jobDirectory:')+'\nmodule.exports.testServer=server;module.exports.setTestPort=value=>{PORT=value;};module.exports.setTestRunner=runner=>{runConversationEngine=runner;};',filename);
  let calls=0,mode='success',onStarted,onCancelled;
  app.exports.setTestRunner(async(provider,prompt,signal)=>{
    calls++;assert.equal(provider,'gemini');assert(signal instanceof AbortSignal);
    if(mode==='cancel'){onStarted();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{onCancelled();reject(Object.assign(Error('cancelled'),{code:'ABORT_ERR'}));},{once:true}));}
    if(mode==='error')throw Object.assign(Error('private auth diagnostic'),{code:'ENOENT'});
    assert.equal(prompt,'  prompt originale\n  ');return 'Gemini simulato: risposta';
  });
  const server=app.exports.testServer;
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=new URL('http://127.0.0.1:'+server.address().port+'/mcp?client=test');
  app.exports.setTestPort(server.address().port);
  const localFetch=fetch;
  const transport=new StreamableHTTPClientTransport(url,{fetch:localFetch});
  const client=new Client({name:'marco-mcp-test',version:'1.0.0'});
  const raw=(body,headers={},method='POST')=>localFetch(url,{method,headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',...headers},...(method==='GET'?{}:{body:JSON.stringify(body)})});
  try {
    await client.connect(transport);
    const tools=await client.listTools();assert.deepEqual(tools.tools.map(tool=>tool.name),['ask_gemini','gemini_job_status','gemini_job_cancel','run_project_test']);
    const projectRunner=require('./project-test-runner.cjs'),originalProjectRunner=projectRunner.runProjectTest;
    let projectCalls=0;
    projectRunner.runProjectTest=async input=>{projectCalls++;assert.deepEqual(input,{testId:'p1-lineage'});return {testId:input.testId,ok:true,exitCode:0,durationMs:1,stdout:'PASS',stderr:'',firstFailure:null};};
    try {
      const projectResult=await client.callTool({name:'run_project_test',arguments:{testId:'p1-lineage'}});
      assert.equal(projectResult.structuredContent.ok,true);assert.equal(projectCalls,1);
      for(const args of [{testId:'../p2'},{testId:'p2;whoami'},{testId:'p2',args:['--other']},{testId:'p2',timeoutMs:999999},{}])assert.equal((await client.callTool({name:'run_project_test',arguments:args})).isError,true);
      assert.equal(projectCalls,1);
    }finally{projectRunner.runProjectTest=originalProjectRunner;}
    const result=await client.callTool({name:'ask_gemini',arguments:{prompt:'  prompt originale\n  '}});
    assert.deepEqual(result.content,[{type:'text',text:'Gemini simulato: risposta'}]);
    assert.deepEqual(result.structuredContent,{provider:'gemini',answer:'Gemini simulato: risposta'});
    for(const args of [{prompt:''},{prompt:' '},{prompt:42},{},{prompt:'x',context:'forbidden'}]){
      const invalid=await client.callTool({name:'ask_gemini',arguments:args});assert.equal(invalid.isError,true);
    }
    assert.equal(calls,1);
    mode='error';const failed=await client.callTool({name:'ask_gemini',arguments:{prompt:'x'}});assert.equal(failed.isError,true);assert(!JSON.stringify(failed).includes('private auth diagnostic'));
    assert.equal((await raw({}, {Origin:'https://external.test'})).status,403);
    const external=await new Promise(resolve=>{const req=http.request(url,{method:'POST',headers:{Host:'external.test','Content-Type':'application/json'}},res=>{res.resume();resolve(res.statusCode);});req.end('{}');});assert.equal(external,403);
    assert.equal((await raw({}, {},'GET')).status,405);
    mode='cancel';
    const started=new Promise(resolve=>{onStarted=resolve;}),cancelled=new Promise(resolve=>{onCancelled=resolve;});
    const req=http.request(url,{method:'POST',headers:{Host:'127.0.0.1:'+server.address().port,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25'}});
    req.on('error',()=>{});req.end(JSON.stringify({jsonrpc:'2.0',id:99,method:'tools/call',params:{name:'ask_gemini',arguments:{prompt:'cancel'}}}));
    await started;req.destroy();
    const running=await client.callTool({name:'ask_gemini',arguments:{prompt:'cancel'}});assert.equal(running.structuredContent.status,'running');
    const jobId=running.structuredContent.jobId;
    const duplicate=await client.callTool({name:'ask_gemini',arguments:{prompt:'cancel'}});
    assert.equal(duplicate.structuredContent.jobId,jobId);assert.equal(calls,3);
    const state=await client.callTool({name:'gemini_job_status',arguments:{jobId}});assert.equal(state.structuredContent.status,'running');
    const stopped=await client.callTool({name:'gemini_job_cancel',arguments:{jobId}});assert.equal(stopped.structuredContent.status,'cancelled');await cancelled;
    assert.equal(calls,3);
  } finally {await client.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

const os=require("node:os");
const {createGeminiJobs}=require("./mcp-gemini.cjs");
test('Long Gemini result survives transport lifetime, deduplicates and survives restart without replay',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-job-test-'));let resolve,calls=0;
  const runner=async(engine,prompt,signal)=>{calls++;assert.equal(prompt,' original ');assert(!signal.aborted);return new Promise(r=>resolve=r);};
  const options={directory,runner,classifyError:()=>({code:'TEST',message:'safe'}),waitMs:5};
  const jobs=createGeminiJobs(options);
  const pending=await jobs.ask(' original ');assert.equal(pending.status,'running');
  assert.equal((await jobs.ask(' original ')).id,pending.id);assert.equal(calls,1);
  resolve('Final answer');await new Promise(r=>setImmediate(r));
  assert.equal(jobs.status(pending.id).answer,'Final answer');
  const restarted=createGeminiJobs(options);assert.equal(restarted.status(pending.id).answer,'Final answer');
  const next=await jobs.ask(' original ');
  assert.equal(restarted.status(next.id).status,'interrupted');assert.equal(calls,2);
  jobs.cancel(next.id);resolve('late');await new Promise(r=>setImmediate(r));
  assert.equal(jobs.status(next.id).status,'cancelled');
  assert.throws(()=>jobs.status('../outside'));fs.rmSync(directory,{recursive:true,force:true});
});
