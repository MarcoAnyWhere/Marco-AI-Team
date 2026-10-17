'use strict';
const {McpServer}=require('@modelcontextprotocol/sdk/server/mcp.js');
const {StreamableHTTPServerTransport}=require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const {z}=require('zod');

const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');

// Own the runner independently of any HTTP connection. Never replay after a restart.
function createGeminiJobs({directory,runner,classifyError,waitMs=45000}) {
  const active=new Map(),memory=new Map();
  const file=id=>path.join(directory,id+'.json');
  const valid=id=>typeof id==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id);
  function save(job){
    if(!directory){memory.set(job.id,structuredClone(job));return;}
    fs.mkdirSync(directory,{recursive:true});
    const target=file(job.id),temp=target+'.'+crypto.randomUUID()+'.tmp';
    try{const fd=fs.openSync(temp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(job));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,target);}
    finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
  }
  function read(id){
    if(!valid(id))throw Error('Invalid Gemini job ID.');
    let job;
    try{job=directory?JSON.parse(fs.readFileSync(file(id),'utf8')):memory.get(id);}
    catch(error){if(error.code==='ENOENT')throw Error('Gemini job not found.');throw error;}
    if(!job)throw Error('Gemini job not found.');
    if(job.status==='running'&&!active.has(id)){
      job={...job,status:'interrupted',completedAt:new Date().toISOString(),error:{code:'INTERRUPTED',message:'Server restarted; request was not repeated.'}};save(job);
    }
    return job;
  }
  function start(prompt){
    const key=crypto.createHash('sha256').update(prompt).digest('hex');
    for(const entry of active.values())if(entry.key===key)return entry;
    const id=crypto.randomUUID(),controller=new AbortController();
    const job={id,status:'running',createdAt:new Date().toISOString()};save(job);
    const entry={id,key,controller,promise:null};active.set(id,entry);
    entry.promise=Promise.resolve().then(()=>runner('gemini',prompt,controller.signal)).then(answer=>{
      if(controller.signal.aborted)return;
      save({...job,status:'completed',answer,completedAt:new Date().toISOString()});
    },error=>{
      if(controller.signal.aborted)return;
      save({...job,status:'failed',error:classifyError(error),completedAt:new Date().toISOString()});
    }).catch(()=>{
      // A persistence failure must never escape as an unhandled rejection or imply success.
      memory.set(id,{...job,status:'failed',error:{code:'STORAGE_ERROR',message:'Gemini result could not be saved.'}});
    }).finally(()=>active.delete(id));
    return entry;
  }
  async function ask(prompt){
    const entry=start(prompt);let timer;
    try{await Promise.race([entry.promise,new Promise(resolve=>{timer=setTimeout(resolve,waitMs);})]);}
    finally{clearTimeout(timer);}
    return status(entry.id);
  }
  function status(id){return memory.has(id)&&directory?memory.get(id):read(id);}
  function cancel(id){
    const job=status(id),entry=active.get(id);
    if(entry){save({...job,status:'cancelled',completedAt:new Date().toISOString()});entry.controller.abort();}
    return status(id);
  }
  return {ask,status,cancel};
}


