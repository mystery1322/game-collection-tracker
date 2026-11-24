import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {delimiter, join} from 'node:path';
import {randomBytes} from 'node:crypto';

export async function startJava(pool, steamPort, secret=randomBytes(32).toString('hex')) {
  const db=pool.options;
  const java=process.env.JAVA_HOME ? join(process.env.JAVA_HOME,'bin','java') : 'java';
  const cp=['target/classes','target/test-classes','target/dependency/*'].join(delimiter);
  const child=spawn(java,['-cp',cp,'ru.savepoint.TestServer'],{
    windowsHide:true,stdio:['pipe','pipe','inherit'],
    env:{...process.env,PGHOST:db.host,PGPORT:String(db.port),PGDATABASE:db.database,PGUSER:db.user,PGPASSWORD:db.password,
      PORT:'0',APP_ORIGIN:'http://localhost:3000',SESSION_SECRET:secret,TEST_STEAM_PORT:String(steamPort)}
  });
  const closed=once(child,'exit');
  const lines=createInterface({input:child.stdout});
  try {
    const first=await Promise.race([once(lines,'line'),closed.then(()=>{throw Error('Java stopped before accepting requests');}),
      once(child,'error').then(([e])=>{throw e;})]);
    const match=/^READY (\d+)$/.exec(first[0]);
    if(!match)throw Error('Java did not return its port');
    return {url:'http://127.0.0.1:'+match[1],close:async()=>{child.stdin.end();await closed;}};
  }catch(e){child.stdin.end();throw e;}
}
