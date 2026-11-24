import {existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {delimiter,join} from 'node:path';

const testing=process.argv[2]==='test';
const win=process.platform==='win32';
const env={...process.env};
if(!env.JAVA_HOME && win){
  const installed=join(env.ProgramFiles??'C:\\Program Files','Java','jdk-21');
  if(existsSync(join(installed,'bin','java.exe')))env.JAVA_HOME=installed;
}
function run(command,args){
  return new Promise((resolve,reject)=>{
    const p=spawn(command,args,{env,stdio:'inherit',windowsHide:true});
    const stop=()=>p.kill();
    process.once('SIGTERM',stop);
    p.once('error',reject);
    p.once('exit',(code,signal)=>{process.off('SIGTERM',stop);if(code===0)resolve();else reject(new Error(command+' завершился: '+(code??signal)));});
  });
}
const goals=[testing?'test-compile':'compile','dependency:copy-dependencies'];
try{
  if(win)await run(process.env.ComSpec??'cmd.exe',['/d','/c','mvnw.cmd','-q',...goals]);
  else await run('./mvnw',['-q',...goals]);
  if(testing)await run(process.execPath,['--test','tests/api.test.js']);
  else await run(env.JAVA_HOME?join(env.JAVA_HOME,'bin','java'):'java',['-cp',['target/classes','target/dependency/*'].join(delimiter),'ru.savepoint.Server']);
}catch(e){console.error(e.message);process.exitCode=1;}
