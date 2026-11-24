import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { startJava } from './java-server.js';
import {createHmac,randomBytes,scryptSync} from 'node:crypto';
import { testDatabase } from './pg-fixture.js';

test('Java HTTP API и PostgreSQL 18', async t => {
  const pool = await testDatabase(t);
  let library = [{ appid: 10, name: 'Test Steam Game', playtime_forever: 80 }];
  let mode = 'ok';
  let releaseImport, fetchStarted;
  let providerAccepts=true;
  let achievements=[{apiname:'first',name:'Начало',achieved:0}];
  const steam=createServer(async (req,res)=>{
    const url=new URL(req.url,'http://localhost');
    const json=value=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(value));};
    if(url.pathname==='/openid'){
      let body=''; for await(const part of req) body+=part;
      assert.equal(new URLSearchParams(body).get('openid.mode'),'check_authentication');
      res.end('is_valid:'+providerAccepts+'\n'); return;
    }
    if(url.pathname.includes('GetOwnedGames')){
      const params=JSON.parse(url.searchParams.get('input_json'));
      assert.equal(params.steamid,'76561198000000000');
      assert.equal(params.skip_unvetted_apps,false);
      assert.equal(req.headers['x-webapi-key'],'test-only');
      if(mode==='timeout')return;
      if(mode==='private')return json({response:{}});
      if(mode==='wait'){fetchStarted();await new Promise(resolve=>{releaseImport=resolve;});}
      return json({response:{game_count:library.length,games:library}});
    }
    if(url.pathname.includes('GetPlayerAchievements'))return json({playerstats:{success:true,steamID:'76561198000000000',achievements}});
    if(url.pathname.includes('GetSchemaForGame'))return json({game:{availableGameStats:{achievements:[{name:'second',icon:'b.jpg'},{name:'first',icon:'a.jpg'}]}}});
    if(url.pathname.includes('GetGlobalAchievement'))return json({achievementpercentages:{achievements:[{name:'second',percent:'0'}]}});
    res.writeHead(404).end();
  });
  steam.listen(0,'127.0.0.1');await once(steam,'listening');
  const secret=randomBytes(32).toString('hex');
  const server=await startJava(pool,steam.address().port,secret);
  const base=server.url+'/api';
  function client() {
    let cookie = '';
    return async (method, route, status, body, headers) => {
      const response = await fetch(base+route,{method,headers:{'content-type':'application/json',cookie,...headers},
        body:body === undefined ? undefined : JSON.stringify(body)});
      const raw = await response.text();
      assert.equal(response.status,status,method+' '+route+' '+raw);
      if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      return raw ? JSON.parse(raw) : null;
    };
  }
  const a = client(), b = client();
  const first = {displayName:'Игрок А',email:'a@example.invalid',password:'test-password-a'};
  let userId, manualId, steamEntry;
  const ageRun = () => pool.query("UPDATE steam_sync_runs SET started_at=started_at-interval '2 minutes' WHERE user_id=$1", [userId]);
  try {
    await t.test('пароль и действующий сеанс прежнего сервера открывают тот же аккаунт',async()=>{
      const salt=randomBytes(16).toString('hex'),password='compatibility-test';
      const hash=scryptSync(password,salt,64,{N:32768,r:8,p:3,maxmem:64*1024*1024}).toString('hex');
      const email='previous@example.invalid';
      const {rows:[u]}=await pool.query('INSERT INTO users(email,password_hash,display_name) VALUES ($1,$2,$3) RETURNING id',[email,['scrypt-v1',salt,hash].join('$'),'Прежний аккаунт']);
      const sid=randomBytes(24).toString('base64url');
      const signature=createHmac('sha256',secret).update(sid).digest('base64').replace(/=+$/,'');
      await pool.query("INSERT INTO sessions(sid,sess,expire) VALUES ($1,$2,now()+interval '1 day')",[sid,JSON.stringify({userId:u.id})]);
      const me=await fetch(base+'/auth/me',{headers:{cookie:'collection.sid='+encodeURIComponent('s:'+sid+'.'+signature)}});
      assert.equal(me.status,200);assert.equal((await me.json()).id,u.id);
      const previous=client();
      assert.equal((await previous('POST','/auth/login',200,{email,password})).id,u.id);
    });
    await t.test('регистрация, сессия, повторный email и запрещённый источник запроса', async () => {
      await a('GET','/health',200);
      await a('GET','/collection',401);
      await a('POST','/auth/register',403,first,{origin:'https://example.invalid'});
      userId = (await a('POST','/auth/register',201,first)).id;
      assert.equal((await a('GET','/auth/me',200)).id,userId);
      await b('POST','/auth/register',409,{...first,email:'A@example.invalid'});
      await b('POST','/auth/register',201,{...first,email:'b@example.invalid'});
    });
    await t.test('выход и повторный вход', async () => {
      await a('POST','/auth/logout',204);
      await a('GET','/auth/me',401);
      await a('POST','/auth/login',401,{email:first.email,password:'wrong'});
      await a('POST','/auth/login',200,{email:first.email,password:first.password});
    });
    await t.test('пустая статистика, создание игры и проверка полей', async () => {
      const empty = await a('GET','/statistics',200);
      assert.equal(empty.averageRating,null);
      assert.equal(empty.completionPercent,0);
      await a('POST','/collection',400,{title:'Ошибочная',status:'completed',completedAt:'2999-01-01'});
      assert.equal((await a('GET','/collection',200)).total,0);
      assert.equal((await pool.query('SELECT id FROM games WHERE created_by=$1',[userId])).rowCount,0);
      manualId = (await a('POST','/collection',201,{title:'Ручная игра',playtimeMinutes:120})).id;
      await a('PATCH','/collection/'+manualId,400,{rating:11});
      await a('PATCH','/collection/'+manualId,200,{status:'completed',completedAt:'2020-01-01',rating:8,notes:'Финал'});
      const stats = await a('GET','/statistics',200);
      assert.equal(stats.completionPercent,100);
      assert.equal(stats.averageRating,8);
      assert.equal(stats.byStatus.completed,1);
      assert.equal(stats.totalPlaytimeMinutes,120);
      assert.equal(stats.topGames[0].id,manualId);
    });
    await t.test('изоляция двух пользователей, поиск и страницы', async () => {
      assert.equal((await b('GET','/collection',200)).total,0);
      for (const method of ['GET','PATCH','DELETE']) await b(method,'/collection/'+manualId,404,method==='PATCH'?{rating:5}:undefined);
      assert.equal((await a('GET','/collection?q='+encodeURIComponent('игра')+'&status=completed&sort=rating',200)).total,1);
      const page = await a('GET','/collection?page=2&pageSize=1',200);
      assert.deepEqual(page.items,[]);
      assert.equal(page.total,1);
    });
    await t.test('следующий шаг виден после повторного входа и завершается отдельно от заметки', async () => {
      await a('PATCH','/collection/'+manualId,200,{nextStep:'Слот 3 у лифта'});
      await a('POST','/auth/logout',204);
      await a('POST','/auth/login',200,{email:first.email,password:first.password});
      assert.equal((await a('GET','/collection',200)).items[0].nextStep,'Слот 3 у лифта');
      await b('PATCH','/collection/'+manualId,404,{nextStep:''});
      const cleared = await a('PATCH','/collection/'+manualId,200,{nextStep:''});
      assert.deepEqual([cleared.nextStep,cleared.notes,cleared.status],['','Финал','completed']);
    });
    await t.test('первый импорт, ограничение частоты и закрепление источника', async () => {
      await a('POST','/steam/sync',400);
      await a('PUT','/steam/source',400,{steamId:'123'});
      await a('PUT','/steam/source',200,{steamId:'76561198000000000'});
      assert.equal((await a('POST','/steam/sync',200)).addedCount,1);
      await a('POST','/steam/sync',429);
      await a('PUT','/steam/source',409,{steamId:'76561198000000001'});
      steamEntry = (await a('GET','/collection?q=Steam',200)).items[0].id;
      await a('PATCH','/collection/'+steamEntry,400,{playtimeMinutes:1});
      await a('PATCH','/collection/'+steamEntry,200,{status:'playing',rating:9,notes:'Моя заметка'});
    });
    await t.test('достижения доступны владельцу записи Steam', async () => {
      const path='/collection/'+steamEntry+'/achievements';
      assert.equal((await a('GET',path,200))[0].name,'Начало');
      await b('GET',path,404);
      await a('GET','/collection/'+manualId+'/achievements',400);
    });
    await t.test('краткий прогресс и значки достижений Java',async()=>{
      const path='/collection/'+steamEntry+'/achievements';
      achievements=[];
      assert.deepEqual(await a('GET',path+'?view=summary',200),{total:0,unlocked:0,perfect:false});
      achievements=[{apiname:'first',achieved:1}];
      assert.deepEqual(await a('GET',path+'?view=summary',200),{total:1,unlocked:1,perfect:true});
      achievements.push({apiname:'second',achieved:0});
      assert.deepEqual(await a('GET',path+'?view=summary',200),{total:2,unlocked:1,perfect:false});
      assert.deepEqual((await a('GET',path,200)).map(x=>[x.icon,x.globalPercent]),[['a.jpg',null],['b.jpg',0]]);
    });
    await t.test('обе страницы клиентского представления открываются напрямую',async()=>{
      for(const path of ['/collection','/statistics']){
        const r=await fetch(server.url+path);assert.equal(r.status,200);
        assert.match(await r.text(),/Savepoint/);
      }
    });
    await t.test('повторный импорт обновляет минуты и сохраняет личные поля', async () => {
      await ageRun();
      library[0].playtime_forever = 150;
      const sync = await a('POST','/steam/sync',200);
      assert.equal(sync.addedCount,0);
      assert.equal(sync.updatedCount,1);
      const game = await a('GET','/collection/'+steamEntry,200);
      assert.deepEqual([game.status,game.rating,game.notes,game.playtimeMinutes],['playing',9,'Моя заметка',150]);
      const stats = await a('GET','/statistics',200);
      assert.deepEqual([stats.totalGames,stats.averageRating,stats.completionPercent,stats.totalPlaytimeMinutes],[2,8.5,50,270]);
    });
    await t.test('неполные данные, тайм-аут и пустой список сохраняют коллекцию', async () => {
      for (const [nextMode,status] of [['private',502],['timeout',504]]) {
        await ageRun();
        mode = nextMode;
        await a('POST','/steam/sync',status);
        const state = await a('GET','/steam/sync-status',200);
        assert.equal(state.latest.status,'failed');
        assert.ok(state.lastSuccessAt);
      }
      await ageRun();
      mode = 'ok';
      library = [];
      assert.equal((await a('POST','/steam/sync',200)).addedCount,0);
      assert.equal((await a('GET','/collection',200)).total,2);
    });
    await t.test('ошибка записи откатывает каталог, время и результат попытки', async () => {
      await ageRun();
      mode = 'bad_write';
      library = [{ appid: 10, name: 'Rollback title', playtime_forever: 500 }];
      await a('POST','/steam/sync',500);
      const stored = await a('GET','/collection/'+steamEntry,200);
      assert.equal(stored.playtimeMinutes,150);
      assert.equal(stored.title,'Test Steam Game');
      assert.equal((await pool.query('SELECT id FROM games WHERE steam_app_id=20')).rowCount,0);
      assert.equal((await a('GET','/steam/sync-status',200)).latest.errorCode,'sync_failed');
    });
    await t.test('одновременные импорты одного пользователя', async () => {
      await ageRun();
      mode = 'wait';
      library = [];
      const started = new Promise(resolve => { fetchStarted = resolve; });
      const pending = a('POST','/steam/sync',200);
      await started;
      try {
        assert.equal((await a('POST','/steam/sync',409)).error.code,'sync_running');
      } finally {
        releaseImport();
        await pending;
      }
    });
    await t.test('смена статуса, удаление и пересчёт', async () => {
      assert.equal((await a('PATCH','/collection/'+manualId,200,{status:'paused'})).completedAt,null);
      await a('DELETE','/collection/'+manualId,204);
      await a('GET','/collection/'+manualId,404);
      assert.equal((await a('GET','/statistics',200)).totalPlaytimeMinutes,150);
    });
    await t.test('вход Steam открывает собственную коллекцию после ответа провайдера', async ()=>{
      const steamId='76561198000000000';
      async function login() {
        const start=await fetch(base+'/auth/steam',{redirect:'manual'});
        assert.equal(start.status,302);
        const cookie=start.headers.get('set-cookie').split(';')[0];
        const provider=new URL(start.headers.get('location'));
        assert.equal(provider.origin,'https://steamcommunity.com');
        const callback=new URL(provider.searchParams.get('openid.return_to'));
        for(const [name,value] of Object.entries({
          ns:provider.searchParams.get('openid.ns'),mode:'id_res',op_endpoint:provider.origin+provider.pathname,
          claimed_id:'https://steamcommunity.com/openid/id/'+steamId,identity:'https://steamcommunity.com/openid/id/'+steamId,
          return_to:callback.href, response_nonce:new Date().toISOString().slice(0,19)+'Zexample',
          assoc_handle:'test-association',sig:'test-only',signed:'op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle'
        })) callback.searchParams.set('openid.'+name,value);
        const reply=await fetch(base+'/auth/steam/callback'+callback.search,{redirect:'manual',headers:{cookie}});
        assert.equal(reply.status,302);
        return reply;
      }
      providerAccepts=false;
      assert.equal((await login()).headers.get('location'),'/?steamLogin=steam_login_failed');
      providerAccepts=true;
      let previousId;
      for(let visit=0;visit<2;visit++){
        const reply=await login();
        assert.equal(reply.headers.get('location'),'/?steamImport=1#collection');
        const headers={cookie:reply.headers.get('set-cookie').split(';')[0]};
        const account=await (await fetch(base+'/auth/me',{headers})).json();
        assert.equal(account.steamId,steamId);
        assert.notEqual(account.id,userId);
        assert.equal(account.email,null);
        if(visit) assert.equal(account.id,previousId);
        previousId=account.id;
        assert.equal((await (await fetch(base+'/collection',{headers})).json()).total,0);
      }
    });
    await t.test('недавние игры упорядочены по последнему запуску текущего пользователя', async () => {
      mode='ok';
      library=[
        {appid:10,name:'Долгая игра',playtime_forever:900,rtime_last_played:1700000000},
        {appid:21,name:'Короткая игра',playtime_forever:5,rtime_last_played:1710000000},
        {appid:22,name:'Без даты',playtime_forever:15,rtime_last_played:0}
      ];
      const manual=await a('POST','/collection',201,{title:'Игра вручную'});
      await ageRun();
      await a('POST','/steam/sync',200);
      assert.equal((await a('GET','/statistics',200)).hasSteamImport,true);
      assert.equal((await b('GET','/statistics',200)).hasSteamImport,false);
      const ordered=await a('GET','/collection?sort=recent',200);
      assert.deepEqual(ordered.items.map(g=>g.title),['Короткая игра','Долгая игра',manual.title,'Без даты']);
      assert.equal(ordered.items[2].lastPlayedAt,null);
      assert.equal(ordered.items[3].lastPlayedAt,null);
      library[0].rtime_last_played=1720000000;
      library.push({appid:23,name:'Первый запуск впереди',playtime_forever:0});
      library.push({appid:24,name:'Короткий запуск',playtime_forever:0,rtime_last_played:1600000000});
      delete library[1].rtime_last_played;
      await ageRun();
      await a('POST','/steam/sync',200);
      const recent=await a('GET','/collection?sort=recent&pageSize=1',200);
      const unplayed=await a('GET','/collection?unplayed=true&status=unassigned&pageSize=1',200);
      assert.equal(unplayed.total,1);
      assert.equal(unplayed.items[0].steamAppId,'23');
      assert.equal((await a('GET','/collection?unplayed=true&q=xyz',200)).total,0);
      await a('GET','/collection?unplayed=unknown',400);
      assert.equal(recent.items[0].title,'Долгая игра');
      assert.equal(Date.parse(recent.items[0].lastPlayedAt),1720000000000);
      const next=await a('GET','/collection?sort=recent&pageSize=1&page=2',200);
      assert.equal(Date.parse(next.items[0].lastPlayedAt),1710000000000);
      assert.equal((await a('GET','/collection/'+steamEntry,200)).notes,'Моя заметка');
      await a('PATCH','/collection/'+manual.id,400,{lastPlayedAt:'2020-01-01'});
      library[0].rtime_last_played=1680000000;
      await b('PUT','/steam/source',200,{steamId:'76561198000000000'});
      await b('POST','/steam/sync',200);
      assert.equal(Date.parse((await a('GET','/collection/'+steamEntry,200)).lastPlayedAt),1720000000000);
      assert.equal(Date.parse((await b('GET','/collection?sort=recent',200)).items[0].lastPlayedAt),1680000000000);
    });
  } finally {
    await server.close();
    steam.closeAllConnections();
    await new Promise(resolve=>steam.close(resolve));
    await pool.end();
  }
});
