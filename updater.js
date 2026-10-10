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
      Object.assign(state,{runId:job.runId,phase,progress,status:status==='error'?'failed':'applying',elapsedMs:job.elapsedMs,updatedAt:at});
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

(async () => {
  try {
    applyManifest=JSON.parse(fs.readFileSync(path.join(staging,"manifest.json"),"utf8"));
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
    applyEvent('Apply fallito',0,'error',e.message);
    try { fs.writeFileSync(path.join(root, ".update-error.txt"), `${new Date().toISOString()}\n${e.stack || e.message}\n`); } catch {}
    process.exit(1);
  }
})();
