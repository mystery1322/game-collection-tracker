package ru.savepoint;

import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.Map;

final class CloudDatabase {
    private static String decode(String value) {
        return URLDecoder.decode(value.replace("+","%2B"),StandardCharsets.UTF_8);
    }
    static void configure(Map<String,String> env) throws Exception {
        URI uri;
        try { uri=URI.create(env.get("NEON_DATABASE_URL")); }
        catch(IllegalArgumentException e){throw new IllegalArgumentException("Проверьте строку подключения Neon.");}
        if(!"postgresql".equals(uri.getScheme()) || uri.getHost()==null ||
            !"/game_collection".equals(uri.getPath()) || uri.getRawUserInfo()==null)
            throw new IllegalArgumentException("Нужна отдельная база game_collection в Neon.");
        String[] auth=uri.getRawUserInfo().split(":",2);
        if(auth.length!=2)throw new IllegalArgumentException("В настройках базы отсутствует пароль.");
        env.put("PGHOST",uri.getHost());env.put("PGPORT",Integer.toString(uri.getPort()<0?5432:uri.getPort()));
        env.put("PGDATABASE","game_collection");env.put("PGUSER",decode(auth[0]));env.put("PGPASSWORD",decode(auth[1]));
        env.put("PGSSLMODE","verify-full");
        migrate(new Pg(env));
    }
    static void migrate(Pg pg) throws Exception {
        try(var files=Files.list(Path.of("db","migrations"))){
            var migrations=files.filter(p->p.getFileName().toString().matches("[0-9]{3}_.*[.]sql")).sorted().toList();
            pg.tx(db->{
                Pg.rows(db,"SELECT pg_advisory_xact_lock(493810621)");
                Pg.rows(db,"CREATE TABLE IF NOT EXISTS savepoint_migrations(name text PRIMARY KEY)");
                for(var file:migrations){
                    String name=file.getFileName().toString();
                    if(Pg.one(db,"SELECT name FROM savepoint_migrations WHERE name=$1",name)!=null)continue;
                    String sql=Files.readString(file).replaceFirst("(?m)^BEGIN;[ \t]*$","").replaceFirst("(?m)^COMMIT;[ \t]*$","");
                    try(var st=db.createStatement()){st.execute(sql);}
                    Pg.rows(db,"INSERT INTO savepoint_migrations(name) VALUES($1)",name);
                }
                return null;
            });
        }
    }
}