const commandStores=new Map();
const jobStores=new Map();
async function handleMcpRequest(req,res,{runner,classifyError,readJsonBody,version,port,jobDirectory,jobWaitMs,commandSelect,commandDirectory}) {
  const hosts=['127.0.0.1:'+port,'localhost:'+port];
  const origins=hosts.map(host=>'http://'+host);
  const fail=(status,code,message)=>{
    if(!res.headersSent&&!res.destroyed){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({jsonrpc:'2.0',id:null,error:{code,message}}));}
  };
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)||!hosts.includes(req.headers.host)||req.headers['sec-fetch-site']==='cross-site'||req.headers.origin&&!origins.includes(req.headers.origin))return fail(403,-32000,'MCP access is restricted to localhost.');
  if(req.method!=='POST'){res.setHeader('Allow','POST');return fail(405,-32000,'Use POST; this MCP endpoint is stateless.');}
  res.setHeader('Cache-Control','no-store');
  let jobs=jobStores.get(jobDirectory||runner);
  if(!jobs){jobs=createGeminiJobs({directory:jobDirectory,runner,classifyError,waitMs:jobWaitMs});jobStores.set(jobDirectory||runner,jobs);}
  const mcp=new McpServer({name:'marco-ai-team-gemini',version});
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true,enableDnsRebindingProtection:true,allowedHosts:hosts,allowedOrigins:origins});
  mcp.registerTool('ask_gemini',{
    description:'Send a prompt unchanged to Gemini using the existing local Antigravity session. Returns its text answer without adding conversation context.',
    inputSchema:z.object({prompt:z.string().refine(value=>value.trim().length>0,'Prompt must not be empty.')} ).strict(),
    outputSchema:{provider:z.literal('gemini'),answer:z.string().optional(),jobId:z.string().optional(),status:z.string().optional()}
  },async({prompt})=>jobResult(await jobs.ask(prompt)));
  function jobResult(job){
    if(job.status==='completed')return {content:[{type:'text',text:job.answer}],structuredContent:{provider:'gemini',answer:job.answer}};
    if(job.status==='running')return {content:[{type:'text',text:'Gemini is still working. Retrieve this same request with gemini_job_status; do not resubmit the prompt. Job: '+job.id}],structuredContent:{provider:'gemini',jobId:job.id,status:job.status}};
    return {isError:true,content:[{type:'text',text:job.error?job.error.code+': '+job.error.message:'Gemini job '+job.status}],structuredContent:{provider:'gemini',jobId:job.id,status:job.status}};
  }
  mcp.registerTool('gemini_job_status',{description:'Retrieve the result of an existing Gemini request without repeating inference.',inputSchema:z.object({jobId:z.string().uuid()}).strict()},async({jobId})=>jobResult(jobs.status(jobId)));
  mcp.registerTool('gemini_job_cancel',{description:'Explicitly cancel an existing Gemini request.',inputSchema:z.object({jobId:z.string().uuid()}).strict()},async({jobId})=>jobResult(jobs.cancel(jobId)));

  if(commandSelect&&commandDirectory){
    let commands=commandStores.get(commandDirectory);
    if(!commands){commands=createMarcoCommand({store:commandDiskStore(commandDirectory),select:commandSelect,runner,classifyError});commandStores.set(commandDirectory,commands);}
    const requestId=z.string().uuid().transform(value=>value.toLowerCase());
    const schema=z.object({action:z.enum(['start','status','cancel','reconcile']),requestId,prompt:z.string().min(1).max(65536).optional(),role:z.enum(['simple','architecture']).optional()}).strict().superRefine((value,ctx)=>{
      if(value.action==='start'?(value.prompt===undefined||value.role===undefined):(value.prompt!==undefined||value.role!==undefined))ctx.addIssue({code:'custom',message:'start requires prompt and role; other actions accept only requestId.'});
    });
    mcp.registerTool('marco_it',{
      description:'Single Marco IT command for text advice and architecture. Start once with a persistent requestId; use status for the same ID. Selects an eligible existing engine and reports its reason. Does not edit code, create candidates, review releases or Apply. Development adapters are not enabled by this command.',
      inputSchema:schema
    },async input=>{
      const {action,requestId,...body}=input;
      try{
        const job=action==='start'?await commands.start({requestId,...body}):await commands[action](requestId);
        return {isError:['failed','blocked','needs_reconciliation'].includes(job.status),content:[{type:'text',text:JSON.stringify(job)}],structuredContent:job};
      }catch(error){
        const known=['INVALID_INPUT','IDEMPOTENCY_CONFLICT','NOT_FOUND'].includes(error?.code);
        const result={id:requestId,error:{code:known?error.code:'COMMAND_ERROR',message:known?error.message:'Command state unavailable; original retained. No automatic retry.'}};
        return {isError:true,content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result};
      }
    });
  }
  mcp.registerTool('run_project_test',{description:'Run one allowlisted local regression suite; no AI inference, arguments or retries.',inputSchema:z.object({testId:z.enum(['p1-lineage','p1-safety','p2','conversation'])}).strict()},async(input)=>{const result=await require('./project-test-runner.cjs').runProjectTest(input);return {isError:!result.ok,content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result};});
  try {
    const body=await readJsonBody(req);
    if(req.aborted||res.destroyed)return;
    await mcp.connect(transport);
    await transport.handleRequest(req,res,body);
  }catch(error){fail(error.status||500,error.status===400?-32700:-32603,error.status?error.message:'MCP request failed.');}
  finally {await mcp.close();}
}

