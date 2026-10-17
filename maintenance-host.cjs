'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {createVerifier,capture,inventory,hash}=require('./maintenance-provenance.cjs');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
// Host operator pins this public fingerprint before final review/activation.
// An environment variable or record may never supply the expected fingerprint.
const HOST_KEY_SHA256='2b71bd324e3a50f51740bf9738c3dfb1768279d7c4c3ee4daed443e47cd011c2';
function fail(message){throw Object.assign(Error(message),{failureCause:'HOST_PRECHECK_FAILED',code:'MAINTENANCE_PROVENANCE_INVALID'});}
function safe(file){let current=path.parse(path.resolve(file)).root;for(const segment of path.resolve(file).slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,segment);if(fs.lstatSync(current).isSymbolicLink())fail('Linked maintenance path');}return file;}
function bounded(file,limit=4000000){const fd=fs.openSync(safe(file),'r');try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.size>limit)fail('Invalid maintenance artifact size or links');const bytes=Buffer.alloc(stat.size);let offset=0;while(offset<bytes.length){const count=fs.readSync(fd,bytes,offset,bytes.length-offset,null);if(!count)fail('Maintenance artifact truncated');offset+=count;}if(fs.readSync(fd,Buffer.alloc(1),0,1,null)!==0||fs.fstatSync(fd).size!==stat.size)fail('Maintenance artifact changed during read');return bytes;}finally{fs.closeSync(fd);}}
function createHost({trustPath=path.join(process.env.LOCALAPPDATA||path.join(require('node:os').homedir(),'AppData/Local'),'MarcoAITeam/maintenance-trust/public.pem'),expectedKeySha256=HOST_KEY_SHA256}={}){
 function owner(root){const absolute=path.resolve(root);if(path.basename(path.dirname(absolute)).toLowerCase()==='.dev-work'&&uuid.test(path.basename(absolute)))return path.dirname(path.dirname(absolute));return absolute;}
 function signed(root){
  root=owner(root);const dir=path.join(root,'.dev-work/.maintenance-v2');
  if(!fs.existsSync(dir))return null;safe(dir);
  const names=fs.readdirSync(dir).filter(name=>/^[a-f0-9-]{36}\.json$/i.test(name));
  if(names.length!==1)fail('Missing or ambiguous signed maintenance');
  const name=names[0],id=name.slice(0,-5);if(!uuid.test(id))fail('Invalid maintenance identity');
  const bytes=bounded(path.join(dir,name)),signatureText=bounded(path.join(dir,id+'.sig'),1024).toString().trim();
  if(!/^[A-Za-z0-9+/]+={0,2}$/.test(signatureText))fail('Invalid maintenance signature');
  const key=crypto.createPublicKey(bounded(trustPath,8192));if(key.asymmetricKeyType!=='ed25519'||!/^[a-f0-9]{64}$/.test(expectedKeySha256)||hash(key.export({type:'spki',format:'der'}))!==expectedKeySha256)fail('Unpinned or changed maintenance trust key');
  if(!crypto.verify(null,Buffer.concat([Buffer.from('MarcoAITeam maintenance v2\n'),bytes]),key,Buffer.from(signatureText,'base64')))fail('Unauthenticated maintenance approval');
  const record=JSON.parse(bytes);if(record.maintenanceId!==id||record.schema!==2||record.purpose!=='INVENTORY_TRANSITION'||record.authorizesApply!==false||record.authorizesRelease!==false||record.authorizesPublish!==false)fail('Invalid maintenance record');
  inventory(record.historical);inventory(record.input);inventory(record.result);
  const reviewers={'antigravity/native-gemini':'gemini','codex/native-review':'codex'};
  if(!Object.hasOwn(reviewers,record.reviewerIdentity)||!['codex','gemini'].includes(record.authorIdentity)||reviewers[record.reviewerIdentity]===record.authorIdentity)fail('Missing independent reviewer');
  const backup=path.join(root,'.backups/host-maintenance',id);safe(backup);
  const evidence={};
  for(const [field,file] of [['patchSha256','patch.json'],['testReportSha256','tests.json'],['reviewSha256','review.json']]){
    const artifact=bounded(path.join(backup,file),16000000);
    if(!/^[a-f0-9]{64}$/.test(record[field]||'')||hash(artifact)!==record[field])fail('Maintenance evidence changed: '+field);
    evidence[file]=JSON.parse(artifact);
  }
  const review=evidence['review.json'];
  if(review.decision!=='APPROVE'||review.reviewerIdentity!==record.reviewerIdentity||review.patchSha256!==record.patchSha256||review.testReportSha256!==record.testReportSha256||review.resultInventorySha256!==hash(Buffer.from(JSON.stringify(record.result)))||!Array.isArray(review.blockers)||review.blockers.length)fail('Review not bound to maintenance patch');
  const tests=evidence['tests.json'];
  const patch=evidence['patch.json'];
  if(!/^[a-f0-9]{64}$/.test(record.inputInventorySha256||'')||hash(Buffer.from(JSON.stringify(record.input)))!==record.inputInventorySha256)fail('Invalid input checkpoint hash');
  const inputPaths=new Set(record.input.map(row=>row.path)),resultPaths=new Set(record.result.map(row=>row.path));
  if(record.historical.some(row=>!inputPaths.has(row.path))||record.input.some(row=>!resultPaths.has(row.path)))fail('Maintenance inventory downgrade');
  const inputBytes=bounded(path.join(backup,'input-manifest.json'));
  if(hash(inputBytes)!==record.inputInventorySha256||JSON.stringify(JSON.parse(inputBytes))!==JSON.stringify(record.input))fail('Independent input checkpoint mismatch');
  const originalReceiptBytes=bounded(path.join(backup,'installed-original.json'));
  const originalReceipt=JSON.parse(originalReceiptBytes);
  if(hash(originalReceiptBytes)!==record.receiptSha256||originalReceipt.schema!==1||originalReceipt.version!==record.version||originalReceipt.stageId!==record.stageId||originalReceipt.stageSeal!==record.historical.map(row=>row.path+':'+row.sha256).join('|'))fail('Original receipt checkpoint mismatch');
  if(record.historicalInventorySha256!==hash(Buffer.from(JSON.stringify(record.historical))))fail('Historical checkpoint hash mismatch');
  const context={maintenanceId:record.maintenanceId,receiptSha256:record.receiptSha256,inputInventorySha256:record.inputInventorySha256,historicalInventorySha256:record.historicalInventorySha256,authorIdentity:record.authorIdentity};
  for(const artifact of [patch,tests,review])if(Object.entries(context).some(([key,value])=>artifact[key]!==value))fail('Evidence belongs to another maintenance context');
  if(tests.patchSha256!==record.patchSha256)fail('Tests belong to another patch');
  if(tests.passed!==true||tests.resultInventorySha256!==review.resultInventorySha256||patch.inputInventorySha256!==record.inputInventorySha256||patch.resultInventorySha256!==review.resultInventorySha256)fail('Patch or tests not bound to maintained bytes');
  return {root,bytes,record,backup,originalReceiptBytes};
 }
 function select(root,historical){const accepted=signed(root);if(!accepted){if(expectedKeySha256!=='UNCONFIGURED')fail('Required signed inventory missing');return [...historical];}if(JSON.stringify(accepted.record.historical.map(row=>row.path))!==JSON.stringify(historical))fail('Historical inventory changed');
  const receiptBytes=bounded(path.join(accepted.root,'.dev-work/.lineage/installed.json')),receipt=JSON.parse(receiptBytes);
  const rows=capture(accepted.root,accepted.record.result),seal=rows.map(row=>row.path+':'+row.sha256).join('|');
  if(receipt.schema!==1||!(hash(receiptBytes)===accepted.record.receiptSha256&&JSON.stringify(rows)===JSON.stringify(accepted.record.result)||receipt.stageSeal===seal))fail('Inventory not bound to installed receipt and bytes');
  return accepted.record.result.map(row=>row.path);}
 function provenance(root,{nativeLineageStore,historical}){
  const accepted=signed(root);if(!accepted)return null;
  if(path.resolve(root)!==accepted.root)fail('Provenance requires installed root');
  const {record,backup,bytes,originalReceiptBytes}=accepted;
  const directory=path.join(root,'.dev-work/.lineage');
  const read=key=>{if(!/^(installed|parent-[a-f0-9]{64}|(?:child|seal)-[a-f0-9-]{36})$/i.test(key))fail('Unsafe lineage key');const filename=path.join(directory,key+'.json');return fs.existsSync(filename)?JSON.parse(bounded(filename,64000000)):null;};
  const receiptBytes=bounded(path.join(directory,'installed.json')),receipt=JSON.parse(receiptBytes);
  const allowed=record.result.map(row=>row.path);
  const originalPaths=record.historical.map(row=>row.path);
  if(JSON.stringify(originalPaths)!==JSON.stringify(historical))fail('Historical inventory changed');
  const recoveredRoot=path.join(backup,'released-baseline');
  const historicalRead=name=>{if(!historical.includes(name))fail('Historical read outside inventory');return bounded(path.join(recoveredRoot,name),64000000);};
  const originalReceipt=JSON.parse(originalReceiptBytes);
  if(JSON.stringify(capture(recoveredRoot,record.historical))!==JSON.stringify(record.historical))fail('Recovered payload changed');
  const original=nativeLineageStore({read:key=>key==='installed'?originalReceipt:read(key),rootRead:historicalRead},historical).parentForRoot();
  if(original.parentSeal!==originalReceipt.stageSeal)fail('Original lineage changed');
  const current=capture(root,record.result),seal=current.map(row=>row.path+':'+row.sha256).join('|');
  if(receipt.stageSeal===seal){
    const verified=nativeLineageStore({read,rootRead:name=>{if(!allowed.includes(name))fail('Root read outside inventory');return bounded(path.join(root,name),64000000);},maintenanceIdentity:()=>hash(bytes)},allowed,historical).parentForRoot();
    if(verified.parentSeal!==seal)fail('Installed payload lineage mismatch');
    return Object.freeze({schema:2,installedVersion:receipt.version,installedStageId:receipt.stageId,installedReceiptHash:hash(receiptBytes),originalSeal:seal,currentSeal:seal,maintenanceId:record.maintenanceId,inventoryPaths:allowed,recordSha256:hash(bytes),authorizesApply:false,authorizesRelease:false,authorizesPublish:false});
  }
  const verify=createVerifier({verifyApproval:({recordSha256})=>recordSha256===hash(bytes),verifyHistorical:()=>{
    return original.parentSeal===receipt.stageSeal;
  }});
  const result=verify({root,recoveredRoot,receiptBytes,recordBytes:bytes,expectedInputSha256:record.inputInventorySha256,expectedResultPaths:allowed});
  return Object.freeze({schema:2,originalSeal:result.originalSeal,currentSeal:result.currentSeal,recordSha256:result.recordSha256,installedVersion:receipt.version,installedStageId:receipt.stageId,installedReceiptHash:hash(receiptBytes),maintenanceId:record.maintenanceId,inventoryPaths:allowed,authorizesApply:false,authorizesRelease:false,authorizesPublish:false});
 }
 function verifyInput(root){const accepted=signed(root);if(!accepted)fail('Signed checkpoint required');if(JSON.stringify(capture(accepted.root,accepted.record.input))!==JSON.stringify(accepted.record.input))fail('Input changed before activation');return hash(accepted.bytes);}
 function identity(root){const accepted=signed(root);if(!accepted)fail('Signed checkpoint required');return hash(accepted.bytes);}
 return {select,provenance,verifyInput,identity};
}
module.exports={createHost};
