const assert=require('node:assert/strict');
const http=require('node:http');
const {test}=require('node:test');
const fs=require('node:fs');
const path=require('node:path');
const Module=require('node:module');
// Compile the actual router in memory; the test-only runner seam is never written to server.js.
const filename=path.join(__dirname,'server.js');
const app=new Module(filename,module);
app.filename=filename;app.paths=Module._nodeModulePaths(__dirname);
app._compile(fs.readFileSync(filename,'utf8')+'\nmodule.exports.testServer=server;module.exports.setTestRunner=runner=>{runConversationEngine=runner;};',filename);
const {marcoItAskGeminiRoute,testServer:server,setTestRunner}=app.exports;

test('HTTP Gemini bridge: unchanged prompt, validation, errors and cancellation',async()=>{
  let calls=0,mode='success',cancelled;
  const runner=async(provider,prompt,signal)=>{
    calls++;assert.equal(provider,'gemini');assert(signal instanceof AbortSignal);
    if(mode==='timeout')throw Object.assign(Error('timeout'),{timedOut:true});
    if(mode==='failure')throw Error('private diagnostic');
    if(mode==='cancel')return new Promise(resolve=>signal.addEventListener('abort',()=>{cancelled();resolve('cancelled');},{once:true}));
    assert.equal(prompt,'  richiesta\nimmutata  ');return 'Risposta Gemini';
  };
  setTestRunner(runner);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  const request=(body,headers={},method='POST')=>new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port,path:'/api/marco-it/ask-gemini',method,headers:{host:'127.0.0.1:3210','content-type':'application/json','content-length':Buffer.byteLength(body),...headers}},res=>{
      let text='';res.on('data',d=>text+=d);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));
    });req.on('error',reject);req.end(body);
  });
  try {
    assert.deepEqual(await request(JSON.stringify({prompt:'  richiesta\nimmutata  '})),{status:200,body:{provider:'gemini',answer:'Risposta Gemini'}});
    for(const body of ['{}','null','[]','{"prompt":42}','{"prompt":"  "}','{','{"prompt":"x","context":"y"}'])assert.equal((await request(body)).status,400);
    assert.equal((await request('{}',{'content-type':'text/plain'})).status,415);
    assert.equal((await request('{}',{origin:'https://external.test'})).status,403);
    assert.equal((await request('{}',{host:'external.test'})).status,403);
    assert.equal((await request('{}',{},'GET')).status,405);
    assert.equal((await request(JSON.stringify({prompt:'x'.repeat(131072)}))).status,413);
    assert.equal(calls,1);
    mode='timeout';assert.equal((await request('{"prompt":"x"}')).status,504);
    mode='failure';const failed=await request('{"prompt":"x"}');assert.equal(failed.status,502);assert(!JSON.stringify(failed).includes('private diagnostic'));
    mode='cancel';await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('AbortSignal not cancelled')),2000);
      cancelled=()=>{clearTimeout(timer);resolve();};
      const req=http.request({host:'127.0.0.1',port,path:'/api/marco-it/ask-gemini',method:'POST',headers:{host:'localhost:3210','content-type':'application/json'}});
      req.on('error',()=>{});req.end('{"prompt":"x"}');
      const poll=setInterval(()=>{if(calls===4){clearInterval(poll);req.destroy();}},5);
    });
    const req={socket:{remoteAddress:'192.0.2.1'},on(){},removeListener(){}};
    let status;const res={on(){},removeListener(){},writeHead(code){status=code;},end(){}};
    await marcoItAskGeminiRoute(req,res,runner);assert.equal(status,403);assert.equal(calls,4);
  } finally {await new Promise(resolve=>server.close(resolve));}
});
