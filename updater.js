const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const crypto = require('crypto');
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
    for (let i = 0; i < 40 && alive(parentPid); i++) await sleep(250);
    await sleep(400);

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
        const p = spawn("cmd.exe", ["/d", "/s", "/c", "call start.cmd"], {
          cwd: root, detached: true, windowsHide: false, stdio: "ignore"
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
      const p = spawn("node", ["server.js"], { cwd: root, detached: true, stdio: "ignore" });
      p.unref();
    }
    let available=false;
    for(let attempt=0;attempt<20;attempt++) {
      try {const response=await fetch('http://127.0.0.1:'+(process.env.PORT||3210)+'/api/remote/config',{signal:AbortSignal.timeout(1500)});if(response.ok && (await response.json()).version===manifest.version){available=true;break;}} catch {}
      await sleep(1000);
    }
    applyEvent(available?'Server disponibile · completamento':'Server non disponibile',available?100:80,available?'completed':'error');
  } catch (e) {
    applyEvent('Apply fallito',0,'error');
    try { fs.writeFileSync(path.join(root, ".update-error.txt"), `${new Date().toISOString()}\n${e.stack || e.message}\n`); } catch {}
    process.exit(1);
  }
})();
