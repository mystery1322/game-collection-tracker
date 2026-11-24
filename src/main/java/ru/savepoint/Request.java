package ru.savepoint;

import com.google.gson.*;
import com.sun.net.httpserver.HttpExchange;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import static ru.savepoint.Api.*;

final class Request {
    final HttpExchange x;
    final String method,path;
    final Map<String,String> q;
    Request(HttpExchange x){
        this.x=x;method=x.getRequestMethod();path=x.getRequestURI().getPath();q=query(x.getRequestURI().getRawQuery());
    }
    String header(String name){return x.getRequestHeaders().getFirst(name);}
    boolean is(String verb,String route){return method.equals(verb)&&path.equals(route);}
    void checkOrigin(String origin){
        if(Set.of("GET","HEAD","OPTIONS").contains(method))return;
        if(header("Origin")!=null&&!origin.equals(header("Origin"))||"cross-site".equals(header("Sec-Fetch-Site")))
            throw new Api(403,"origin_denied","Запрос с другого сайта запрещён.");
        if((header("Transfer-Encoding")!=null||header("Content-Length")!=null&&!header("Content-Length").equals("0"))&&
           !"application/json".equalsIgnoreCase(Objects.toString(header("Content-Type"),"").split(";",2)[0].trim()))
            throw new Api(415,"json_required","Передайте данные в формате JSON.");
    }
    JsonObject body() throws IOException{
        byte[] b=x.getRequestBody().readNBytes(32769);
        if(b.length>32768)throw new Api(413,"body_too_large","Слишком большой запрос.");
        try{var j=JSON.fromJson(new String(b,StandardCharsets.UTF_8),JsonElement.class);
            if(j==null||!j.isJsonObject())throw invalid("Передайте объект JSON.");return j.getAsJsonObject();}
        catch(JsonParseException e){throw new Api(400,"invalid_json","Не удалось прочитать JSON.");}
    }
    void send(int status,Object value)throws IOException{
        if(value==null){x.sendResponseHeaders(status,-1);return;}
        var bytes=JSON.toJson(value).getBytes(StandardCharsets.UTF_8);
        x.getResponseHeaders().set("Content-Type","application/json; charset=utf-8");
        x.sendResponseHeaders(status,bytes.length);x.getResponseBody().write(bytes);
    }
    void redirect(String url)throws IOException{x.getResponseHeaders().set("Location",url);send(302,null);}
}
