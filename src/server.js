import { Pool } from 'pg';
import { createApp } from './app.js';
import { steamLibrary } from './integrations/steam.js';
import { steamAchievements } from './integrations/achievements.js';

const env = process.env;
const port = Number(env.PORT || 3000);
const origin = env.APP_ORIGIN || 'http://localhost:' + port;
if (!env.PGPASSWORD || !env.SESSION_SECRET || env.SESSION_SECRET.length < 32)
  throw new Error('Заполните PGPASSWORD и SESSION_SECRET в .env. См. раздел «Запуск сервера» в README.');
const pool = new Pool({ host: env.PGHOST || '127.0.0.1', port: Number(env.PGPORT || 5432),
  database: env.PGDATABASE || 'game_collection', user: env.PGUSER || 'game_collection_app',
  password: env.PGPASSWORD, connectionTimeoutMillis: 5000 });
pool.on('error', error => console.error('Соединение PostgreSQL прервано:', error.code));
try {
  await pool.query('SELECT 1 FROM user_statistics LIMIT 0');
  const { app, store } = createApp({ pool, secret: env.SESSION_SECRET, origin,
    getLibrary: steamLibrary(env.STEAM_API_KEY), getAchievements: steamAchievements(env.STEAM_API_KEY) });
  const server = app.listen(port, '127.0.0.1', () => console.log('API запущен:', origin + '/api/health'));
  const stop = () => server.close(async () => { await store.close(); await pool.end(); });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} catch (error) {
  console.error('Не удалось подключиться к схеме PostgreSQL. Проверьте .env, роль и миграцию.', error.code);
  await pool.end();
  process.exitCode = 1;
}
