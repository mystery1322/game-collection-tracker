import { ApiError } from '../lib.js';

const projection = `ug.id, g.title, g.steam_app_id::text AS "steamAppId", g.icon_url AS "iconUrl",
  ug.status, ug.playtime_minutes AS "playtimeMinutes", ug.rating, ug.notes, ug.next_step AS "nextStep",
  ug.completed_at::text AS "completedAt", ug.updated_at AS "updatedAt", ug.last_played_at AS "lastPlayedAt"`;
const joined = ' FROM user_games ug JOIN games g ON g.id=ug.game_id ';
const sortColumns = new Map([['title','lower(g.title)'], ['time','ug.playtime_minutes'], ['rating','ug.rating'], ['recent','ug.last_played_at']]);

export async function entry(db, user, id, lock = false) {
  const { rows } = await db.query('SELECT ' + projection + joined +
    'WHERE ug.user_id=$1 AND ug.id=$2' + (lock ? ' FOR UPDATE OF ug' : ''), [user, id]);
  if (!rows.length) throw new ApiError(404, 'entry_missing', 'Игра не найдена в вашей коллекции.');
  return rows[0];
}

export async function list(db, user, { q, status, sort, direction, page, pageSize }) {
  const where = `WHERE ug.user_id=$1 AND strpos(lower(g.title), lower($2)) > 0
                 AND ($3::text IS NULL OR ug.status=$3)`;
  const column = sortColumns.get(sort);
  const order = direction === 'asc' ? 'ASC' : 'DESC';
  const sql = `WITH matches AS (
    SELECT ${projection}, ${column} AS sort_key ${joined} ${where}
  ), page_rows AS (
    SELECT * FROM matches ORDER BY sort_key ${order} NULLS LAST, id LIMIT $4 OFFSET $5
  ) SELECT (SELECT count(*)::int FROM matches) AS total,
    COALESCE(jsonb_agg(to_jsonb(page_rows) - 'sort_key' ORDER BY sort_key ${order} NULLS LAST, id), '[]') AS items
    FROM page_rows`;
  const result = await db.query(sql, [user, q, status, pageSize, (page-1)*pageSize]);
  return { ...result.rows[0], page, pageSize };
}

export async function statistics(db, user) {
  const { rows } = await db.query(`SELECT s.*,
    EXISTS(SELECT 1 FROM steam_sync_runs WHERE user_id=$1 AND status='success') AS "hasSteamImport", (
    SELECT coalesce(json_agg(top_games ORDER BY "playtimeMinutes" DESC,id),'[]')
    FROM (SELECT ug.id,g.title,ug.playtime_minutes AS "playtimeMinutes" ${joined}
          WHERE ug.user_id=$1 AND ug.playtime_minutes>0
          ORDER BY ug.playtime_minutes DESC,ug.id LIMIT 5) top_games
    ) AS "topGames" FROM user_statistics s WHERE user_id=$1`, [user]);
  const row = rows[0];
  return { hasSteamImport: row.hasSteamImport, totalGames: Number(row.total_games), completionPercent: Number(row.completion_percent),
    totalPlaytimeMinutes: Number(row.total_playtime_minutes),
    averageRating: row.average_rating === null ? null : Number(row.average_rating),
    byStatus: Object.fromEntries(['planned','playing','completed','paused','dropped'].map(status =>
      [status, Number(row[status + '_games'])])), topGames: row.topGames };
}
