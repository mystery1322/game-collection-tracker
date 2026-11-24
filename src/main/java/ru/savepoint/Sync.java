package ru.savepoint;

import com.google.gson.*;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.Objects;
import static ru.savepoint.Api.*;
import static ru.savepoint.Pg.*;

final class Sync {
    private static final String RUN = """
        id,steam_id AS "steamId",status,added_count AS "addedCount",updated_count AS "updatedCount",
        error_code AS "errorCode",started_at AS "startedAt",finished_at AS "finishedAt"
        """;
    private static final String IMPORT = """
        WITH incoming AS (
          SELECT * FROM jsonb_to_recordset($2::jsonb) AS x(appid bigint,title text,icon text,minutes int,played_at timestamptz)
        ), catalog AS (
          INSERT INTO games(steam_app_id,title,icon_url)
          SELECT appid,title,icon FROM incoming ORDER BY appid
          ON CONFLICT(steam_app_id) DO UPDATE SET title=excluded.title,icon_url=coalesce(excluded.icon_url,games.icon_url)
          RETURNING id,steam_app_id
        ), collection AS (
          INSERT INTO user_games(user_id,game_id,playtime_minutes,last_played_at)
          SELECT $1,c.id,i.minutes,i.played_at FROM catalog c JOIN incoming i ON i.appid=c.steam_app_id ORDER BY c.id
          ON CONFLICT(user_id,game_id) DO UPDATE SET playtime_minutes=excluded.playtime_minutes,
            last_played_at=greatest(user_games.last_played_at,excluded.last_played_at)
          RETURNING old.id IS NULL AS added
        ) SELECT count(*) FILTER(WHERE added)::int AS added,count(*) FILTER(WHERE NOT added)::int AS updated FROM collection
        """;
    final Pg pg;
    final Steam steam;
    Sync(Pg pg,Steam steam){this.pg=pg;this.steam=steam;}
    private String lock(Connection db,int user)throws SQLException{
        var u=one(db,"SELECT steam_id FROM users WHERE id=$1 FOR NO KEY UPDATE",user);
        rows(db,"UPDATE steam_sync_runs SET status='failed',error_code='sync_interrupted',finished_at=clock_timestamp() WHERE user_id=$1 AND status='running' AND started_at<now()-interval '2 minutes'",user);
        return val(u,"steam_id");
    }
    private static Api busy(){return new Api(409,"sync_running","Импорт уже выполняется.");}
    JsonObject source(int user,String sid)throws Exception{
        if(!sid.matches("[0-9]{17}"))throw invalid("SteamID64 должен содержать 17 цифр.");
        return pg.tx(db->{
            if(!Objects.equals(lock(db,user),sid)){
                var history=one(db,"SELECT status FROM steam_sync_runs WHERE user_id=$1 AND status IN ('running','success') ORDER BY id DESC LIMIT 1",user);
                if(history!=null){if("running".equals(val(history,"status")))throw busy();throw new Api(409,"source_locked","После импорта источник закреплён за коллекцией.");}
                rows(db,"UPDATE users SET steam_id=$2 WHERE id=$1",user,sid);
            }
            return obj("steamId",sid);
        });
    }
    JsonObject status(int user)throws Exception{
        return pg.tx(db->{var sid=lock(db,user);
            var last=one(db,"SELECT "+RUN+" FROM steam_sync_runs WHERE user_id=$1 ORDER BY id DESC LIMIT 1",user);
            var success=one(db,"SELECT max(finished_at) AS time FROM steam_sync_runs WHERE user_id=$1 AND status='success'",user);
            return obj("steamId",sid,"latest",last,"lastSuccessAt",success.get("time"));});
    }
    JsonObject run(int user)throws Exception{
        var attempt=pg.tx(db->{
            var sid=lock(db,user);if(sid==null)throw new Api(400,"source_required","Сначала сохраните SteamID64.");
            var last=one(db,"SELECT status,started_at>now()-interval '1 minute' AS recent FROM steam_sync_runs WHERE user_id=$1 ORDER BY id DESC LIMIT 1",user);
            if(last!=null){if("running".equals(val(last,"status")))throw busy();
                if(last.get("recent").getAsBoolean())throw new Api(429,"sync_rate_limit","Между попытками должна пройти минута.");}
            return one(db,"INSERT INTO steam_sync_runs(user_id,steam_id) VALUES ($1,$2) RETURNING id,steam_id",user,sid);
        });
        int id=attempt.get("id").getAsInt();
        try{
            var games=steam.library(val(attempt,"steam_id"));
            return pg.tx(db->{
                if(one(db,"SELECT id FROM steam_sync_runs WHERE id=$1 AND status='running' FOR UPDATE",id)==null)throw new Api(409,"sync_interrupted","Попытка уже завершена.");
                var counts=one(db,IMPORT,user,games.toString());
                return one(db,"UPDATE steam_sync_runs SET status='success',finished_at=clock_timestamp(),added_count=$2,updated_count=$3 WHERE id=$1 RETURNING "+RUN,
                    id,counts.get("added").getAsInt(),counts.get("updated").getAsInt());});
        }catch(Exception e){
            pg.tx(db->rows(db,"UPDATE steam_sync_runs SET status='failed',error_code=$2,finished_at=clock_timestamp() WHERE id=$1 AND status='running'",id,e instanceof Api a?a.code:"sync_failed"));
            throw e;
        }
    }
}