// Control adapter only: never creates candidates, invokes Apply, or edits a repository.
function createMarcoCommand({store,select,runner,classifyError,confirmStopped=async()=>false}) {
  const crypto=require('node:crypto'),active=new Map(),unpersisted=new Map();
  const error=(code,message)=>Object.assign(Error(message),{code});
  const id=value=>{if(typeof value!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value))throw error('INVALID_INPUT','Invalid request ID.');return value.toLowerCase();};
  const save=value=>{store.write(value);return structuredClone(value);};
  const publish=value=>{try{save(value);unpersisted.delete(value.id);return true;}catch{unpersisted.set(value.id,{...value,status:'needs_reconciliation',error:{code:'STORAGE_ERROR',message:'Result could not be persisted; inference will not be repeated.'}});return false;}};
  function status(requestId){
    requestId=id(requestId);if(unpersisted.has(requestId))return structuredClone(unpersisted.get(requestId));
    const job=store.read(requestId);if(!job)throw error('NOT_FOUND','Request not found.');
    if(['selecting','running','cancel_requested'].includes(job.status)&&!active.has(job.id))return save({...job,status:'needs_reconciliation',error:{code:'INTERRUPTED_NO_REPLAY',message:'Previous execution was interrupted. It has not been repeated.'}});
    return structuredClone(job);
  }
  async function start(input){
    if(!input||Object.keys(input).some(k=>!['requestId','prompt','role'].includes(k))||typeof input.prompt!=='string'||!input.prompt.trim()||Buffer.byteLength(input.prompt)>65536||!['simple','architecture'].includes(input.role))throw error('INVALID_INPUT','Supply requestId, a nonempty prompt (maximum 64 KiB), and role simple or architecture. Development is not enabled by this command.');
    const requestId=id(input.requestId),prompt=input.prompt,role=input.role;
    const fingerprint=crypto.createHash('sha256').update(JSON.stringify({prompt,role})).digest('hex');
    const existing=store.read(requestId);
    if(existing){if(existing.fingerprint!==fingerprint)throw error('IDEMPOTENCY_CONFLICT','Request ID already belongs to different input.');return status(requestId);}
    const controller=new AbortController(),entry={controller,promise:null};
    const job={schema:1,id:requestId,fingerprint,role,prompt,status:'selecting',createdAt:new Date().toISOString(),engine:null,modelId:null,reason:null};
    // Exclusive reservation happens before any asynchronous selection or inference.
    try{store.reserve(job);}catch(cause){if(cause?.code!=='EEXIST')throw cause;const prior=store.read(requestId);if(!prior||prior.fingerprint!==fingerprint)throw error('IDEMPOTENCY_CONFLICT','Request ID already belongs to different input.');return structuredClone(prior);}
    active.set(requestId,entry);
    entry.promise=Promise.resolve().then(async()=>{
      const choice=await select(role,controller.signal);
      if(controller.signal.aborted)throw error('ABORT_ERR','Cancelled.');
      if(choice.status!=='selected'){publish({...job,status:'blocked',reason:choice.reason,completedAt:new Date().toISOString()});return;}
      if(!['codex','gemini'].includes(choice.engine)||typeof choice.modelId!=='string'||!choice.modelId||typeof choice.reason!=='string')throw error('INVALID_SELECTION','Invalid trusted engine selection.');
      Object.assign(job,{engine:choice.engine,modelId:choice.modelId,reason:choice.reason,quotaStatus:choice.quotaStatus,status:'running'});if(!publish(job))return;
      const answer=await runner(choice.engine,prompt,controller.signal,{modelId:choice.modelId});
      if(controller.signal.aborted)throw error('ABORT_ERR','Cancelled.');
      if(typeof answer!=='string'||!answer.trim())throw error('EMPTY_ANSWER','Runner returned no answer.');
      publish({...job,status:'completed',answer,completedAt:new Date().toISOString()});
    }).catch(cause=>{
      let failure;try{failure=classifyError(cause);}catch{failure={code:'COMMAND_ERROR',message:'Execution failed.'};}
      const ambiguous=controller.signal.aborted||cause?.timedOut||['ETIMEDOUT','ABORT_ERR','TIMEOUT'].includes(cause?.code)||['TIMEOUT','CANCELLED'].includes(failure?.code);
      publish({...job,status:ambiguous?'needs_reconciliation':'failed',error:failure,completedAt:new Date().toISOString()});
    }).finally(()=>{active.delete(requestId);});
    return status(requestId);
  }
  function cancel(requestId){
    requestId=id(requestId);
    const job=status(requestId),entry=active.get(requestId);
    if(entry&&['selecting','running'].includes(job.status)){publish({...job,status:'cancel_requested'});entry.controller.abort();}
    return status(requestId);
  }
  async function reconcile(requestId){
    requestId=id(requestId);
    const job=status(requestId);
    if(job.status!=='needs_reconciliation')return job;
    if(active.has(requestId)||await confirmStopped(job)!==true)return job;
    publish({...job,status:'interrupted',reconciledAt:new Date().toISOString()});return status(requestId);
  }
  return {start,status,cancel,reconcile,settled:async requestId=>{await active.get(requestId)?.promise;return status(requestId);}};
}

