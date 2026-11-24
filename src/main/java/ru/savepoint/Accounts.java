package ru.savepoint;

import com.google.gson.*;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.sql.*;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import org.bouncycastle.crypto.generators.SCrypt;
import static ru.savepoint.Api.*;
import static ru.savepoint.Pg.*;

final class Accounts {
    static final String PUBLIC="id,email,display_name AS \"displayName\",steam_id AS \"steamId\"";
    private static final SecureRandom RANDOM=new SecureRandom();
    private final Pg pg;
    private final Steam steam;
    private final String origin,secret;
    private final Map<String,Window> failures=new ConcurrentHashMap<>();
    private record Window(long since,int failures){}
    Accounts(Pg pg,Steam steam,String origin,String secret){this.pg=pg;this.steam=steam;this.origin=origin;this.secret=secret;}
    static String token(int n){var b=new byte[n];RANDOM.nextBytes(b);return HexFormat.of().formatHex(b);}
    static byte[] hash(String password,String salt){return SCrypt.generate(password.getBytes(StandardCharsets.UTF_8),salt.getBytes(StandardCharsets.UTF_8),32768,8,3,64);}
    private String sign(String id)throws Exception{
        var mac=Mac.getInstance("HmacSHA256");mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8),"HmacSHA256"));
        return Base64.getEncoder().withoutPadding().encodeToString(mac.doFinal(id.getBytes(StandardCharsets.UTF_8)));
    }
    String sid(Request r)throws Exception{
        for(String c:Objects.toString(r.header("Cookie"),"").split(";")){
            c=c.trim();if(!c.startsWith("collection.sid="))continue;
            String v;
            try{v=URLDecoder.decode(c.substring("collection.sid=".length()).replace("+","%2B"),StandardCharsets.UTF_8);}catch(IllegalArgumentException e){return null;}
            var m=java.util.regex.Pattern.compile("s:([A-Za-z0-9_-]{20,128})\\.([A-Za-z0-9+/]{43})").matcher(v);
            if(m.matches()&&MessageDigest.isEqual(sign(m.group(1)).getBytes(StandardCharsets.US_ASCII),m.group(2).getBytes(StandardCharsets.US_ASCII)))return m.group(1);
        }
        return null;
    }
    private JsonObject session(String id)throws Exception{
        if(id==null)return null;
        var row=pg.tx(db->one(db,"SELECT sess FROM sessions WHERE sid=$1 AND expire>now()",id));
        return row==null?null:row.getAsJsonObject("sess");
    }
    int user(Request r)throws Exception{
        var s=session(sid(r));if(s==null||!s.has("userId"))throw login();return s.get("userId").getAsInt();
    }
    private void cookie(Request r,String value,int age){
        r.x.getResponseHeaders().add("Set-Cookie","collection.sid="+value+"; Path=/; HttpOnly; SameSite=Lax; Max-Age="+age+(origin.startsWith("https:")?"; Secure":""));
    }
    private String persist(Connection db,String old,JsonObject state)throws Exception{
        if(old!=null)rows(db,"DELETE FROM sessions WHERE sid=$1",old);
        rows(db,"DELETE FROM sessions WHERE expire<=now()");
        var id=token(32);
        rows(db,"INSERT INTO sessions(sid,sess,expire) VALUES ($1,$2::json,now()+interval '7 days')",id,state.toString());
        return enc("s:"+id+"."+sign(id));
    }
    void routes(Request r)throws Exception{
        String address=r.x.getRemoteAddress().getAddress().getHostAddress();
        boolean limited=Set.of("/api/auth/register","/api/auth/login","/api/auth/steam","/api/auth/steam/callback").contains(r.path);
        long now=System.currentTimeMillis();
        if(limited){failures.entrySet().removeIf(e->now-e.getValue().since>=900000);
            var w=failures.get(address);if(w!=null&&w.failures>=30)throw new Api(429,"auth_rate_limit","Повторите вход позже.");}
        try{dispatch(r);}catch(Api e){
            if(limited)failures.compute(address,(k,w)->new Window(w==null?now:w.since,w==null?1:w.failures+1));throw e;
        }
    }
    private void dispatch(Request r)throws Exception{
        String old=sid(r);
        if(r.is("GET","/api/auth/steam")){
            var s=session(old);if(s!=null&&s.has("userId")){r.redirect("/#collection");return;}
            var state=token(32);
            cookie(r,pg.tx(db->persist(db,old,obj("steamLogin",obj("state",state,"started",System.currentTimeMillis())))),604800);
            r.redirect(steam.start(origin,state));return;
        }
        if(r.is("GET","/api/auth/steam/callback")){
            r.x.getResponseHeaders().set("Referrer-Policy","no-referrer");
            try{
                var s=session(old);var challenge=s==null?null:s.getAsJsonObject("steamLogin");
                var steamId=steam.verify(r.q,challenge,origin);
                String signed=pg.tx(db->{
                    var used=one(db,"DELETE FROM sessions WHERE sid=$1 AND sess->'steamLogin'->>'state'=$2 RETURNING sid",old,val(challenge,"state"));
                    if(used==null)throw Steam.denied();
                    var u=one(db,"INSERT INTO users(steam_login_id,steam_id,display_name) VALUES ($1,$1,$2) ON CONFLICT(steam_login_id) DO UPDATE SET steam_login_id=excluded.steam_login_id RETURNING id",steamId,"Игрок Steam · "+steamId.substring(13));
                    return persist(db,null,obj("userId",u.get("id")));
                });
                cookie(r,signed,604800);r.redirect("/?steamImport=1#collection");
            }catch(Api e){r.redirect("/?steamLogin="+enc(e.code));}return;
        }
        if(r.is("GET","/api/auth/me")){
            int uid=user(r);var u=pg.tx(db->one(db,"SELECT "+PUBLIC+" FROM users WHERE id=$1",uid));if(u==null)throw login();r.send(200,u);return;
        }
        if(r.is("POST","/api/auth/logout")){
            user(r);pg.tx(db->rows(db,"DELETE FROM sessions WHERE sid=$1",old));cookie(r,"",0);r.send(204,null);return;
        }
        boolean register=r.is("POST","/api/auth/register");
        if(!register&&!r.is("POST","/api/auth/login"))throw new Api(404,"not_found","Адрес не найден.");
        var b=r.body();if(register)fields(b,"email","password","displayName");else fields(b,"email","password");
        String email=str(b,"email",1,254).strip().toLowerCase(Locale.ROOT),password=str(b,"password",register?8:1,128);
        if(!email.matches("[^\\s@]+@[^\\s@]+\\.[^\\s@]+"))throw invalid("Введите действительный email.");
        String name=register?str(b,"displayName",1,80).strip():null;
        if(register&&name.isEmpty())throw invalid("Введите имя.");
        JsonObject user=pg.tx(db->{
            JsonObject u;
            if(register){
                var salt=token(16);String encoded="scrypt-v1$"+salt+"$"+HexFormat.of().formatHex(hash(password,salt));
                u=one(db,"INSERT INTO users(email,password_hash,display_name) VALUES ($1,$2,$3) ON CONFLICT(lower(email)) DO NOTHING RETURNING "+PUBLIC,email,encoded,name);
                if(u==null)throw new Api(409,"email_taken","Этот email уже зарегистрирован.");
            }else{
                u=one(db,"SELECT password_hash,"+PUBLIC+" FROM users WHERE lower(email)=$1",email);
                var parts=Objects.toString(val(u,"password_hash"),"").split("\\$",-1);
                var actual=hash(password,parts.length==3?parts[1]:"missing-account");
                if(parts.length!=3||!parts[0].equals("scrypt-v1")||!parts[2].matches("[a-fA-F0-9]{128}")||
                    !MessageDigest.isEqual(actual,HexFormat.of().parseHex(parts[2])))throw new Api(401,"bad_credentials","Неверный email или пароль.");
                u.remove("password_hash");
            }
            u.addProperty("_cookie",persist(db,old,obj("userId",u.get("id"))));return u;
        });
        cookie(r,user.remove("_cookie").getAsString(),604800);r.send(register?201:200,user);
    }
}
