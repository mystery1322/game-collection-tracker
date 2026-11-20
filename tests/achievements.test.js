import test from 'node:test';
import assert from 'node:assert/strict';
import { steamAchievements } from '../src/integrations/achievements.js';

test('бриллиант требует хотя бы одного достижения и полного прогресса', async () => {
  const achievements=[];
  const get=steamAchievements('test',async ()=>Response.json({
    playerstats:{steamID:'player',success:true,achievements}
  }));
  assert.deepEqual(await get('player','10',true),{total:0,unlocked:0,perfect:false});
  achievements.push({apiname:'first',achieved:0});
  assert.deepEqual(await get('player','10',true),{total:1,unlocked:0,perfect:false});
  achievements[0].achieved=1;
  assert.deepEqual(await get('player','10',true),{total:1,unlocked:1,perfect:true});
  achievements.push({apiname:'second',achieved:0});
  assert.deepEqual(await get('player','10',true),{total:2,unlocked:1,perfect:false});
});

test('значок и глобальная доля сопоставляются по идентификатору достижения', async () => {
  const get=steamAchievements('test',async url=>{
    if (url.pathname.includes('GetSchema')) return Response.json({game:{availableGameStats:{achievements:[
      {name:'b',icon:'b.jpg'},{name:'a',icon:'a.jpg'}
    ]}}});
    if (url.pathname.includes('GetGlobal')) return Response.json({achievementpercentages:{achievements:[{name:'b',percent:'0'}]}});
    return Response.json({playerstats:{steamID:'player',success:true,achievements:[
      {apiname:'a',achieved:1},{apiname:'b',achieved:0}
    ]}});
  });
  const rows=await get('player','10');
  assert.deepEqual(rows.map(a=>[a.icon,a.globalPercent]),[['a.jpg',null],['b.jpg',0]]);
});
