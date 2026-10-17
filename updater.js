const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const crypto = require('crypto');
const net = require('net');

// The host retains verified parent bytes and write-once child bindings outside stages.
function nativeLineageStore(io, files, historicalFiles=files) {
  const digest = value => crypto.createHash('sha256').update(value).digest('hex');
  const invalid = message => { throw Object.assign(new Error(message), {failureCause:'LINEAGE_INVALID'}); };
  const immutable = value => { if(value && typeof value === 'object'){ for(const item of Object.values(value)) immutable(item); Object.freeze(value); } return value; };
  const snapshot = reader => files.map(file => ({path:file, bytes:reader(file).toString('base64')}));
  const contentSeal = entries => entries.map(entry => entry.path + ':' + digest(Buffer.from(entry.bytes,'base64'))).join('|');
  const expanded=JSON.stringify(files)!==JSON.stringify(historicalFiles);
  const inventoryId=digest(JSON.stringify(files));
  const parentId = parent => 'root:' + digest(JSON.stringify(parent.schema===2?
    {schema:2,version:parent.version,files:parent.files,inventoryId:parent.inventoryId,maintenanceRecordSha256:parent.maintenanceRecordSha256}:
    {version:parent.version,files:parent.files}));
  const versionOf = entries => Buffer.from(entries.find(entry=>entry.path==='server.js').bytes,'base64').toString('utf8').match(/const VERSION = "([^"]+)";/)?.[1];
  const verify = parent => {
    const expected=parent?.schema===1?historicalFiles:files;
    if(![1,2].includes(parent?.schema) || !Array.isArray(parent.files) || parent.files.length!==expected.length) invalid('Missing parent snapshot');
    if(parent.schema===2 && (!expanded || parent.inventoryId!==inventoryId || !(parent.maintenanceRecordSha256===null || /^[a-f0-9]{64}$/.test(parent.maintenanceRecordSha256)))) invalid('Invalid maintained parent identity');
    for(let n=0;n<expected.length;n++){
      const entry=parent.files[n];
      if(entry?.path!==expected[n] || typeof entry.bytes!=='string' || Buffer.from(entry.bytes,'base64').toString('base64')!==entry.bytes) invalid('Invalid parent bytes');
    }
    if(versionOf(parent.files)!==parent.version || parentId(parent)!==parent.id || contentSeal(parent.files)!==parent.parentSeal) invalid('Parent seal mismatch');
    return parent;
  };
  const parentForRoot = () => {
    const entries=snapshot(io.rootRead);
    const parent={schema:expanded?2:1,version:versionOf(entries),files:entries,parentSeal:contentSeal(entries)};
    if(expanded)Object.assign(parent,{inventoryId,maintenanceRecordSha256:io.maintenanceIdentity?.()||null});
    if(parent.version==='3.3.28'){
      if(expanded)invalid('Bootstrap inventory cannot be expanded');
      if(digest(Buffer.from(entries.find(x=>x.path==='server.js').bytes,'base64'))!=='a82d4229583de676467b7d1597919614b14d15092eb34ec3bb912c426a0df6fe') invalid('Unverified bootstrap ROOT');
    }else{
      const installed=io.read('installed');
      if(expanded){
        if(installed?.schema!==1 || installed.version!==parent.version)invalid('Untrusted installed ROOT');
        if(installed.stageSeal!==parent.parentSeal){
          const bridge=io.verifiedMaintenance?.({currentSeal:parent.parentSeal,installed});
          if(bridge?.schema!==2 || bridge.currentSeal!==parent.parentSeal || bridge.originalSeal!==installed.stageSeal || bridge.version!==installed.version || bridge.stageId!==installed.stageId || !/^[a-f0-9]{64}$/.test(bridge.recordSha256||'') || bridge.authorizesApply!==false || bridge.authorizesRelease!==false || bridge.authorizesPublish!==false)invalid('Missing authenticated inventory transition');
          parent.maintenanceRecordSha256=bridge.recordSha256;
        }
      }else{
      if(installed?.schema!==1 || installed.version!==parent.version || installed.stageSeal!==(io.acceptedInstalledSeal?io.acceptedInstalledSeal(parent.parentSeal):parent.parentSeal)) invalid('Untrusted installed ROOT');
      }
      const child=io.read('child-'+installed.stageId), approved=io.read('seal-'+installed.stageId);
      if(!child || !approved || approved.stageId!==installed.stageId || approved.stageSeal!==installed.stageSeal || child.baseStageId!==approved.baseStageId || child.parentSeal!==approved.parentSeal) invalid('Missing installed lineage evidence');
      const prior=verify(io.read('parent-'+child.baseStageId.slice(5)));
      if(prior.parentSeal!==child.parentSeal) invalid('Installed parent mismatch');
    }
    parent.id=parentId(parent);
    return verify(parent);
  };
  const validId = id => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  const reference = parent => ({kind:'verified-root',id:parent.id,version:parent.version});
  const create = id => {
    if(!validId(id)) invalid('Invalid stage identity');
    const parent=parentForRoot(), key='parent-'+parent.id.slice(5), stored=io.read(key);
    if(stored){verify(stored);if(JSON.stringify(stored)!==JSON.stringify(parent)) invalid('Snapshot collision');}
    else io.writeOnce(key,parent);
    verify(io.read(key));
    const binding={schema:1,stageId:id,baseStageId:parent.id,parentReference:reference(parent),parentSeal:parent.parentSeal};
    io.writeOnce('child-'+id,binding);
    return immutable(binding);
  };
  const resolve = (id,expected=null,applying=false) => {
    if(!validId(id)) invalid('Invalid stage identity');
    const binding=io.read('child-'+id);
    if(binding?.schema!==1 || binding.stageId!==id || !/^root:[a-f0-9]{64}$/.test(binding.baseStageId)) invalid('Missing immutable binding');
    const parent=verify(io.read('parent-'+binding.baseStageId.slice(5)));
    if(binding.parentSeal!==parent.parentSeal || JSON.stringify(binding.parentReference)!==JSON.stringify(reference(parent))) invalid('Rebound parent evidence');
    const current=parentForRoot();
    if(current.id!==parent.id) invalid('ROOT changed after binding');
    const entries=io.stageSnapshot?io.stageSnapshot(id,files):snapshot(file=>io.stageRead(id,file));
    if(!Array.isArray(entries)||entries.length!==files.length||entries.some((entry,index)=>entry.path!==files[index]||typeof entry.bytes!=='string'||Buffer.from(entry.bytes,'base64').toString('base64')!==entry.bytes))invalid('Invalid stage snapshot');
    if(parent.version==='3.3.28' && versionOf(entries)!=='3.3.29') invalid('Invalid bootstrap successor');
    const changed=files.filter((file,index)=>entries[index].bytes!==parent.files[index].bytes);
    const canonical={...binding,changedFilesVsBase:changed,changedFilesVsRoot:[...changed],changedFiles:[...changed],stageSeal:contentSeal(entries),rootSeal:current.parentSeal};
    const fields=['baseStageId','parentReference','parentSeal','changedFilesVsBase','changedFilesVsRoot','changedFiles','stageSeal','rootSeal'];
    if(expected && fields.some(field=>JSON.stringify(expected[field])!==JSON.stringify(canonical[field]))) invalid('Canonical envelope mismatch');
    if(applying && JSON.stringify(io.read('seal-'+id))!==JSON.stringify(canonical)) invalid('Missing or changed host seal');
    return immutable(canonical);
  };
  const approve = id => {const canonical=resolve(id);io.writeOnce('seal-'+id,canonical);return canonical;};
  return {create,resolve,approve,verify,parentForRoot};
}
function lineageHostIO(root=ROOT,devDir=DEV_DIR,allowedFiles=APP_FILES) {
  const directory=path.join(devDir,'.lineage');
  const unlinked = filename => {
    const absolute=path.resolve(filename);let current=path.parse(absolute).root;
    for(const segment of absolute.slice(current.length).split(path.sep)){
      current=path.join(current,segment);
      if(fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw Object.assign(Error('Linked lineage path'),{failureCause:'LINEAGE_INVALID'});
    }
    return absolute;
  };
  const filename = key => {
    if(!/^(installed|parent-[a-f0-9]{64}|(?:child|seal)-[0-9a-f-]{36})$/i.test(key)) throw Object.assign(Error('Invalid record identity'),{failureCause:'LINEAGE_INVALID'});
    return unlinked(path.join(directory,key+'.json'));
  };
  return {
    read:key=>{const file=filename(key);return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;},
    writeOnce:(key,value)=>{unlinked(directory);fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(filename(key),JSON.stringify(value),{flag:'wx'});},
    rootRead:file=>fs.readFileSync(unlinked(path.join(root,file))),
    maintenanceIdentity:()=>require(path.join(staging,'maintenance-host.cjs')).createHost().identity(root),
    verifiedMaintenance:({currentSeal})=>{const native=require(path.join(staging,'server.js'));const accepted=native.hostRootProvenance(root);if(accepted.currentSeal!==currentSeal)throw Error('Maintained ROOT mismatch');return {...accepted,version:accepted.installedVersion,stageId:accepted.installedStageId,authorizesApply:false,authorizesRelease:false,authorizesPublish:false};},
    acceptedInstalledSeal:currentSeal=>{const native=require(path.join(staging,'server.js'));const provenance=native.hostRootProvenance(root);if(provenance.currentSeal!==currentSeal)throw Error('Maintained ROOT mismatch');return provenance.originalSeal;},
    stageSnapshot:(id,files)=>{
      if(JSON.stringify(files)!==JSON.stringify(allowedFiles))throw Error('Stage inventory identity mismatch');
      const stage=unlinked(path.join(devDir,id));inventoryDevStage(stage,allowedFiles);
      return files.map(file=>({path:file,bytes:fs.readFileSync(unlinked(path.join(stage,file))).toString('base64')}));
    },
    stageRead:(id,file)=>{if(!allowedFiles.includes(file))throw Error('Stage read outside inventory');const stage=unlinked(path.join(devDir,id));return fs.readFileSync(unlinked(path.join(stage,file)));}
  };
}

function writeAtomic(file,value) {
  const tmp=file+'.'+crypto.randomUUID()+'.tmp';
  try {const fd=fs.openSync(tmp,'wx');try{fs.writeFileSync(fd,JSON.stringify(value,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);if(JSON.stringify(JSON.parse(fs.readFileSync(file,'utf8')))!==JSON.stringify(value))throw Error('Atomic read-back mismatch');} finally {try {if(fs.existsSync(tmp))fs.unlinkSync(tmp);} catch {}}
}

const [root, staging, parentPid, oldVersion, nativeManifestArgument] = process.argv.slice(2);
function applyManifestFile() {
  if(!nativeManifestArgument)return path.join(staging,'manifest.json');
  const id=path.basename(nativeManifestArgument,'.json');
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))throw Error('Invalid native manifest identity');
  const expected=path.join(path.resolve(root),'.dev-work','.release-controller','manifests',id+'.json');
  if(path.resolve(nativeManifestArgument)!==expected||fs.realpathSync(nativeManifestArgument)!==expected)throw Error('Native manifest path mismatch');
  return expected;
}
if (!root || !staging) process.exit(2);


let applyManifest=null;
function applyEvent(phase,progress,status='running',message=phase) {
  if(!applyManifest?.monitorRunId || !/^[0-9a-f-]{36}$/i.test(applyManifest.monitorRunId))return;
  try {
    const file=path.join(root,'data','runtime','runs',applyManifest.monitorRunId+'.json');
    const job=JSON.parse(fs.readFileSync(file,'utf8'));const at=new Date().toISOString();
    Object.assign(job,{phase,progress,status,updatedAt:at,elapsedMs:Date.now()-Date.parse(job.startedAt)});
    job.events.push({at,type:status==='error'?'error':status==='completed'?'success':'info',phase,message});job.events=job.events.slice(-150);
    writeAtomic(file,job);
    if(applyManifest.remoteId && applyManifest.remoteFolder && /^[0-9a-f-]{36}$/i.test(applyManifest.remoteId)) {
      const remote=path.join(applyManifest.remoteFolder,'Remote','status',applyManifest.remoteId+'.json');
      const state=JSON.parse(fs.readFileSync(remote,'utf8'));
      Object.assign(state,{runId:job.runId,phase,progress,status:status==='error'?'failed':applyManifest.auto ? (status==='completed'?'completed':phase) : 'applying',elapsedMs:job.elapsedMs,updatedAt:at});
      writeAtomic(remote,state);
    }
  } catch {}
}
function probe() {
  return new Promise((resolve, reject) => {
    const s = net.connect({host:'127.0.0.1',port:3210});
    s.setTimeout(2000);
    s.once('connect',()=>{s.destroy();resolve(true);});
    s.once('timeout',()=>{s.destroy();reject(new Error('Verifica porta 3210 scaduta'));});
    s.once('error',e=>{s.destroy();if(e.code==='ECONNREFUSED')resolve(false);else reject(e);});
  });
}

// Apply waits for both the old PID and the listener to disappear; never kills a port owner.
async function waitForShutdown(pid, deps={}) {
  const check=deps.probe||probe;
  const alive=deps.alive||(pid=>{try{process.kill(Number(pid),0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}});
  const pause=deps.sleep||(ms=>new Promise(r=>setTimeout(r,ms)));
  if(!Number.isInteger(Number(pid))||Number(pid)<=0)throw new Error('PID precedente non valido: riavvio annullato');
  for(let i=0;i<120;i++) {
    if(!alive(pid) && !(await check()))return;
    await pause(250);
  }
  throw new Error('Riavvio annullato: vecchio server ancora attivo o porta 127.0.0.1:3210 occupata da un processo non identificato; nessun processo arrestato');
}
async function waitForInstance(version, instance, deps={}) {
  const request=deps.fetch||fetch;
  const pause=deps.sleep||(ms=>new Promise(r=>setTimeout(r,ms)));
  for(let i=0;i<30;i++) {
    try {
      const r=await request('http://127.0.0.1:3210/api/restart-status',{signal:AbortSignal.timeout(1500),cache:'no-store'});
      const x=r.ok?await r.json():null;
      if(x?.version===version && x?.instance===instance)return;
    } catch {}
    await pause(1000);
  }
  throw new Error('Nuova istanza non confermata: versione attesa '+version+' non disponibile entro il timeout di riavvio');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function alive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}
function safe(rel) {
  const x = String(rel || "").replace(/\\/g, "/");
  return x && !x.startsWith("/") && !x.includes("../") &&
    x !== "data" && !x.startsWith("data/") &&
    x !== ".git" && !x.startsWith(".git/") &&
    !x.startsWith(".backups/") && !x.startsWith(".update/");
}


const HISTORICAL_APP_FILES = ["server.js","updater.js","public/index.html","start.cmd","stop.cmd","setup-local-model.cmd","setup-github.cmd","background-launcher.js","setup-autostart.cmd","disable-autostart.cmd","README.md",".gitignore"];
const APP_FILES=Object.freeze(require('./maintenance-host.cjs').createHost().select(root,HISTORICAL_APP_FILES));
function validateAutoManifest(manifest, allowedFiles=APP_FILES) {
  if (!manifest?.auto?.enabled || manifest.auto.expectedVersion !== manifest.version || !/^\d+\.\d+\.\d+$/.test(manifest.version) || !manifest.auto.oldInstance || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Manifest autonomo non valido');
  const seen = new Set();
  for (const f of manifest.files) {
    if (!allowedFiles.includes(f.path) || seen.has(f.path) || !/^[a-f0-9]{64}$/i.test(f.sha256)) throw new Error('Allowlist/checksum autonomo non valido');
    seen.add(f.path);
  }
}
function autoTerminal(status, message, extra={}) {
  applyEvent(status,100,status==='completed'?'completed':'error',message);
  if (!applyManifest?.remoteId || !applyManifest.remoteFolder) return;
  const base = path.join(applyManifest.remoteFolder,'Remote');
  const stateFile = path.join(base,'status',applyManifest.remoteId+'.json');
  const state = JSON.parse(fs.readFileSync(stateFile,'utf8'));
  const requestFile = path.join(base,'running',applyManifest.remoteId+'.json');
  const request = fs.existsSync(requestFile) ? JSON.parse(fs.readFileSync(requestFile,'utf8')) : null;
  const at = new Date().toISOString();
  const terminal = {...state,...extra,status,phase:status,message,auto:true,version:extra.localVersion || (["completed","publish_failed"].includes(status)?applyManifest.version:oldVersion),devId:applyManifest.devId,changedFiles:applyManifest.files.map(f=>f.path),review:applyManifest.review,validation:applyManifest.validation,nextVersion:applyManifest.version,updatedAt:at};
  const monitor = JSON.parse(fs.readFileSync(path.join(root,'data','runtime','runs',applyManifest.monitorRunId+'.json'),'utf8'));
  writeAtomic(path.join(base,status==='completed'?'completed':'failed',applyManifest.remoteId+'.json'),{request,...terminal,trace:monitor.events,response:message,at});
  writeAtomic(stateFile,terminal);
  if(fs.existsSync(requestFile))fs.unlinkSync(requestFile);
}
async function smokeAuto(version,instance,deps={}) {
  const request = deps.fetch || fetch;
  const a = await request('http://127.0.0.1:3210/api/restart-status',{cache:'no-store',signal:AbortSignal.timeout(2000)});
  const identity = a.ok ? await a.json() : null;
  if(identity?.version!==version || identity?.instance!==instance) throw new Error('Smoke identity fallito');
  const b = await request('http://127.0.0.1:3210/api/remote/state',{cache:'no-store',signal:AbortSignal.timeout(2000)});
  const state = b.ok ? await b.json() : null;
  if(!state || typeof state.enabled!=='boolean' || !Number.isInteger(state.activeJobCount)) throw new Error('Smoke Remote fallito');
}

function inventoryDevStage(stage, allowedFiles=APP_FILES) {
  const found=[];
  const walk=(directory,prefix='')=>{
    if(fs.lstatSync(directory).isSymbolicLink())throw Error('Stage link');
    for(const item of fs.readdirSync(directory,{withFileTypes:true})){
      const rel=prefix+item.name;
      if(item.isSymbolicLink())throw Error('Stage link');
      if(item.isDirectory()){if(!allowedFiles.some(f=>f.startsWith(rel+'/')))throw Error('Stage directory');walk(path.join(directory,item.name),rel+'/');}
      else if(item.isFile() && allowedFiles.includes(rel))found.push(rel);
      else if(!item.isFile() || prefix || rel!=='manifest.json')throw Error('Stage file');
    }
  };
  walk(stage);if(allowedFiles.some(f=>!found.includes(f)))throw Error('Stage missing file');return found;
}
let verifiedApply=null;
function verifyApplyLineage(manifest, allowedFiles=APP_FILES, historicalFiles=HISTORICAL_APP_FILES) {
  if(nativeManifestArgument&&path.basename(nativeManifestArgument)!==manifest.releaseAttemptId+'.json')throw Error('Native manifest authority mismatch');
  const stage=fs.realpathSync(staging), installed=fs.realpathSync(root), id=path.basename(stage);
  if(path.resolve(staging)!==stage || path.resolve(root)!==installed ||
     path.dirname(stage)!==path.join(installed,'.dev-work') ||
     !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ||
     path.resolve(__filename)!==path.join(stage,'updater.js') || fs.realpathSync(__filename)!==path.join(stage,'updater.js') ||
     path.resolve(process.argv[1])!==path.join(stage,'updater.js') || fs.realpathSync(process.argv[1])!==path.join(stage,'updater.js'))throw Error('Apply execution identity mismatch');
  const io=lineageHostIO(installed,path.join(installed,'.dev-work'),allowedFiles);
  const store=nativeLineageStore(io,allowedFiles,historicalFiles), parent=store.parentForRoot();
  const version=io.stageRead(id,'server.js').toString().match(/const VERSION = "([^"]+)";/)?.[1];
  const legacy=parent.version==='3.3.28' && version==='3.3.29' && oldVersion==='3.3.28' && io.read('installed')===null;
  if(oldVersion!==parent.version || version!==manifest.version)throw Error('Apply version mismatch');
  // Only the first verified bootstrap may omit identity; supplied fields must match the executing stage.
  for(const field of ['stageId','devId']){
    if(!Object.hasOwn(manifest,field)){if(!legacy)throw Error('Apply identity mismatch');}
    else if(manifest[field]!==id)throw Error('Apply identity mismatch');
  }
  let canonical;
  if(legacy){
    // Construct exclusively from verified installed bytes and staged bytes, never developer fields.
    const records=new Map();
    const memory=nativeLineageStore({...io,read:key=>records.get(key)||null,writeOnce:(key,value)=>records.set(key,value)},allowedFiles,historicalFiles);
    memory.create(id);canonical=memory.approve(id);
    for(const key of ['parent-'+parent.id.slice(5),'child-'+id,'seal-'+id]){
      const existing=io.read(key);
      if(existing && JSON.stringify(existing)!==JSON.stringify(records.get(key)))throw Error('Conflicting host lineage');
    }
    for(const field of ['baseStageId','parentReference','parentSeal','changedFilesVsBase','changedFilesVsRoot','changedFiles','stageSeal','rootSeal'])
      if(Object.hasOwn(manifest,field) && JSON.stringify(manifest[field])!==JSON.stringify(canonical[field]))throw Error('Rebound legacy envelope');
  }else{
    const receipt=io.read('installed');
    const native=require(path.join(staging,'server.js')),provenance=native.hostRootProvenance(installed);
    const originalServerHash=provenance.originalSeal.split('|').find(entry=>entry.startsWith('server.js:'))?.slice(10);
    if(receipt?.devId!==receipt?.stageId || !receipt?.at || receipt?.serverHash!==originalServerHash)throw Error('Invalid native receipt');
    const approved=io.read('seal-'+receipt.stageId);
    if(receipt.baseStageId!==approved?.baseStageId || receipt.parentSeal!==approved?.parentSeal || JSON.stringify(receipt.parentReference)!==JSON.stringify(approved?.parentReference))throw Error('Rebound native receipt');
    canonical=store.resolve(id,manifest,true);
  }
  if(!Array.isArray(manifest.files) || JSON.stringify(manifest.files.map(f=>f.path))!==JSON.stringify(canonical.changedFilesVsRoot))throw Error('Apply manifest mismatch');
  for(const file of manifest.files)if(!allowedFiles.includes(file.path) || crypto.createHash('sha256').update(io.stageRead(id,file.path)).digest('hex')!==file.sha256)throw Error('Apply source mismatch');
  verifyNativeReleaseAuthority(manifest,canonical);
  verifiedApply={...canonical,version,devId:id,parent};
  return canonical;
}
let nativeExecutorClaim=null;
function verifyNativeReleaseAuthority(manifest,canonical) {
  const native=require(path.join(staging,'server.js'));
  const store=native.releaseAttemptDiskStore(path.join(root,'.dev-work','.release-controller'));
  const record=store.read(manifest.releaseAttemptId);
  native.nativeReleaseHost(root).controller.assertReview(manifest.releaseAttemptId);
  if(!record||record.currentState!=='APPLYING'&&record.currentState!=='RESTART_PENDING'||record.stageId!==canonical.stageId||record.candidateSeal!==canonical.stageSeal||record.applyReceiptId!==manifest.applyReceiptId||record.applyReceipt?.releaseAttemptId!==record.releaseAttemptId||!['INTENT_DURABLE','HANDOFF_CONFIRMED'].includes(record.applyReceipt.sideEffectState))throw Error('Missing native ApplyReceipt authority');
  if(record.applyReceipt.executorClaim){if(record.applyReceipt.executorClaim!==nativeExecutorClaim)throw Error('Apply executor already claimed; reconciliation required');return;}
  nativeExecutorClaim=crypto.randomUUID();record.applyReceipt.executorClaim=nativeExecutorClaim;record.applyReceipt.sideEffectState='HANDOFF_CONFIRMED';
  const revision=record.revision;record.revision++;record.updatedAt=new Date().toISOString();store.commit(record.releaseAttemptId,record,revision);
}
function recordInstalledLineage(manifest, allowedFiles=APP_FILES, historicalFiles=HISTORICAL_APP_FILES) {
  if(!verifiedApply)throw Error('Missing verified Apply');
  const seal=allowedFiles.map(f=>f+':'+crypto.createHash('sha256').update(fs.readFileSync(path.join(root,f))).digest('hex')).join('|');
  if(seal!==verifiedApply.stageSeal)throw Error('Installed seal mismatch');
  const io=lineageHostIO(root,path.join(root,'.dev-work'),allowedFiles), id=verifiedApply.stageId;
  const {parent,version,devId,...canonical}=verifiedApply;
  for(const [key,value] of [['parent-'+parent.id.slice(5),parent],['child-'+id,{schema:1,stageId:id,baseStageId:canonical.baseStageId,parentReference:canonical.parentReference,parentSeal:canonical.parentSeal}],['seal-'+id,canonical]]){
    const existing=io.read(key);
    if(existing){if(JSON.stringify(existing)!==JSON.stringify(value))throw Error('Lineage persistence conflict');}
    else io.writeOnce(key,value);
    if(JSON.stringify(io.read(key))!==JSON.stringify(value))throw Error('Lineage read-back mismatch');
  }
  const receipt={schema:1,version,stageId:id,devId:id,stageSeal:seal,serverHash:crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'server.js'))).digest('hex'),baseStageId:canonical.baseStageId,parentReference:canonical.parentReference,parentSeal:canonical.parentSeal,at:new Date().toISOString()};
  writeAtomic(path.join(root,'.dev-work','.lineage','installed.json'),receipt);
  nativeLineageStore(io,allowedFiles,historicalFiles).parentForRoot();
}
function installVerifiedFiles(manifest,backup, allowedFiles=APP_FILES, historicalFiles=HISTORICAL_APP_FILES) {
  const sources=manifest.files.map(f=>{
    if(!allowedFiles.includes(f.path) || !safe(f.path))throw Error('Invalid install path');
    const dest=path.join(root,f.path), bytes=fs.readFileSync(path.join(staging,f.path));
    if(crypto.createHash('sha256').update(bytes).digest('hex')!==f.sha256)throw Error('Changed Apply source');
    const original=fs.existsSync(dest)?fs.readFileSync(dest):null;
    return {dest,bytes,original,file:f.path};
  });
  const receiptFile=path.join(root,'.dev-work','.lineage','installed.json');
  const prior=fs.existsSync(receiptFile)?fs.readFileSync(receiptFile):null;
  for(const f of sources)if(f.original){const b=path.join(backup,f.file);fs.mkdirSync(path.dirname(b),{recursive:true});fs.writeFileSync(b,f.original);if(!fs.readFileSync(b).equals(f.original))throw Error('Backup verification failed');}
  // Revalidate after the complete verified backup, before the first installed byte changes.
  verifyApplyLineage(manifest,allowedFiles,historicalFiles);
  try {
    for(const f of sources){fs.mkdirSync(path.dirname(f.dest),{recursive:true});const tmp=f.dest+'.'+crypto.randomUUID()+'.tmp';try{fs.writeFileSync(tmp,f.bytes,{flag:'wx'});fs.renameSync(tmp,f.dest);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}}
    recordInstalledLineage(manifest,allowedFiles,historicalFiles);
  }catch(error){
    for(const f of sources){if(f.original){const bytes=fs.readFileSync(path.join(backup,f.file));if(!bytes.equals(f.original))throw Error('Rollback backup corrupted');fs.writeFileSync(f.dest,bytes);}else if(fs.existsSync(f.dest))fs.unlinkSync(f.dest);}
    if(prior)writeAtomic(receiptFile,JSON.parse(prior));else if(fs.existsSync(receiptFile))fs.unlinkSync(receiptFile);
    for(const f of sources)if(f.original && !fs.readFileSync(f.dest).equals(f.original))throw Error('Rollback verification failed');
    throw error;
  }
}

