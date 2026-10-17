'use strict';
const {spawn}=require('node:child_process');
const ROOT=__dirname;
const FLAGS=Object.freeze({'p1-lineage':'--p1-lineage-test','p1-safety':'--p1-safety-test',p2:'--p2-test',conversation:'--conversation-test'});
const TIMEOUT_MS=60000, CAPTURE_BYTES=65536;
function createProjectTestRunner({spawnChild=spawn,timeoutMs=TIMEOUT_MS,captureBytes=CAPTURE_BYTES}={}) {
  let busy=false;
  return async function runProjectTest(input) {
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==1||!Object.hasOwn(input,'testId')||typeof input.testId!=='string'||!Object.hasOwn(FLAGS,input.testId))throw Object.assign(Error('Only an allowlisted testId is accepted.'),{code:'INVALID_TEST_ID'});
    const {testId}=input,started=Date.now();
    const result={testId,ok:false,exitCode:null,durationMs:0,stdout:'',stderr:'',firstFailure:null};
    if(busy)return {...result,error:'BUSY'};
    busy=true;
    try {
      return await new Promise(resolve=>{
        let child,timer,settled=false,error=null;
        const output={stdout:[],stderr:[]},sizes={stdout:0,stderr:0};
        function finish(code){
          if(settled)return;settled=true;clearTimeout(timer);
          for(const stream of ['stdout','stderr'])result[stream]=Buffer.concat(output[stream]).toString('utf8');
          for(const line of (result.stdout+'\n'+result.stderr).split(/\r?\n/))try{const data=JSON.parse(line);if(data.firstFailure!=null){result.firstFailure=data.firstFailure;break;}if(data.status==='FAIL'||data.passed===false){result.firstFailure=data;break;}}catch{}
          resolve({...result,ok:code===0&&!error,exitCode:code,durationMs:Date.now()-started,...(error?{error}:{} )});
        }
        function stop(reason){if(error||settled)return;error=reason;clearTimeout(timer);try{child.kill('SIGKILL');}catch{}timer=setTimeout(()=>finish(null),1000);}
        try {
          child=spawnChild(process.execPath,[require('node:path').join(ROOT,'server.js'),FLAGS[testId]],{cwd:ROOT,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
          child.once('error',()=>{error='SPAWN_ERROR';finish(null);});
          child.once('close',code=>finish(code));
          for(const stream of ['stdout','stderr'])child[stream].on('data',chunk=>{
            if(settled||error)return;
            const bytes=Buffer.from(chunk),remaining=captureBytes-sizes[stream];
            output[stream].push(bytes.subarray(0,Math.max(0,remaining)));sizes[stream]+=Math.min(bytes.length,Math.max(0,remaining));
            if(bytes.length>remaining)stop('OUTPUT_LIMIT');
          });
          timer=setTimeout(()=>stop('TIMEOUT'),timeoutMs);
        }catch{error='SPAWN_ERROR';finish(null);}
      });
    }finally{busy=false;}
  };
}
const runProjectTest=createProjectTestRunner();
module.exports={FLAGS,TIMEOUT_MS,CAPTURE_BYTES,createProjectTestRunner,runProjectTest};
