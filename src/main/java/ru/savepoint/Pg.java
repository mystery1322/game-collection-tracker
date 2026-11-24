package ru.savepoint;

import com.google.gson.*;
import java.sql.*;
import java.util.Map;
import java.util.regex.Pattern;
import org.postgresql.util.PGobject;

final class Pg {
    private final String url, user, password;
    Pg(Map<String,String> settings) {
        url = "jdbc:postgresql://" + settings.getOrDefault("PGHOST","127.0.0.1") + ":" +
            settings.getOrDefault("PGPORT","5432") + "/" + settings.getOrDefault("PGDATABASE","game_collection") +
            ("verify-full".equals(settings.get("PGSSLMODE")) ? "?sslmode=verify-full&sslfactory=org.postgresql.ssl.DefaultJavaSSLFactory" : "");
        user = settings.getOrDefault("PGUSER","game_collection_app");
        password = settings.get("PGPASSWORD");
    }
    interface Work<T> { T run(Connection db) throws Exception; }
    <T> T tx(Work<T> work) throws Exception {
        try (var db = DriverManager.getConnection(url,user,password)) {
            db.setAutoCommit(false);
            try { T result = work.run(db); db.commit(); return result; }
            catch (Exception e) { db.rollback(); throw e; }
        }
    }
    // PostgreSQL's numbered parameters may occur more than once in a query.
    private static final Pattern PARAMETERS = Pattern.compile("\\$(\\d+)");
    static JsonArray rows(Connection db, String sql, Object... args) throws SQLException {
        var matcher = PARAMETERS.matcher(sql);
        try (var st = db.prepareStatement(matcher.replaceAll("?"))) {
            matcher.reset();
            int index=1;
            while (matcher.find()) st.setObject(index++, args[Integer.parseInt(matcher.group(1))-1]);
            JsonArray result=new JsonArray();
            if (!st.execute()) return result;
            try (var rs=st.getResultSet()) {
                var meta=rs.getMetaData();
                while (rs.next()) {
                    var row=new JsonObject();
                    for (int i=1;i<=meta.getColumnCount();i++) {
                        Object v=rs.getObject(i);
                        String k=meta.getColumnLabel(i);
                        if (v==null) row.add(k,JsonNull.INSTANCE);
                        else if (v instanceof Number n) row.addProperty(k,n);
                        else if (v instanceof Boolean b) row.addProperty(k,b);
                        else if (v instanceof Timestamp t) row.addProperty(k,t.toInstant().toString());
                        else if (v instanceof PGobject p && ("json".equals(p.getType())||"jsonb".equals(p.getType()))) row.add(k,JsonParser.parseString(p.getValue()));
                        else row.addProperty(k,v.toString());
                    }
                    result.add(row);
                }
            }
            return result;
        }
    }
    static JsonObject one(Connection db,String sql,Object... args) throws SQLException {
        var out=rows(db,sql,args);
        return out.isEmpty()?null:out.get(0).getAsJsonObject();
    }
}
