import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { ApiError, fields, invalid, string } from './lib.js';

const derive = promisify(scrypt);
const options = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const publicColumns = 'id, email, display_name AS "displayName", steam_id AS "steamId"';

function credentials(body, register) {
  fields(body, register ? ['email', 'password', 'displayName'] : ['email', 'password']);
  const email = string(body.email, 254, 'Email').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) invalid('Введите действительный email.');
  const password = string(body.password, 128, 'Пароль', register ? 8 : 1);
  return { email, password };
}

async function startSession(req, id) {
  await promisify(req.session.regenerate.bind(req.session))();
  req.session.userId = id;
  await promisify(req.session.save.bind(req.session))();
}

export function requireUser(req, res, next) {
  if (!req.session?.userId) throw new ApiError(401, 'login_required', 'Сначала войдите в аккаунт.');
  next();
}

export function authRoutes(pool) {
  const router = Router();
  const limiter = rateLimit({
    windowMs: 15 * 60_000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { error: { code: 'auth_rate_limit', message: 'Слишком много попыток. Попробуйте позже.' } }
  });
  router.post('/register', limiter, async (req, res) => {
    const { email, password } = credentials(req.body, true);
    const displayName = string(req.body.displayName, 80, 'Имя').trim();
    if (!displayName) invalid('Введите имя пользователя.');
    const salt = randomBytes(16).toString('hex');
    const hash = (await derive(password, salt, 64, options)).toString('hex');
    const encoded = ['scrypt-v1', salt, hash].join('$');
    const { rows } = await pool.query(
      'INSERT INTO users(email, password_hash, display_name) VALUES ($1,$2,$3) ON CONFLICT (lower(email)) DO NOTHING RETURNING ' + publicColumns,
      [email, encoded, displayName]);
    if (!rows.length) throw new ApiError(409, 'email_taken', 'Этот email уже зарегистрирован.');
    await startSession(req, rows[0].id);
    res.status(201).json(rows[0]);
  });
  router.post('/login', limiter, async (req, res) => {
    const { email, password } = credentials(req.body, false);
    const { rows } = await pool.query('SELECT password_hash, ' + publicColumns + ' FROM users WHERE lower(email)=$1', [email]);
    const user = rows[0];
    const [version, salt, hash] = (user?.password_hash ?? '').split('$');
    const actual = await derive(password, salt || 'missing-account', 64, options);
    const stored = Buffer.from(hash || '', 'hex');
    if (version !== 'scrypt-v1' || stored.length !== actual.length || !timingSafeEqual(actual, stored))
      throw new ApiError(401, 'bad_credentials', 'Неверный email или пароль.');
    delete user.password_hash;
    await startSession(req, user.id);
    res.json(user);
  });
  router.get('/me', requireUser, async (req, res) => {
    const { rows } = await pool.query('SELECT ' + publicColumns + ' FROM users WHERE id=$1', [req.session.userId]);
    if (!rows.length) throw new ApiError(401, 'login_required', 'Сначала войдите в аккаунт.');
    res.json(rows[0]);
  });
  router.post('/logout', requireUser, async (req, res) => {
    await promisify(req.session.destroy.bind(req.session))();
    res.clearCookie('collection.sid', { path: '/' }).sendStatus(204);
  });
  return router;
}
