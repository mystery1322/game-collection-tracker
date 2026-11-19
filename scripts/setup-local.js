import { randomBytes, createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export async function roleSql(password) {
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password, salt, 4096, 32, 'sha256');
  const key = tag => createHmac('sha256', salted).update(tag).digest();
  const stored = createHash('sha256').update(key('Client Key')).digest('base64');
  const verifier = 'SCRAM-SHA-256$4096:' + salt.toString('base64') + '$' + stored + ':' + key('Server Key').toString('base64');
  const template = await readFile(new URL('../db/app-role.sql', import.meta.url), 'utf8');
  return template.replace('__SCRAM_VERIFIER__', () => verifier);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const root = new URL('../', import.meta.url);
  const envFile = new URL('.env', root);
  const password = randomBytes(32).toString('hex');
  const secret = randomBytes(48).toString('hex');
  const template = await readFile(new URL('.env.example', root),'utf8');
  try {
    await writeFile(envFile, template.replace('PGPASSWORD=', 'PGPASSWORD='+password)
      .replace('SESSION_SECRET=', 'SESSION_SECRET='+secret), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const env = parseEnv(await readFile(envFile, 'utf8'));
  if (!env.PGPASSWORD || env.PGUSER !== 'game_collection_app' || !/^[\x21-\x7e]+$/.test(env.PGPASSWORD))
    throw new Error('Для настройки требуется локальный пароль из печатных символов ASCII и роль game_collection_app.');
  await mkdir(new URL('tmp/', root), { recursive: true });
  await writeFile(new URL('tmp/setup-role.sql', root), await roleSql(env.PGPASSWORD), { mode: 0o600 });
  console.log('Настройки готовы. В DBeaver выполните tmp/setup-role.sql в базе game_collection один раз.');
}