async function verifyAndPublishAuto(version,instance,token,deps={}) {
  await (deps.health || waitForInstance)(version,instance);
  await (deps.smoke || smokeAuto)(version,instance);
  (deps.event || applyEvent)('publishing',95);
  // Exactly one attempt. No general-purpose command or public token is exposed.
  const request = deps.fetch || fetch;
  const r = await request('http://127.0.0.1:3210/api/dev/auto-publish',{method:'POST',headers:{'x-marco-pipeline':token},signal:AbortSignal.timeout(480000)});
  const x = r.ok ? await r.json() : null;
  return x?.ok===true && x.version===version && x.instance===instance;
}
async function autonomousApply(manifest) {
  verifyApplyLineage(manifest);
  validateAutoManifest(manifest);
  // Validate every source and destination before stopping/copying. No partial preflight.
  const sources = manifest.files.map(f=>{
    const src=path.join(staging,f.path), dest=path.join(root,f.path);
    for(const base of [staging,root]) {
      let p=base;
      if(fs.lstatSync(p).isSymbolicLink())throw new Error('Root collegata non consentita');
      for(const part of f.path.split('/')) {p=path.join(p,part);if(fs.existsSync(p)&&fs.lstatSync(p).isSymbolicLink())throw new Error('Percorso collegato non consentito');}
    }
    const bytes=fs.readFileSync(src);
    if(crypto.createHash('sha256').update(bytes).digest('hex')!==f.sha256)throw new Error('Staging alterato dopo review');
    return {...f,src,dest,bytes,existed:fs.existsSync(dest)};
  });
  applyEvent('applying',5);
  const instance=crypto.randomUUID(), token=crypto.randomBytes(32).toString('hex');
  if(instance===manifest.auto.oldInstance)throw new Error('Identità restart non nuova');
  const backup=path.join(root,'.backups',new Date().toISOString().replace(/[:.]/g,'-')+'-auto-v'+oldVersion+'-to-v'+manifest.version+'-'+crypto.randomUUID());
  if(fs.existsSync(path.join(root,'.backups')) && fs.lstatSync(path.join(root,'.backups')).isSymbolicLink())throw new Error('Backup collegato non consentito');
  fs.mkdirSync(backup,{recursive:true});
  // Back up all files before any copy, retaining rollback integrity in memory.
  for(const f of sources) if(f.existed) {f.original=fs.readFileSync(f.dest);const b=path.join(backup,f.path);fs.mkdirSync(path.dirname(b),{recursive:true});fs.writeFileSync(b,f.original);if(!fs.readFileSync(b).equals(f.original))throw Error('Backup verification failed');}
  const receiptFile=path.join(root,'.dev-work','.lineage','installed.json');
  const priorReceipt=fs.existsSync(receiptFile)?fs.readFileSync(receiptFile):null;
  let child=null, copied=false, verified=false;
  async function start(version,identity,publishToken='') {
    if(await probe())throw new Error('Porta occupata; nessun processo estraneo arrestato');
    const p=spawn(process.execPath,[path.join(root,'server.js')],{cwd:root,detached:true,windowsHide:true,stdio:'ignore',env:{...process.env,PORT:'3210',MARCO_RESTART_INSTANCE:identity,MARCO_AUTO_PUBLISH_TOKEN:publishToken}});
    await new Promise((resolve,reject)=>{p.once('error',reject);p.once('spawn',resolve);});p.unref();return p;
  }
  try {
    await waitForShutdown(parentPid);
    copied=true;
    for(const f of sources){fs.mkdirSync(path.dirname(f.dest),{recursive:true});fs.writeFileSync(f.dest,f.bytes);}
    writeAtomic(path.join(root,'.last-update.json'),{from:oldVersion,to:manifest.version,backup,at:new Date().toISOString()});
    recordInstalledLineage(manifest);
    child=await start(manifest.version,instance,token);
    applyEvent('verifying',85);
    await waitForInstance(manifest.version,instance);
    await smokeAuto(manifest.version,instance);
    verified=true;
    let published=false;
    try {published=await verifyAndPublishAuto(manifest.version,instance,token,{health:async()=>{},smoke:async()=>{}});} catch {}
    autoTerminal(published?'completed':'publish_failed',published?'Pipeline completata: health, smoke e publish verificati.':'Publish fallito o esito incerto; locale operativo, nessun retry automatico. Verificare GitHub prima di approvare Publish manuale.',{localVersion:manifest.version,instance,backup,healthPassed:true,smokePassed:true});
  } catch(e) {
    if(verified) {autoTerminal('publish_failed','Locale verificato; finalizzazione/publish da controllare manualmente.');return;}
    let rolledBack=false;
    try {
      if(child && child.exitCode===null) {child.kill();await waitForShutdown(child.pid);}
      if(await probe())throw new Error('Porta occupata; rollback non sicuro');
      if(copied) for(const f of sources) {
        if(f.existed) {const b=path.join(backup,f.path);const bytes=fs.readFileSync(b);if(!bytes.equals(f.original))throw new Error('Backup alterato');}
      }
      if(copied) for(const f of sources) {if(f.existed)fs.writeFileSync(f.dest,f.original);else if(fs.existsSync(f.dest))fs.unlinkSync(f.dest);}
      const rollbackInstance=crypto.randomUUID();
      child=await start(oldVersion,rollbackInstance);
      await waitForInstance(oldVersion,rollbackInstance);rolledBack=true;
      if(priorReceipt)fs.writeFileSync(receiptFile,priorReceipt);else if(fs.existsSync(receiptFile))fs.unlinkSync(receiptFile);
      writeAtomic(path.join(root,'.last-update.json'),{from:manifest.version,to:oldVersion,backup,rolledBack:true,at:new Date().toISOString()});
    } catch {}
    autoTerminal('needs_review',rolledBack?'Health/smoke fallito: rollback verificato; nessun Publish. Esaminare staging e approvare manualmente.':'Health/smoke fallito: rollback non confermato, intervento manuale necessario; nessun Publish.',{rolledBack,backup,healthPassed:false});
  }
}

