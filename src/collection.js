import { Router } from 'express';
import { ApiError, fields, invalid, positiveId, string, transaction } from './lib.js';
import { entry, list } from './repositories/collection.js';

const statuses = ['planned', 'playing', 'completed', 'paused', 'dropped'];
const editable = ['status', 'rating', 'notes', 'nextStep', 'completedAt', 'playtimeMinutes'];

function changes(body, current) {
  const game = { ...current, ...body };
  if (!statuses.includes(game.status)) invalid('Выберите статус из списка.');
  if (game.rating !== null && (!Number.isInteger(game.rating) || game.rating < 1 || game.rating > 10))
    invalid('Оценка должна быть целым числом от 1 до 10.');
  string(game.notes, 2000, 'Заметка', 0);
  game.nextStep = string(game.nextStep, 240, 'В следующий раз', 0).trim();
  if ('playtimeMinutes' in body && current.steamAppId) invalid('Время этой игры обновляется из Steam.');
  if (!Number.isInteger(game.playtimeMinutes) || game.playtimeMinutes < 0 || game.playtimeMinutes > 2147483647)
    invalid('Укажите игровое время целым числом минут.');
  if (body.completedAt != null && game.status !== 'completed') invalid('Дата доступна для пройденных игр.');
  if (game.status !== 'completed') game.completedAt = null;
  if (game.completedAt !== null) {
    const date = game.completedAt;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        date.startsWith('0000') || !Number.isFinite(Date.parse(date)) ||
        new Date(date).toISOString().slice(0,10) !== date) invalid('Введите действительную дату в формате ГГГГ-ММ-ДД.');
  }
  return game;
}

function pageNumber(value, max) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || Number(value) > max)
    invalid('Некорректные параметры страницы.');
  return Number(value);
}

export function collectionRoutes(pool, getAchievements) {
  const router = Router();
  router.get('/:id/achievements', async (req, res) => {
    const { rows: [source] } = await pool.query(`SELECT u.steam_id,g.steam_app_id FROM user_games ug
      JOIN users u ON u.id=ug.user_id JOIN games g ON g.id=ug.game_id
      WHERE ug.user_id=$1 AND ug.id=$2`, [req.session.userId, positiveId(req.params.id)]);
    if (!source) throw new ApiError(404,'entry_missing','Игра не найдена в вашей коллекции.');
    if (!source.steam_app_id || !source.steam_id) invalid('Достижения доступны для игр, импортированных из Steam.');
    res.json(await getAchievements(source.steam_id, source.steam_app_id));
  });
  router.get('/', async (req, res) => {
    fields(req.query, ['q','status','unplayed','sort','direction','page','pageSize']);
    const { unplayed = 'false' } = req.query;
    if (!['true','false'].includes(unplayed)) invalid('Фильтр запусков принимает true или false.');
    const { q = '', status = null, sort = 'title', direction = sort === 'title' ? 'asc' : 'desc' } = req.query;
    string(q, 255, 'Поиск', 0);
    if (status !== null && !statuses.includes(status)) invalid('Неизвестный статус.');
    if (!['title','time','rating','recent'].includes(sort) || !['asc','desc'].includes(direction)) invalid('Неизвестная сортировка.');
    res.json(await list(pool, req.session.userId, { q, status, sort, direction, unplayed: unplayed === 'true',
      page: pageNumber(req.query.page ?? '1', 2147483647), pageSize: pageNumber(req.query.pageSize ?? '20', 100) }));
  });
  router.post('/', async (req, res) => {
    fields(req.body, ['title', ...editable]);
    const title = string(req.body.title, 255, 'Название').trim();
    if (!title) invalid('Введите название игры.');
    const game = changes(req.body, { status: 'planned', rating: null, notes: '', nextStep: '', completedAt: null, playtimeMinutes: 0 });
    const user = req.session.userId;
    const result = await transaction(pool, async db => {
      const created = await db.query('INSERT INTO games(title,created_by) VALUES ($1,$2) RETURNING id', [title,user]);
      const added = await db.query(`INSERT INTO user_games(user_id,game_id,status,rating,notes,completed_at,playtime_minutes,next_step)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [user, created.rows[0].id, game.status, game.rating, game.notes, game.completedAt, game.playtimeMinutes, game.nextStep]);
      return entry(db, user, added.rows[0].id);
    });
    res.status(201).json(result);
  });
  router.get('/:id', async (req, res) => res.json(await entry(pool, req.session.userId, positiveId(req.params.id))));
  router.patch('/:id', async (req, res) => {
    const id = positiveId(req.params.id);
    const user = req.session.userId;
    fields(req.body, editable);
    if (!Object.keys(req.body).length) invalid('Передайте хотя бы одно поле.');
    const result = await transaction(pool, async db => {
      const game = changes(req.body, await entry(db, user, id, true));
      await db.query(`UPDATE user_games SET status=$3,rating=$4,notes=$5,completed_at=$6,playtime_minutes=$7,next_step=$8
        WHERE user_id=$1 AND id=$2`, [user,id,game.status,game.rating,game.notes,game.completedAt,game.playtimeMinutes,game.nextStep]);
      return entry(db, user, id);
    });
    res.json(result);
  });
  router.delete('/:id', async (req, res) => {
    const user = req.session.userId;
    const id = positiveId(req.params.id);
    await transaction(pool, async db => {
      await entry(db, user, id, true);
      const removed = await db.query('DELETE FROM user_games WHERE user_id=$1 AND id=$2 RETURNING game_id', [user,id]);
      await db.query('DELETE FROM games WHERE created_by=$1 AND id=$2', [user,removed.rows[0].game_id]);
    });
    res.sendStatus(204);
  });
  return router;
}
