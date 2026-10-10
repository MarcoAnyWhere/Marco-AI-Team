'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const ROOT = __dirname;
const ITEM = 'Marco-AI-Team.vbs';
function probe() {
  return new Promise((resolve, reject) => {
    const s = net.connect({host:'127.0.0.1',port:3210});
    s.setTimeout(2000);
    s.once('connect',()=>{s.destroy();resolve(true);});
    s.once('timeout',()=>{s.destroy();reject(new Error('Verifica porta 3210 scaduta'));});
    s.once('error',e=>{s.destroy();if(e.code==='ECONNREFUSED')resolve(false);else reject(e);});
  });
}
function startupFile() {
  if(process.platform!=='win32' || !process.env.APPDATA)throw new Error('Startup Windows non rilevabile');
  return path.join(process.env.APPDATA,'Microsoft','Windows','Start Menu','Programs','Startup',ITEM);
}
function vbs() {
  const quote = s => '"'+s.replace(/"/g,'""')+'"';
  const command = '"'+process.execPath+'" "'+path.join(ROOT,'background-launcher.js')+'"';
  return "\ufeff' Marco AI Team autostart v1\r\n"+
    'If WScript.Arguments.Count > 0 Then WScript.Quit 0\r\n'+
    'Set shell = CreateObject("WScript.Shell")\r\n'+
    'shell.CurrentDirectory = '+quote(ROOT)+'\r\n'+
    'shell.Run '+quote(command)+', 0, False\r\n';
}
function status() {
  try {const f=startupFile();if(!fs.existsSync(f))return 'non configurato';return fs.readFileSync(f,'utf16le')===vbs()?'attivo':'non rilevabile';}
  catch {return 'non rilevabile';}
}
function setup() {
  const f=startupFile();
  if(fs.existsSync(f) && !fs.readFileSync(f,'utf16le').startsWith("\ufeff' Marco AI Team autostart v1\r\n"))throw new Error('Elemento Startup omonimo non riconosciuto: nessuna modifica');
  // Probe WSH before changing Startup. The probe lives only in the application folder.
  const tmp=path.join(ROOT,'.autostart-probe-'+process.pid+'.vbs');
  try {
    fs.writeFileSync(tmp,'WScript.Quit 0\r\n',{flag:'wx'});
    const r=spawnSync(path.join(process.env.SystemRoot||'C:\\Windows','System32','cscript.exe'),['//B','//NoLogo',tmp],{windowsHide:true,timeout:5000});
    if(r.error || r.status!==0)throw new Error('Windows Script Host disabilitato o non disponibile: autostart non configurato');
  } finally {try{fs.unlinkSync(tmp);}catch{}}
  fs.mkdirSync(path.dirname(f),{recursive:true});
  fs.writeFileSync(f,vbs(),'utf16le');
  console.log('Avvio automatico Windows: attivo. Avvio nascosto al prossimo login, senza browser.');
}
function disable() {
  const f=startupFile();
  if(fs.existsSync(f)) {
    if(!fs.readFileSync(f,'utf16le').startsWith("\ufeff' Marco AI Team autostart v1\r\n"))throw new Error('Elemento Startup omonimo non riconosciuto: nessuna modifica');
    fs.unlinkSync(f);
  }
  console.log('Avvio automatico Windows: non configurato. Il server in esecuzione resta attivo.');
}
async function launch(deps={}) {
  const check=deps.probe||probe;
  if(await check())return false;
  const lock=path.join(ROOT,'.background-launch.lock');
  let owned=false;
  try {
    try {fs.writeFileSync(lock,String(process.pid),{flag:'wx'});owned=true;}
    catch(e) {
      if(e.code!=='EEXIST')throw e;
      const pid=Number(fs.readFileSync(lock,'utf8'));
      if(!Number.isInteger(pid)||pid<=0)throw new Error('Lock launcher non valido');
      try {process.kill(pid,0);return false;} catch(e){if(e.code!=='ESRCH')throw e;}
      fs.unlinkSync(lock);
      try{fs.writeFileSync(lock,String(process.pid),{flag:'wx'});owned=true;}catch(e){if(e.code==='EEXIST')return false;throw e;}
    }
    if(await check())return false;
    const p=(deps.spawn||spawn)(process.execPath,[path.join(ROOT,'server.js')],{
      cwd:ROOT,detached:true,windowsHide:true,stdio:'ignore',env:{...process.env,PORT:'3210'}
    });
    await new Promise((resolve,reject)=>{p.once('error',reject);p.once('spawn',resolve);});
    p.unref();
    for(let i=0;i<40;i++){if(await check())return true;await new Promise(r=>setTimeout(r,250));}
    throw new Error('Server non disponibile dopo avvio; usare start.cmd per diagnostica');
  } finally {if(owned)fs.unlinkSync(lock);}
}
function stop() {
  if(process.platform!=='win32')throw new Error('Stop previsto per Windows');
  const script = `$ErrorActionPreference='Stop'; $target=$env:MARCO_SERVER_PATH; Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 3210 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$_.OwningProcess); if($p.Name -eq 'node.exe' -and $p.CommandLine -and ($p.CommandLine.Contains('"'+$target+'"') -or $p.CommandLine.EndsWith(' '+$target))) { Stop-Process -Id $p.ProcessId -ErrorAction Stop } else { Write-Output 'Processo non identificato come Marco AI Team: nessun arresto' } }`;
  const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:'inherit',env:{...process.env,MARCO_SERVER_PATH:path.join(ROOT,'server.js')}});
  if(r.error||r.status!==0)throw new Error('Arresto selettivo non riuscito');
}
module.exports={probe,launch,status,vbs,setup,disable};
if(require.main===module) (async()=>{
  switch(process.argv[2]) {
    case '--check':process.exitCode=await probe()?0:1;break;
    case '--setup':setup();break;
    case '--disable':disable();break;
    case '--stop':stop();break;
    default:await launch();
  }
})().catch(e=>{console.error(e.message);process.exitCode=2;});
