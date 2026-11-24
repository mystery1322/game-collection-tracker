package ru.savepoint;

import com.google.gson.*;
import java.math.BigDecimal;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

final class Api extends RuntimeException {
    final int status;
    final String code;
    Api(int status,String code,String message){super(message);this.status=status;this.code=code;}
    static Api invalid(String m){return new Api(400,"invalid_input",m);}
    static Api missing(){return new Api(404,"entry_missing","Игра не найдена в вашей коллекции.");}
    static Api login(){return new Api(401,"login_required","Сначала войдите в аккаунт.");}
    static final Gson JSON=new GsonBuilder().serializeNulls().create();
    static JsonObject obj(Object... pairs){
        var o=new JsonObject();
        for(int i=0;i<pairs.length;i+=2) o.add((String)pairs[i],JSON.toJsonTree(pairs[i+1]));
        return o;
    }
    static String str(JsonObject o,String k,int min,int max){
        var e=o.get(k);
        if(e==null||!e.isJsonPrimitive()||!e.getAsJsonPrimitive().isString()) throw invalid("Проверьте поле "+k+".");
        var s=e.getAsString(); int len=s.codePointCount(0,s.length());
        if(len<min||len>max||s.indexOf(0)>=0||s.codePoints().anyMatch(c->c>=0xd800&&c<=0xdfff)) throw invalid("Проверьте поле "+k+".");
        return s;
    }
    static int integer(JsonObject o,String k,int min,int max){
        var e=o.get(k);
        if(e==null||!e.isJsonPrimitive()||!e.getAsJsonPrimitive().isNumber()) throw invalid("Проверьте поле "+k+".");
        try{int n=new BigDecimal(e.getAsString()).intValueExact();if(n>=min&&n<=max)return n;}catch(ArithmeticException|NumberFormatException ignored){}
        throw invalid("Проверьте поле "+k+".");
    }
    static void fields(JsonObject o,String... names){
        if(!Set.of(names).containsAll(o.keySet()))throw invalid("В запросе есть неизвестное поле.");
    }
    static String val(JsonObject o,String k){return o==null||!o.has(k)||o.get(k).isJsonNull()?null:o.get(k).getAsString();}
    static int positive(String s,int max){
        try {if(s.matches("[1-9][0-9]{0,9}")){int n=Integer.parseInt(s);if(n<=max)return n;}}catch(NumberFormatException ignored){}
        throw invalid("Некорректный номер.");
    }
    static String enc(String s){return URLEncoder.encode(s,StandardCharsets.UTF_8);}
    static Map<String,String> query(String raw){
        Map<String,String> q=new LinkedHashMap<>();
        if(raw!=null&&!raw.isEmpty())for(String p:raw.split("&")){
            var t=p.split("=",2);
            try{String k=URLDecoder.decode(t[0],StandardCharsets.UTF_8),v=t.length>1?URLDecoder.decode(t[1],StandardCharsets.UTF_8):"";
                if(q.putIfAbsent(k,v)!=null)throw invalid("Повторяющийся параметр.");}catch(IllegalArgumentException e){throw invalid("Некорректный параметр.");}
        }
        return q;
    }
}
