import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { Client, Pool } from 'pg';
import { roleSql } from '../scripts/setup-local.js';

const execute = promisify(execFile);
const bin = process.env.PG_BIN ?? (process.platform === 'win32' ? 'C:/Program Files/PostgreSQL/18/bin' : '');
const program = name => path.join(bin, name + (process.platform === 'win32' ? '.exe' : ''));

export async function testDatabase(t) {
  const temp = await realpath(tmpdir());
  const dir = await mkdtemp(path.join(temp, 'course-games-test-'));
  const data = path.join(dir, 'data');
  const password = randomBytes(32).toString('hex');
  const pwfile = path.join(dir, 'initial-password');
  let started = false;
  t.after(async () => {
    if (started) await execute(program('pg_ctl'), ['-D',data,'-m','fast','-w','stop'], { windowsHide:true });
    const target = await realpath(dir);
    if (path.dirname(target) !== temp || !path.basename(target).startsWith('course-games-test-')) throw Error('Unexpected test directory');
    await rm(target, {recursive:true,force:true,maxRetries:3,retryDelay:200});
  });
  await writeFile(pwfile,password + '\n',{mode:0o600});
  await execute(program('initdb'),['-D',data,'-U','test_owner','-A','scram-sha-256',
    '--pwfile='+pwfile,'-E','UTF8','--locale=C','--no-sync'], {windowsHide:true});
  const probe = createServer();
  await new Promise((resolve,reject) => probe.once('error',reject).listen(0,'127.0.0.1',resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  // A Windows postmaster can inherit pipes from pg_ctl and keep execFile waiting.
  await new Promise((resolve, reject) => {
    const child = spawn(program('pg_ctl'), ['-D',data,'-l',path.join(dir,'postgres.log'),'-o',
      '-h 127.0.0.1 -p '+port,'-w','start'], { windowsHide:true, stdio:'ignore' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(Error('pg_ctl start: ' + code)));
  });
  started = true;
  const config = { host:'127.0.0.1',port,user:'test_owner',password,database:'postgres' };
  async function admin(database, operation) {
    const client = new Client({...config,database});
    await client.connect();
    try { await operation(client); } finally { await client.end(); }
  }
  await admin('postgres', db => db.query('CREATE DATABASE game_collection'));
  const appPassword = randomBytes(32).toString('hex');
  await admin('game_collection', async db => {
    await db.query(await readFile(new URL('../db/migrations/001_initial_schema.sql',import.meta.url),'utf8'));
    await db.query(await readFile(new URL('../db/migrations/002_next_step.sql',import.meta.url),'utf8'));
    await db.query(await roleSql(appPassword));
  });
  return new Pool({...config,user:'game_collection_app',password:appPassword,database:'game_collection'});
}
