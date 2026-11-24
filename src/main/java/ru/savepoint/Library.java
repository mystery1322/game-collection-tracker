package ru.savepoint;

import com.google.gson.*;
import java.sql.*;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.*;
import static ru.savepoint.Api.*;
import static ru.savepoint.Pg.*;

final class Library {
    private static final String COLUMNS = """
        ug.id,g.title,g.steam_app_id::text AS "steamAppId",g.icon_url AS "iconUrl",
        ug.status,ug.playtime_minutes AS "playtimeMinutes",ug.rating,ug.notes,ug.next_step AS "nextStep",
        ug.completed_at::text AS "completedAt",ug.updated_at AS "updatedAt",ug.last_played_at AS "lastPlayedAt"
        """;
    private static final String JOIN=" FROM user_games ug JOIN games g ON g.id=ug.game_id ";
    private static final Set<String> STATUSES=Set.of("unassigned","planned","playing","paused","dropped","completed");
    private static final Map<String,String> SORT=Map.of("title","lower(g.title)","time","ug.playtime_minutes","rating","ug.rating","recent","ug.last_played_at");
    private static final String[] EDIT={"status","rating","notes","nextStep","completedAt","playtimeMinutes"};
    static JsonObject entry(Connection db,int user,int id,boolean lock) throws SQLException {
        var row=one(db,"SELECT "+COLUMNS+JOIN+"WHERE ug.user_id=$1 AND ug.id=$2"+(lock?" FOR UPDATE OF ug":""),user,id);
        if(row==null)throw missing();
        return row;
    }
    static JsonObject list(Connection db,int user,Map<String,String> q) throws SQLException {
        if(!Set.of("q","status","sort","direction","unplayed","page","pageSize").containsAll(q.keySet()))throw invalid("Неизвестный параметр.");
        String sort=q.getOrDefault("sort","title"),dir=q.getOrDefault("direction","title".equals(sort)?"asc":"desc"),
            status=q.get("status"),unplayed=q.getOrDefault("unplayed","false"),term=q.getOrDefault("q","");
        if(!SORT.containsKey(sort)||!Set.of("asc","desc").contains(dir)||!Set.of("true","false").contains(unplayed)||
            (status!=null&&!STATUSES.contains(status)))throw invalid("Проверьте фильтр или сортировку.");
        str(obj("q",term),"q",0,255);
        int page=positive(q.getOrDefault("page","1"),Integer.MAX_VALUE),size=positive(q.getOrDefault("pageSize","20"),100);
        String order=" ORDER BY sort_key "+dir.toUpperCase(Locale.ROOT)+" NULLS LAST,id";
        String sql="WITH matches AS (SELECT "+COLUMNS+","+SORT.get(sort)+" AS sort_key"+JOIN+"""
            WHERE ug.user_id=$1 AND strpos(lower(g.title),lower($2))>0 AND ($3::text IS NULL OR ug.status=$3)
            AND (NOT $4 OR (g.steam_app_id IS NOT NULL AND ug.playtime_minutes=0 AND ug.last_played_at IS NULL))
            ), page_rows AS (SELECT * FROM matches
            """+order+" LIMIT $5 OFFSET $6) SELECT (SELECT count(*) FROM matches) AS total,"+
            "coalesce(jsonb_agg(to_jsonb(page_rows)-'sort_key'"+order+"),'[]') AS items FROM page_rows";
        var result=one(db,sql,user,term,status,Boolean.parseBoolean(unplayed),size,(long)(page-1)*size);
        result.addProperty("page",page);result.addProperty("pageSize",size);return result;
    }
    static JsonObject save(Connection db,int user,Integer id,JsonObject patch) throws SQLException {
        JsonObject g;
        if(id==null){
            var allowed=new ArrayList<>(List.of(EDIT));allowed.add("title");fields(patch,allowed.toArray(String[]::new));
            var title=str(patch,"title",1,255).strip();if(title.isEmpty())throw invalid("Введите название.");
            var game=one(db,"INSERT INTO games(title,created_by) VALUES ($1,$2) RETURNING id",title,user);
            id=one(db,"INSERT INTO user_games(user_id,game_id) VALUES ($1,$2) RETURNING id",user,game.get("id").getAsInt()).get("id").getAsInt();
        }else{
            fields(patch,EDIT);if(patch.size()==0)throw invalid("Передайте хотя бы одно поле.");
        }
        g=entry(db,user,id,true);
        if(patch.has("playtimeMinutes")&&val(g,"steamAppId")!=null)throw invalid("Время игры обновляется из Steam.");
        for(var field:patch.entrySet())g.add(field.getKey(),field.getValue());
        var status=str(g,"status",1,20);
        if(!STATUSES.contains(status))throw invalid("Неизвестный статус.");
        Integer rating=g.get("rating").isJsonNull()?null:integer(g,"rating",1,10);
        String note=str(g,"notes",0,2000),next=str(g,"nextStep",0,240).strip(),date=null;
        int minutes=integer(g,"playtimeMinutes",0,Integer.MAX_VALUE);
        if(patch.has("completedAt")&&!patch.get("completedAt").isJsonNull()&&!status.equals("completed"))throw invalid("Дата доступна для пройденных игр.");
        if(status.equals("completed")&&!g.get("completedAt").isJsonNull()){
            date=str(g,"completedAt",10,10);
            try{if(!date.matches("(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}")||!LocalDate.parse(date).toString().equals(date))throw invalid("Проверьте дату.");}
            catch(DateTimeParseException e){throw invalid("Проверьте дату.");}
        }
        rows(db,"UPDATE user_games SET status=$3,rating=$4,notes=$5,completed_at=$6::date,playtime_minutes=$7,next_step=$8 WHERE user_id=$1 AND id=$2",user,id,status,rating,note,date,minutes,next);
        return entry(db,user,id,false);
    }
    static void remove(Connection db,int user,int id) throws SQLException{
        entry(db,user,id,true);
        var removed=one(db,"DELETE FROM user_games WHERE user_id=$1 AND id=$2 RETURNING game_id",user,id);
        rows(db,"DELETE FROM games WHERE created_by=$1 AND id=$2",user,removed.get("game_id").getAsInt());
    }
    static JsonObject stats(Connection db,int user) throws SQLException{
        var s=one(db,"SELECT *,EXISTS(SELECT 1 FROM steam_sync_runs WHERE user_id=$1 AND status='success') AS imported FROM user_statistics WHERE user_id=$1",user);
        var counts=new JsonObject();int assigned=0;
        for(String k:List.of("planned","playing","completed","paused","dropped")){
            int n=s.get(k+"_games").getAsInt();counts.addProperty(k,n);assigned+=n;
        }
        counts.addProperty("unassigned",s.get("total_games").getAsInt()-assigned);
        var top=rows(db,"SELECT ug.id,g.title,ug.playtime_minutes AS \"playtimeMinutes\""+JOIN+
            "WHERE ug.user_id=$1 AND ug.playtime_minutes>0 ORDER BY ug.playtime_minutes DESC,ug.id LIMIT 5",user);
        return obj("hasSteamImport",s.get("imported"),"totalGames",s.get("total_games"),"completionPercent",s.get("completion_percent"),
            "totalPlaytimeMinutes",s.get("total_playtime_minutes"),"averageRating",s.get("average_rating"),"byStatus",counts,"topGames",top);
    }
    static JsonObject achievementSource(Connection db,int user,int id) throws SQLException {
        var s=one(db,"SELECT u.steam_id,g.steam_app_id FROM user_games ug JOIN users u ON u.id=ug.user_id JOIN games g ON g.id=ug.game_id WHERE ug.user_id=$1 AND ug.id=$2",user,id);
        if(s==null)throw missing();
        if(val(s,"steam_id")==null||val(s,"steam_app_id")==null)throw invalid("Достижения доступны для импортированных игр.");
        return s;
    }
}
