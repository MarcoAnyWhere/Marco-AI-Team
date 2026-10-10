const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const crypto = require('crypto');
const net = require('net');
function writeAtomic(file,value) {
  const tmp=file+'.'+crypto.randomUUID()+'.tmp';
  try {fs.writeFileSync(tmp,JSON.stringify(value,null,2),{flag:'wx'});fs.renameSync(tmp,file);} finally {try {if(fs.existsSync(tmp))fs.unlinkSync(tmp);} catch {}}
}

const [root, staging, parentPid, oldVersion] = process.argv.slice(2);
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


const APP_FILES = ["server.js","updater.js","public/index.html","start.cmd","stop.cmd","setup-local-model.cmd","setup-github.cmd","background-launcher.js","setup-autostart.cmd","disable-autostart.cmd","README.md",".gitignore"];
function validateAutoManifest(manifest) {
  if (!manifest?.auto?.enabled || manifest.auto.expectedVersion !== manifest.version || !/^\d+\.\d+\.\d+$/.test(manifest.version) || !manifest.auto.oldInstance || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Manifest autonomo non valido');
  const seen = new Set();
  for (const f of manifest.files) {
    if (!APP_FILES.includes(f.path) || seen.has(f.path) || !/^[a-f0-9]{64}$/i.test(f.sha256)) throw new Error('Allowlist/checksum autonomo non valido');
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
  for(const f of sources) if(f.existed) {f.original=fs.readFileSync(f.dest);const b=path.join(backup,f.path);fs.mkdirSync(path.dirname(b),{recursive:true});fs.writeFileSync(b,f.original);}
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
    applyManifest=JSON.parse(fs.readFileSync(path.join(staging,"manifest.json"),"utf8"));
    if(applyManifest.auto?.enabled) {await autonomousApply(applyManifest);return;}
    applyEvent("Arresto vecchia istanza",5);
    await waitForShutdown(parentPid);
    const restartInstance=crypto.randomUUID();

    const manifest = JSON.parse(fs.readFileSync(path.join(staging, "manifest.json"), "utf8"));
    applyManifest=manifest;applyEvent('Backup',15);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = path.join(root, ".backups", `${stamp}-v${oldVersion}-to-v${manifest.version}`);
    fs.mkdirSync(backup, { recursive: true });

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