function commandDiskStore(directory){
  const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
  const checked=target=>{let current=path.resolve(target);for(;;){try{if(fs.lstatSync(current).isSymbolicLink())throw Error('Linked command storage is not allowed.');}catch(e){if(e.code!=='ENOENT')throw e;}const parent=path.dirname(current);if(parent===current)break;current=parent;}return target;};
  const file=id=>{if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id))throw Error('Invalid request ID.');return checked(path.join(checked(directory),id+'.json'));};
  function write(job,exclusive=false){
    checked(directory);fs.mkdirSync(directory,{recursive:true});const target=file(job.id);
    // Exclusive creation reserves identity even if a crash leaves partial JSON.
    // Partial state is retained and rejected; it never authorizes an invocation.
    if(exclusive){const fd=fs.openSync(target,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(job));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}return;}
    const temp=target+'.'+crypto.randomUUID()+'.tmp';
    try{const fd=fs.openSync(temp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(job));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,target);}
    finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
  }
  return {read:id=>{const target=file(id);try{const value=JSON.parse(fs.readFileSync(target,'utf8'));if(value.schema!==1||value.id!==id||typeof value.fingerprint!=='string'||typeof value.status!=='string')throw Error('Invalid command record; original retained.');return value;}catch(e){if(e.code==='ENOENT')return null;throw e;}},write,reserve:job=>write(job,true)};
}




// Pure policy: no processes, model calls, quota refreshes or job retries.
function selectModel({ role, models, quota, now = Date.now(), codexReserve = false }) {
  const families = {
    simple: ['flash', 'pro', 'argon', 'codex'],
    development: ['pro', 'argon', 'codex'],
    architecture: ['argon', 'pro', 'codex'],
    review: ['pro', 'argon', 'codex']
  };
  if (!Object.hasOwn(families, role) || !Array.isArray(models) || !Number.isFinite(now)) {
    throw new TypeError('Invalid routing input');
  }
  const bucketIds = {
    flash: ['gemini-5h', 'gemini-weekly'],
    pro: ['gemini-5h', 'gemini-weekly'],
    argon: ['gemini-argon-wtu-weekly'],
    codex: ['codex-short', 'codex-weekly']
  };
  const seen = new Set();
  const eligible = models.filter(model => {
    if (!model || typeof model.id !== 'string' || !model.id || seen.has(model.id)) {
      throw new TypeError('Invalid or duplicate model');
    }
    seen.add(model.id);
    return families[role].includes(model.family) && model.available === true &&
      Array.isArray(model.certifiedRoles) && model.certifiedRoles.includes(role) &&
      !(model.family === 'codex' && codexReserve);
  }).map(model => {
    const windows = bucketIds[model.family].map(id => quota?.[id]);
    const valid = window => window && Number.isFinite(window.remainingPercent) &&
      window.remainingPercent >= 0 && window.remainingPercent <= 100 &&
      Number.isFinite(window.observedAt) && now >= window.observedAt &&
      now - window.observedAt <= 300000 && Number.isFinite(window.resetsAt) && window.resetsAt > now;
    const blocked = windows.some(window => valid(window) && window.remainingPercent === 0);
    const fresh = windows.every(valid);
    const tight = windows.some(window => valid(window) && window.remainingPercent <= 10);
    return { model, blocked, tier: tight ? 2 : (fresh ? 0 : 1) };
  }).filter(item => !item.blocked);
  eligible.sort((a, b) => a.tier - b.tier ||
    families[role].indexOf(a.model.family) - families[role].indexOf(b.model.family) ||
    b.model.id.localeCompare(a.model.id, 'en', { numeric: true }));
  if (!eligible.length) return { status: 'blocked', reason: 'NO_ELIGIBLE_MODEL' };
  const selected = eligible[0];
  return { status: 'selected', modelId: selected.model.id, family: selected.model.family,
    quotaStatus: ['available', 'unknown', 'reserve'][selected.tier],
    reason: 'ROLE_CAPABILITY_QUOTA_POLICY' };
}



module.exports={handleMcpRequest,createGeminiJobs,createMarcoCommand,commandDiskStore,selectModel};
