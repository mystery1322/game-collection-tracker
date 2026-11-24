package ru.savepoint;

import com.google.gson.*;
import java.net.*;
import java.net.http.*;
import java.time.*;
import java.util.*;
import java.util.regex.Pattern;
import static ru.savepoint.Api.*;

class Steam {
    static final String OPENID="https://steamcommunity.com/openid/login",NS="http://specs.openid.net/auth/2.0";
    private final HttpClient http=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).followRedirects(HttpClient.Redirect.NEVER).build();
    private final String key,api,verifyUrl;
    Steam(String key){this(key,"https://api.steampowered.com",OPENID);}
    Steam(String key,String api,String verifyUrl){this.key=key;this.api=api;this.verifyUrl=verifyUrl;}
    static Api denied(){return new Api(401,"steam_login_failed","Steam не подтвердил вход.");}
    private static String form(Map<String,String> q){
        var parts=new StringJoiner("&");q.forEach((k,v)->parts.add(enc(k)+"="+enc(v)));return parts.toString();
    }
    private static String callback(String origin,String state){return origin+"/api/auth/steam/callback?state="+enc(state);}
    String start(String origin,String state){
        return OPENID+"?"+form(Map.of("openid.ns",NS,"openid.mode","checkid_setup","openid.realm",origin+"/","openid.return_to",callback(origin,state),
            "openid.identity",NS+"/identifier_select","openid.claimed_id",NS+"/identifier_select"));
    }
    String verify(Map<String,String> q,JsonObject challenge,String origin)throws Exception{
        if(challenge==null||System.currentTimeMillis()-challenge.get("started").getAsLong()>600000||
            !Objects.equals(q.get("state"),val(challenge,"state")))throw denied();
        if("cancel".equals(q.get("openid.mode")))throw new Api(401,"steam_cancelled","Вход отменён.");
        String claimed=q.getOrDefault("openid.claimed_id",""),nonce=q.getOrDefault("openid.response_nonce","");
        var id=Pattern.compile("https?://steamcommunity\\.com/openid/id/([0-9]{17})").matcher(claimed);
        var signed=List.of(q.getOrDefault("openid.signed","").split(","));
        var required=List.of("op_endpoint","claimed_id","identity","return_to","response_nonce","assoc_handle");
        if(!id.matches()||!claimed.equals(q.get("openid.identity"))||!NS.equals(q.get("openid.ns"))||
            !"id_res".equals(q.get("openid.mode"))||!OPENID.equals(q.get("openid.op_endpoint"))||!callback(origin,q.get("state")).equals(q.get("openid.return_to"))||
            !signed.containsAll(required)||required.stream().anyMatch(k->!q.containsKey("openid."+k))||
            q.getOrDefault("openid.sig","").isEmpty()||!nonce.matches("\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ.+"))throw denied();
        try{if(Math.abs(Duration.between(Instant.parse(nonce.substring(0,20)),Instant.now()).toSeconds())>600)throw denied();}catch(DateTimeException e){throw denied();}
        var data=new LinkedHashMap<String,String>();q.forEach((k,v)->{if(k.startsWith("openid."))data.put(k,v);});data.put("openid.mode","check_authentication");
        var request=HttpRequest.newBuilder(URI.create(verifyUrl)).timeout(Duration.ofSeconds(12)).header("Content-Type","application/x-www-form-urlencoded")
            .POST(HttpRequest.BodyPublishers.ofString(form(data))).build();
        HttpResponse<String> reply;
        try{reply=http.send(request,HttpResponse.BodyHandlers.ofString());}catch(java.io.IOException e){throw new Api(502,"steam_unavailable","Сервис входа Steam временно недоступен.");}
        if(reply.statusCode()!=200||reply.body().lines().noneMatch("is_valid:true"::equals))throw denied();
        return id.group(1);
    }
    private JsonObject get(String path,Map<String,String> parameters,boolean authenticated){
        if(key==null||key.isBlank())throw new Api(503,"steam_unconfigured","Для загрузки нужен серверный ключ Steam.");
        var req=HttpRequest.newBuilder(URI.create(api+path+"?"+form(parameters))).timeout(Duration.ofSeconds(12));
        if(authenticated)req.header("x-webapi-key",key);
        try{
            var res=http.send(req.GET().build(),HttpResponse.BodyHandlers.ofString());
            if(res.statusCode()/100!=2)throw new Api(502,"steam_http_error","Steam отклонил запрос.");
            return JsonParser.parseString(res.body()).getAsJsonObject();
        }catch(HttpTimeoutException e){throw new Api(504,"steam_timeout","Steam не ответил вовремя.");}
        catch(InterruptedException e){Thread.currentThread().interrupt();throw new Api(502,"steam_unavailable","Запрос прерван.");}
        catch(java.io.IOException|JsonParseException|IllegalStateException e){throw new Api(502,"steam_unavailable","Не удалось получить данные от Steam.");}
    }
    private static long whole(JsonObject g,String k,long min,long max){
        var n=g.get(k);if(n!=null&&n.isJsonPrimitive()&&n.getAsJsonPrimitive().isNumber()){
            try{long value=n.getAsBigDecimal().longValueExact();if(value>=min&&value<=max)return value;}catch(ArithmeticException ignored){}
        }
        throw new IllegalArgumentException(k);
    }
    JsonArray library(String sid){
        var params=obj("steamid",sid,"include_appinfo",true,"include_played_free_games",true,"skip_unvetted_apps",false);
        var reply=get("/IPlayerService/GetOwnedGames/v1/",Map.of("input_json",params.toString()),true);
        try{
            var d=reply.getAsJsonObject("response");long count=whole(d,"game_count",0,Integer.MAX_VALUE);
            var games=d.has("games")?d.getAsJsonArray("games"):new JsonArray();
            if(count!=games.size())throw new IllegalArgumentException();
            var result=new JsonArray();var seen=new HashSet<Long>();
            for(var el:games){
                var g=el.getAsJsonObject();long id=whole(g,"appid",1,4294967295L),minutes=whole(g,"playtime_forever",0,Integer.MAX_VALUE);
                var title=str(g,"name",1,255).strip();
                if(title.isEmpty()||!seen.add(id))throw new IllegalArgumentException();
                String icon=val(g,"img_icon_url"),played=null;
                if(icon!=null&&icon.matches("(?i)[a-f0-9]{40}"))icon="https://media.steampowered.com/steamcommunity/public/images/apps/"+id+"/"+icon+".jpg";else icon=null;
                try{played=Instant.ofEpochSecond(whole(g,"rtime_last_played",1,4294967295L)).toString();}catch(IllegalArgumentException ignored){}
                result.add(obj("appid",id,"title",title,"minutes",minutes,"icon",icon,"played_at",played));
            }
            return result;
        }catch(RuntimeException e){throw new Api(502,"steam_data_unavailable","Steam не вернул полный список игр.");}
    }
    private JsonObject optional(String method,Map<String,String> q,boolean auth){
        try{return get("/ISteamUserStats/"+method+"/",q,auth);}catch(Api e){return new JsonObject();}
    }
    private static JsonArray array(JsonObject o,String... path){
        JsonElement current=o;for(String k:path){if(current==null||!current.isJsonObject())return new JsonArray();current=current.getAsJsonObject().get(k);}
        return current!=null&&current.isJsonArray()?current.getAsJsonArray():new JsonArray();
    }
    JsonElement achievements(String sid,String app,boolean summary){
        if(key==null||key.isBlank())throw new Api(503,"steam_unconfigured","Для загрузки нужен серверный ключ Steam.");
        try{
            var player=get("/ISteamUserStats/GetPlayerAchievements/v1/",Map.of("steamid",sid,"appid",app,"l","russian"),true).getAsJsonObject("playerstats");
            if(!player.get("success").getAsBoolean()||!sid.equals(val(player,"steamID")))throw new IllegalArgumentException();
            var items=player.has("achievements")?player.getAsJsonArray("achievements"):new JsonArray();
            int unlocked=0;for(var e:items){var i=e.getAsJsonObject();str(i,"apiname",1,65535);unlocked+=(int)whole(i,"achieved",0,1);}
            if(summary)return obj("total",items.size(),"unlocked",unlocked,"perfect",items.size()>0&&unlocked==items.size());
            var result=new JsonArray();if(items.isEmpty())return result;
            var defs=new HashMap<String,JsonObject>();var globals=new HashMap<String,JsonElement>();
            var schema=optional("GetSchemaForGame/v2",Map.of("appid",app,"l","russian"),true);
            for(var e:array(schema,"game","availableGameStats","achievements")){var i=e.getAsJsonObject();defs.put(val(i,"name"),i);}
            var rates=optional("GetGlobalAchievementPercentagesForApp/v2",Map.of("gameid",app),false);
            for(var e:array(rates,"achievementpercentages","achievements")){
                var i=e.getAsJsonObject();try{double n=i.get("percent").getAsDouble();if(n>=0&&n<=100)globals.put(val(i,"name"),new JsonPrimitive(n));}catch(RuntimeException ignored){}
            }
            for(var e:items){var i=e.getAsJsonObject();var k=val(i,"apiname");var def=defs.get(k);
                String name=val(i,"name");if(name==null||name.isBlank())name=Objects.toString(val(def,"displayName"),k);
                result.add(obj("name",name,"description",Objects.toString(val(i,"description"),""),"unlocked",i.get("achieved").getAsInt()==1,
                    "icon",val(def,"icon"),"globalPercent",globals.get(k)));}
            return result;
        }catch(RuntimeException e){throw new Api(502,"achievements_unavailable","Steam не предоставил достижения для этой игры и профиля.");}
    }
}