async function recoverUnchangedOldServer() {
  // Preflight errors may occur after the parent scheduled exit. Restart only unchanged app code.
  const source=fs.readFileSync(path.join(root,'server.js'),'utf8');
  if(source.match(/const VERSION = "([^"]+)";/)?.[1]!==oldVersion)return false;
  await waitForShutdown(parentPid);
  const instance=crypto.randomUUID();
  const p=spawn(process.execPath,[path.join(root,'server.js')],{cwd:root,detached:true,windowsHide:true,stdio:'ignore',env:{...process.env,PORT:'3210',MARCO_RESTART_INSTANCE:instance,MARCO_AUTO_PUBLISH_TOKEN:''}});
  await new Promise((resolve,reject)=>{p.once('error',reject);p.once('spawn',resolve);});p.unref();
  await waitForInstance(oldVersion,instance);
  return true;
}

(async () => {
  try {
    applyManifest=JSON.parse(fs.readFileSync(applyManifestFile(),"utf8"));
    if(path.dirname(path.resolve(__filename))===path.resolve(root,'.dev-work',path.basename(path.dirname(__filename))) || path.dirname(path.resolve(staging))===path.resolve(root,'.dev-work'))verifyApplyLineage(applyManifest);
    if(applyManifest.auto?.enabled) {await autonomousApply(applyManifest);return;}
    applyEvent("Arresto vecchia istanza",5);
    await waitForShutdown(parentPid);
    const restartInstance=verifiedApply?require(path.join(staging,'server.js')).releaseAttemptDiskStore(path.join(root,'.dev-work','.release-controller')).read(applyManifest.releaseAttemptId).applyReceipt.expectedRestartInstance:crypto.randomUUID();
    if(typeof restartInstance!=='string'||!/^[0-9a-f-]{36}$/i.test(restartInstance))throw Error('Missing durable restart identity');
    if(verifiedApply){
      const native=require(path.join(staging,'server.js')),store=native.releaseAttemptDiskStore(path.join(root,'.dev-work','.release-controller'));
      const record=store.read(applyManifest.releaseAttemptId),revision=record.revision;
      if(record.applyReceipt?.executorClaim!==nativeExecutorClaim)throw Error('Lost native executor claim');
      if(record.applyReceipt.expectedRestartInstance!==restartInstance)throw Error('Changed durable restart identity');
    }

    const manifest = JSON.parse(fs.readFileSync(applyManifestFile(), "utf8"));
    applyManifest=manifest;applyEvent('Backup',15);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = path.join(root, ".backups", `${stamp}-v${oldVersion}-to-v${manifest.version}`);
    fs.mkdirSync(backup, { recursive: true });

    applyEvent('Copia file',35);
    if(verifiedApply)installVerifiedFiles(manifest,backup);
    else {
    applyEvent('Copia file',35);
    for (const f of manifest.files) {
      if (!safe(f.path)) throw new Error(`Percorso non consentito: ${f.path}`);
      const src = path.join(staging, f.path);
      const dest = path.join(root, f.path);
      if (!fs.existsSync(src)) throw new Error(`File staged mancante: ${f.path}`);
      if (fs.existsSync(dest)) {
        const b = path.join(backup, f.path);
        fs.mkdirSync(path.dirname(b), { recursive: true });
        fs.copyFileSync(dest, b);
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }

    }
    fs.writeFileSync(path.join(root, ".last-update.json"), JSON.stringify({
      from: oldVersion, to: manifest.version, at: new Date().toISOString(), backup
    }, null, 2));

    fs.rmSync(path.join(root, ".update"), { recursive: true, force: true });

    applyEvent('Riavvio',80);
    if (process.platform === "win32") {
      await sleep(800);
      const restartLog = path.join(root, ".restart-log.txt");
      const logRestart = message => {
        try { fs.appendFileSync(restartLog, message + "\n", "utf8"); } catch {}
      };
      logRestart(`Tentativo: ${new Date().toISOString()}`);
      try {
        const p = spawn(process.execPath, [path.join(root, "background-launcher.js")], {
          cwd: root, detached: true, windowsHide: true, stdio: "ignore",
          env:{...process.env,PORT:"3210",MARCO_RESTART_INSTANCE:restartInstance}
        });
        await new Promise((resolve, reject) => {
          p.once("error", reject);
          p.once("spawn", () => {
            logRestart(`PID: ${p.pid}`);
            resolve();
          });
        });
        p.unref();
      } catch (e) {
        logRestart(`PID: non disponibile\nErrore di spawn: ${e.stack || e.message}`);
        throw e;
      }
    } else {
      const p = spawn(process.execPath, ["server.js"], { cwd: root, detached: true, stdio: "ignore", env:{...process.env,PORT:"3210",MARCO_RESTART_INSTANCE:restartInstance} });
      p.unref();
    }
    await waitForInstance(manifest.version,restartInstance);
    applyEvent('Server disponibile · completamento',100,'completed','Nuova istanza verificata: '+manifest.version);
  } catch (e) {
    if(applyManifest?.auto?.enabled) {let restored=false;try {restored=await recoverUnchangedOldServer();}catch {} try {autoTerminal('needs_review',restored?'Preflight Apply fallito; vecchia versione riavviata e verificata, nessun Publish. Verifica manuale necessaria.':'Apply autonomo interrotto; recupero non confermato, nessun Publish. Verifica manuale necessaria.',{rolledBack:restored});}catch {}}
    applyEvent('Apply fallito',0,'error','Apply fallito; consultare il report locale');
    try { fs.writeFileSync(path.join(root, ".update-error.txt"), `${new Date().toISOString()}\n${e.stack || e.message}\n`); } catch {}
    process.exit(1);
  }
})();
