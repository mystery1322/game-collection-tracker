package ru.savepoint;

import com.sun.net.httpserver.*;
import java.net.InetSocketAddress;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import org.postgresql.util.PSQLException;
import static ru.savepoint.Api.*;
import static ru.savepoint.Pg.*;

public final class Server {
    private final Pg pg;private final Steam steam;private final Accounts accounts;private final Sync sync;
    private final String origin;
    final HttpServer http;
    private final ExecutorService executor=Executors.newVirtualThreadPerTaskExecutor();
    private final Path assets;
    Server(Map<String,String> env,Steam steam)throws Exception{
        int port=Integer.parseInt(env.getOrDefault("PORT","3000"));origin=env.getOrDefault("APP_ORIGIN","http://localhost:"+port);
        var secret=env.get("SESSION_SECRET");
        if(secret==null||secret.length()<32||env.getOrDefault("PGPASSWORD","").isEmpty())throw new IllegalArgumentException("Проверьте SESSION_SECRET и PGPASSWORD.");
        this.steam=steam;pg=new Pg(env);pg.tx(db->rows(db,"SELECT 1 FROM user_statistics LIMIT 0"));
        accounts=new Accounts(pg,steam,origin,secret);sync=new Sync(pg,steam);assets=Path.of("public").toRealPath();
        http=HttpServer.create(new InetSocketAddress("127.0.0.1",port),64);http.setExecutor(executor);http.createContext("/",this::handle);
    }
    private void handle(HttpExchange x){
        try(x){
            x.getResponseHeaders().set("Cache-Control","no-store");
            try{var r=new Request(x);r.checkOrigin(origin);
                if(r.path.startsWith("/api/"))api(r);else file(r);
            }catch(Exception error){
                Api a;
                if(error instanceof Api detail)a=detail;
                else if(error instanceof PSQLException e && e.getServerErrorMessage()!=null && "user_games_completion_not_future".equals(e.getServerErrorMessage().getConstraint()))
                    a=invalid("Дата завершения не может быть в будущем.");
                else{System.err.println("Ошибка запроса: "+error.getClass().getSimpleName());a=new Api(500,"internal_error","Не удалось выполнить запрос.");}
                byte[] data=JSON.toJson(obj("error",obj("code",a.code,"message",a.getMessage()))).getBytes(java.nio.charset.StandardCharsets.UTF_8);
                x.getResponseHeaders().set("Content-Type","application/json; charset=utf-8");x.sendResponseHeaders(a.status,data.length);x.getResponseBody().write(data);
            }
        }catch(java.io.IOException ignored){/* The client closed its connection. */}
    }
    private void file(Request r)throws Exception{
        if(!Set.of("GET","HEAD").contains(r.method))throw absent();
        String path=Set.of("/","/collection","/statistics").contains(r.path)?"index.html":r.path.substring(1);
        if(path.contains("\\")||path.contains(":")||Arrays.stream(path.split("/")).anyMatch(p->p.startsWith(".")))throw absent();
        Path file=assets.resolve(path).normalize();if(!file.startsWith(assets)||!Files.isRegularFile(file)||!file.toRealPath().startsWith(assets))throw absent();
        var type=path.endsWith(".js")?"text/javascript; charset=utf-8":Files.probeContentType(file);
        if(path.endsWith(".css"))type="text/css; charset=utf-8";if(path.endsWith(".html"))type="text/html; charset=utf-8";
        r.x.getResponseHeaders().set("Content-Type",Objects.toString(type,"application/octet-stream"));
        if(r.method.equals("HEAD")){r.send(200,null);return;}
        r.x.sendResponseHeaders(200,Files.size(file));Files.copy(file,r.x.getResponseBody());
    }
    private static Api absent(){return new Api(404,"not_found","Адрес не найден.");}
    private void api(Request r)throws Exception{
        if(r.is("GET","/api/health")){pg.tx(db->rows(db,"SELECT 1 FROM user_statistics LIMIT 0"));r.send(200,obj("status","ok"));return;}
        if(r.path.startsWith("/api/auth/")){accounts.routes(r);return;}
        int user=accounts.user(r);
        if(r.is("GET","/api/statistics"))r.send(200,pg.tx(db->Library.stats(db,user)));
        else if(r.is("GET","/api/collection"))r.send(200,pg.tx(db->Library.list(db,user,r.q)));
        else if(r.is("POST","/api/collection")){var b=r.body();r.send(201,pg.tx(db->Library.save(db,user,null,b)));}
        else if(r.path.startsWith("/api/collection/")){
            var parts=r.path.substring("/api/collection/".length()).split("/",-1);int id=positive(parts[0],Integer.MAX_VALUE);
            if(parts.length==2&&parts[1].equals("achievements")&&r.method.equals("GET")){
                var s=pg.tx(db->Library.achievementSource(db,user,id));
                r.send(200,steam.achievements(val(s,"steam_id"),val(s,"steam_app_id"),"summary".equals(r.q.get("view"))));
            }else if(parts.length==1)switch(r.method){
                case "GET"->r.send(200,pg.tx(db->Library.entry(db,user,id,false)));
                case "PATCH"->{var b=r.body();r.send(200,pg.tx(db->Library.save(db,user,id,b)));}
                case "DELETE"->{pg.tx(db->{Library.remove(db,user,id);return null;});r.send(204,null);}
                default->throw absent();
            }else throw absent();
        }else if(r.is("PUT","/api/steam/source")){var b=r.body();fields(b,"steamId");r.send(200,sync.source(user,str(b,"steamId",17,17)));}
        else if(r.is("POST","/api/steam/sync"))r.send(200,sync.run(user));
        else if(r.is("GET","/api/steam/sync-status"))r.send(200,sync.status(user));
        else throw absent();
    }
    static Map<String,String> settings()throws Exception{
        var settings=new HashMap<String,String>();Path env=Path.of(".env");
        if(Files.exists(env))for(String line:Files.readAllLines(env)){
            String text=line.strip();if(text.isEmpty()||text.startsWith("#")||!text.contains("="))continue;
            int ix=text.indexOf('=');String value=text.substring(ix+1).strip();
            if(value.length()>=2&&((value.startsWith("\"")&&value.endsWith("\""))||(value.startsWith("'")&&value.endsWith("'"))))value=value.substring(1,value.length()-1);
            settings.put(text.substring(0,ix).strip(),value);
        }
        settings.putAll(System.getenv());return settings;
    }
    void stop(){http.stop(1);executor.shutdown();}
    public static void main(String[] args)throws Exception{
        var env=settings();var server=new Server(env,new Steam(env.get("STEAM_API_KEY")));
        Runtime.getRuntime().addShutdownHook(new Thread(server::stop));server.http.start();
        System.out.println("Savepoint Java — http://127.0.0.1:"+server.http.getAddress().getPort());
    }
}
