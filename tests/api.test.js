import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/app.js';
import { steamLibrary } from '../src/integrations/steam.js';
import { testDatabase } from './pg-fixture.js';

test('HTTP API и PostgreSQL 18', async t => {
  const pool = await testDatabase(t);
  let library = [{ appid: 10, name: 'Test Steam Game', playtime_forever: 80 }];
  let mode = 'ok';
  let releaseImport, fetchStarted;
  const readSteam = steamLibrary('test-only', async (url, options) => {
    assert.equal(JSON.parse(url.searchParams.get('input_json')).steamid, '76561198000000000');
    assert.equal(options.headers['x-webapi-key'], 'test-only');
    if (mode === 'timeout') throw new DOMException('timeout','TimeoutError');
    if (mode === 'private') return Response.json({ response: {} });
    if (mode === 'wait') {
      fetchStarted();
      await new Promise(resolve => { releaseImport = resolve; });
    }
    return Response.json({ response: { game_count: library.length, games: library } });
  });
  async function getLibrary(id) {
    const rows = await readSteam(id);
    // Simulate a persistence failure after the external response has been validated.
    if (mode === 'bad_write') rows.push({ appid: 20, title: 'Rollback', minutes: -1, icon: null });
    return rows;
  }
  const { app, store } = createApp({pool,secret:randomBytes(32).toString('hex'),origin:'http://localhost:3000',getLibrary});
  const server = app.listen(0,'127.0.0.1');
  await once(server,'listening');
  const base = 'http://127.0.0.1:' + server.address().port + '/api';
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
      delete library[1].rtime_last_played;
      await ageRun();
      await a('POST','/steam/sync',200);
      const recent=await a('GET','/collection?sort=recent&pageSize=1',200);
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
    await new Promise(resolve=>server.close(resolve));
    await store.close();
    await pool.end();
  }
});
