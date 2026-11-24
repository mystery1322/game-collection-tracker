package ru.savepoint;

import com.google.gson.JsonArray;

// Only available on the test classpath. Provider replies come from a loopback fixture.
public final class TestServer {
    public static void main(String[] args)throws Exception{
        var env=System.getenv();
        String origin="http://127.0.0.1:"+Integer.parseInt(env.get("TEST_STEAM_PORT"));
        var steam=new Steam("test-only",origin,origin+"/openid"){
            @Override JsonArray library(String sid){
                var result=super.library(sid);
                if(!result.isEmpty()&&"Rollback title".equals(Api.val(result.get(0).getAsJsonObject(),"title")))
                    result.add(Api.obj("appid",20,"title","Rollback","minutes",-1,"played_at",null,"icon",null));
                return result;
            }
        };
        var server=new Server(env,steam);
        Runtime.getRuntime().addShutdownHook(new Thread(server::stop));server.http.start();
        System.out.println("READY "+server.http.getAddress().getPort());
        // The test runner signals shutdown by closing the input pipe.
        while(System.in.read()!=-1){}
        server.stop();
    }
}
