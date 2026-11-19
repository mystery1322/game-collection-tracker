import { ApiError, transaction } from '../lib.js';

const runColumns = `id,steam_id AS "steamId",status,added_count AS "addedCount",updated_count AS "updatedCount",
  error_code AS "errorCode",started_at AS "startedAt",finished_at AS "finishedAt"`;

async function lockSource(db, user) {
  const { rows } = await db.query('SELECT steam_id FROM users WHERE id=$1 FOR NO KEY UPDATE', [user]);
  await db.query(`UPDATE steam_sync_runs SET status='failed',error_code='sync_interrupted',finished_at=clock_timestamp()
    WHERE user_id=$1 AND status='running' AND started_at < now()-interval '2 minutes'`, [user]);
  return rows[0].steam_id;
}

function busy() {
  return new ApiError(409, 'sync_running', 'Импорт уже выполняется.');
}

export function setSource(pool, user, steamId) {
  return transaction(pool, async db => {
    const current = await lockSource(db, user);
    if (current === steamId) return { steamId };
    const history = await db.query("SELECT status FROM steam_sync_runs WHERE user_id=$1 AND status IN ('running','success') LIMIT 1", [user]);
    if (history.rows[0]?.status === 'running') throw busy();
    if (history.rowCount) throw new ApiError(409, 'source_locked', 'После успешного импорта источник закреплён за коллекцией.');
    await db.query('UPDATE users SET steam_id=$2 WHERE id=$1', [user,steamId]);
    return { steamId };
  });
}

export async function syncStatus(pool, user) {
  return transaction(pool, async db => {
    const steamId = await lockSource(db, user);
    const recent = await db.query('SELECT ' + runColumns + ' FROM steam_sync_runs WHERE user_id=$1 ORDER BY id DESC LIMIT 1', [user]);
    const success = await db.query("SELECT max(finished_at) AS time FROM steam_sync_runs WHERE user_id=$1 AND status='success'", [user]);
    return { steamId, latest: recent.rows[0] ?? null, lastSuccessAt: success.rows[0].time };
  });
}

async function reserve(pool, user) {
  return transaction(pool, async db => {
    const steamId = await lockSource(db, user);
    if (!steamId) throw new ApiError(400, 'source_required', 'Сначала сохраните SteamID64.');
    const { rows } = await db.query(`SELECT status, started_at > now()-interval '1 minute' AS recent
      FROM steam_sync_runs WHERE user_id=$1 ORDER BY id DESC LIMIT 1`, [user]);
    if (rows[0]?.status === 'running') throw busy();
    if (rows[0]?.recent) throw new ApiError(429, 'sync_rate_limit', 'Между попытками импорта должна пройти минута.');
    const added = await db.query('INSERT INTO steam_sync_runs(user_id,steam_id) VALUES ($1,$2) RETURNING id', [user, steamId]);
    return { id: added.rows[0].id, steamId };
  });
}

export async function synchronize(pool, user, getLibrary) {
  const run = await reserve(pool, user);
  try {
    const library = await getLibrary(run.steamId);
    return await transaction(pool, async db => {
      const active = await db.query("SELECT id FROM steam_sync_runs WHERE id=$1 AND status='running' FOR UPDATE", [run.id]);
      if (!active.rowCount) throw new ApiError(409, 'sync_interrupted', 'Попытка импорта уже завершена.');
      const counts = await db.query(`WITH incoming AS (
        SELECT * FROM jsonb_to_recordset($2::jsonb) AS x(appid bigint,title text,icon text,minutes int)
      ), catalog AS (
        INSERT INTO games(steam_app_id,title,icon_url)
        SELECT appid,title,icon FROM incoming ORDER BY appid
        ON CONFLICT(steam_app_id) DO UPDATE SET title=excluded.title,icon_url=coalesce(excluded.icon_url,games.icon_url)
        RETURNING id,steam_app_id
      ), collection AS (
        INSERT INTO user_games(user_id,game_id,playtime_minutes)
        SELECT $1,c.id,i.minutes FROM catalog c JOIN incoming i ON i.appid=c.steam_app_id ORDER BY c.id
        ON CONFLICT(user_id,game_id) DO UPDATE SET playtime_minutes=excluded.playtime_minutes
        RETURNING old.id IS NULL AS added
      ) SELECT count(*) FILTER(WHERE added)::int AS added,count(*) FILTER(WHERE NOT added)::int AS updated FROM collection`,
        [user,JSON.stringify(library)]);
      const { added, updated } = counts.rows[0];
      const result = await db.query(`UPDATE steam_sync_runs SET status='success',finished_at=clock_timestamp(),
        added_count=$2,updated_count=$3 WHERE id=$1 RETURNING ` + runColumns, [run.id,added,updated]);
      return result.rows[0];
    });
  } catch (error) {
    await pool.query(`UPDATE steam_sync_runs SET status='failed',error_code=$2,finished_at=clock_timestamp()
      WHERE id=$1 AND status='running'`, [run.id,error instanceof ApiError ? error.code : 'sync_failed']);
    throw error;
  }
}
