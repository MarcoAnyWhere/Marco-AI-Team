'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function fail(message){throw Object.assign(Error(message),{code:'MAINTENANCE_PROVENANCE_INVALID'});}
function inventory(rows){
  if(!Array.isArray(rows)||!rows.length)fail('Missing inventory');
  const seen=new Set();
  for(const row of rows){
    if(!row||typeof row.path!=='string'||!/^[A-Za-z0-9_.@/-]+$/.test(row.path)||row.path.split('/').some(part=>!part||part==='.'||part==='..'||/[. ]$/.test(part)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))||! /^[a-f0-9]{64}$/.test(row.sha256)||!Number.isSafeInteger(row.size)||row.size<0)fail('Invalid inventory entry');
    const key=row.path.toLowerCase();if(seen.has(key))fail('Duplicate inventory path');seen.add(key);
  }
  return rows;
}
function unlinked(filename){
  const absolute=path.resolve(filename),root=path.parse(absolute).root;
  let current=root;
  for(const segment of absolute.slice(root.length).split(path.sep).filter(Boolean)){
    current=path.join(current,segment);
    if(fs.lstatSync(current).isSymbolicLink())fail('Linked inventory path');
  }
  return absolute;
}
function capture(root,rows){
  if(typeof root!=='string'||!path.isAbsolute(root))fail('Absolute root required');
  inventory(rows);
  return rows.map(row=>{
    const filename=unlinked(path.join(root,row.path)),fd=fs.openSync(filename,'r');
    try {
      const stat=fs.fstatSync(fd);
      if(!stat.isFile()||stat.nlink!==1)fail('Payload is not an independent regular file');
      if(stat.size>64000000)fail('Payload file exceeds size limit');
      const bytes=Buffer.alloc(stat.size);let offset=0;
      while(offset<bytes.length){const count=fs.readSync(fd,bytes,offset,bytes.length-offset,null);if(!count)fail('Payload truncated during read');offset+=count;}
      const after=fs.fstatSync(fd),named=fs.lstatSync(filename);
      if(fs.readSync(fd,Buffer.alloc(1),0,1,null)!==0||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||named.ino!==stat.ino||named.dev!==stat.dev||named.isSymbolicLink())fail('Payload changed during read');
      return {path:row.path,sha256:hash(bytes),size:bytes.length};
    }finally{fs.closeSync(fd);}
  });
}
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
// Approval authority is supplied by trusted host code, never by record fields.
// This module does not implement signing, approve records or activate maintenance.
function createVerifier({verifyApproval,verifyHistorical}){
  if(typeof verifyApproval!=='function'||typeof verifyHistorical!=='function')throw TypeError('Trusted host verification callbacks required');
  return function verify({root,recoveredRoot,receiptBytes,recordBytes,approval,expectedInputSha256,expectedResultPaths}){
    if(!Buffer.isBuffer(receiptBytes)||!Buffer.isBuffer(recordBytes)||recordBytes.length>4000000)fail('Invalid record bytes');
    let record,receipt;try{record=JSON.parse(recordBytes);receipt=JSON.parse(receiptBytes);}catch{fail('Malformed JSON');}
    const recordSha256=hash(recordBytes);
    if(verifyApproval({recordSha256,approval})!==true)fail('Unauthenticated maintenance review');
    if(record.schema!==2||record.purpose!=='INVENTORY_TRANSITION'||record.authorizesApply!==false||record.authorizesRelease!==false||record.authorizesPublish!==false)fail('Invalid maintenance authority');
    if(record.receiptSha256!==hash(receiptBytes)||receipt.schema!==1||record.version!==receipt.version||record.stageId!==receipt.stageId)fail('Receipt binding mismatch');
    if(!/^[a-f0-9]{64}$/.test(expectedInputSha256||'')||record.inputInventorySha256!==expectedInputSha256)fail('Untrusted input checkpoint');
    inventory(record.historical);inventory(record.input);inventory(record.result);
    if(hash(Buffer.from(JSON.stringify(record.input)))!==expectedInputSha256)fail('Input inventory changed');
    const seal=record.historical.map(row=>row.path+':'+row.sha256).join('|');
    if(seal!==receipt.stageSeal)fail('Historical receipt inventory mismatch');
    if(!equal(capture(recoveredRoot,record.historical),record.historical))fail('Recovered payload changed');
    if(verifyHistorical({receiptBytes,recoveredRoot,historical:structuredClone(record.historical)})!==true)fail('Historical lineage invalid');
    // Product host defines the complete expected inventory, independently of record.
    if(!Array.isArray(expectedResultPaths)||!equal(record.result.map(row=>row.path),expectedResultPaths))fail('Incomplete maintained inventory');
    const historicalPaths=new Set(record.historical.map(row=>row.path));
    const inputPaths=new Set(record.input.map(row=>row.path));
    if([...historicalPaths].some(name=>!inputPaths.has(name))||[...inputPaths].some(name=>!expectedResultPaths.includes(name)))fail('Inventory downgrade');
    const rows=capture(root,record.result);
    if(!equal(rows,record.result))fail('Maintained payload changed');
    return Object.freeze({schema:2,recordSha256,receiptSha256:record.receiptSha256,version:record.version,stageId:record.stageId,
      inventorySha256:hash(Buffer.from(JSON.stringify(rows))),currentSeal:rows.map(row=>row.path+':'+row.sha256).join('|'),originalSeal:receipt.stageSeal,
      authorizesApply:false,authorizesRelease:false,authorizesPublish:false});
  };
}
module.exports={createVerifier,capture,inventory,hash};
