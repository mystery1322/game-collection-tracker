import express from 'express';
import { fileURLToPath } from 'node:url';
import session from 'express-session';
import pgSession from 'connect-pg-simple';
import { authRoutes, requireUser } from './auth.js';
import { collectionRoutes } from './collection.js';
import { statistics } from './repositories/collection.js';
import { setSource, synchronize, syncStatus } from './services/steam-sync.js';
import { ApiError, fields, invalid } from './lib.js';

export function createApp({ pool, secret, origin, getLibrary, steamLoginFetch }) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['GET','HEAD','OPTIONS'].includes(req.method)) {
      if ((req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site')
        throw new ApiError(403, 'origin_denied', 'Запрос с другого сайта запрещён.');
      if (!req.is('application/json') && (req.headers['transfer-encoding'] || Number(req.headers['content-length']) > 0))
        throw new ApiError(415, 'json_required', 'Передайте данные в формате JSON.');
    }
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  app.use(express.static(fileURLToPath(new URL('../public/', import.meta.url))));
  const Store = pgSession(session);
  const store = new Store({ pool, tableName: 'sessions', createTableIfMissing: false });
  app.use(session({ name: 'collection.sid', secret, store, resave: false, saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: origin.startsWith('https:'), maxAge: 7*24*60*60*1000 } }));
  app.get('/api/health', async (req, res) => {
    await pool.query('SELECT 1 FROM user_statistics LIMIT 0');
    res.json({ status: 'ok' });
  });
  app.use('/api/auth', authRoutes(pool, origin, steamLoginFetch));
  app.use('/api', requireUser);
  app.use('/api/collection', collectionRoutes(pool));
  app.get('/api/statistics', async (req, res) => res.json(await statistics(pool, req.session.userId)));
  app.put('/api/steam/source', async (req, res) => {
    fields(req.body,['steamId']);
    if (typeof req.body.steamId !== 'string' || !/^[0-9]{17}$/.test(req.body.steamId)) invalid('SteamID64 должен содержать 17 цифр.');
    res.json(await setSource(pool, req.session.userId, req.body.steamId));
  });
  app.post('/api/steam/sync', async (req, res) => res.json(await synchronize(pool, req.session.userId, getLibrary)));
  app.get('/api/steam/sync-status', async (req, res) => res.json(await syncStatus(pool, req.session.userId)));
  app.use((req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Адрес не найден.' } }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    let detail = error;
    if (error.constraint === 'user_games_completion_not_future') detail = new ApiError(400,'invalid_input','Дата завершения не может быть в будущем.');
    if (error.type === 'entity.parse.failed') detail = new ApiError(400,'invalid_json','Не удалось прочитать JSON.');
    if (error.type === 'entity.too.large') detail = new ApiError(413,'body_too_large','Слишком большой запрос.');
    if (!(detail instanceof ApiError)) {
      console.error('Ошибка обработки запроса:', error.code ?? error.name);
      detail = new ApiError(500,'internal_error','Не удалось выполнить операцию на сервере.');
    }
    res.status(detail.status).json({ error: { code: detail.code, message: detail.message } });
  });
  return { app, store };
}
