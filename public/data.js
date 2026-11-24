import demoAchievements from './demo-achievements.js';

export const demo = location.hostname.endsWith('.github.io') || new URLSearchParams(location.search).get('demo') === '1';
export const statuses = { unassigned:'Без статуса', planned:'Планирую', playing:'Играю', completed:'Пройдена', paused:'Отложена', dropped:'Брошена' };
const key = 'savepoint.game-collection.demo.v1';
// Fixed sample activity, including on browsers that already have a saved demo collection.
const demoActivity = {
  '367520': '2026-11-19T18:30:00Z', '504230': '2026-11-17T16:00:00Z',
  '1145360': '2026-11-12T19:00:00Z', '632470': '2026-10-28T15:00:00Z',
  '620': '2026-09-12T10:00:00Z'
};
const examples = [
  ['Celeste','504230','playing',425,9,'Начать главу 4 с последнего костра.'],
  ['Disco Elysium','632470','paused',790,9,'Поговорить с Кимом на балконе.'],
  ['Hades','1145360','playing',980,10,'Взять щит и попробовать новый аспект.'],
  ['Hollow Knight','367520','playing',1130,10,'Вернуться к картографу в Городе слёз.'],
  ['Outer Wilds','753640','planned',0,null,''],
  ['A Short Hike','1055540','planned',0,null,''],
  ['Chants of Sennaar','1931770','planned',0,null,''],
  ['Portal 2','620','completed',530,9,'']
];
function readGames() {
  const raw = localStorage.getItem(key);
  const games = raw !== null ? JSON.parse(raw) : examples.map(([title,steamAppId,status,playtimeMinutes,rating,nextStep],i)=>({
    id:i+1,title,steamAppId,status,playtimeMinutes,rating,nextStep,notes:'',completedAt:null
  }));
  return games.map(game=>({...game,lastPlayedAt:game.lastPlayedAt ?? demoActivity[game.steamAppId] ?? null}));
}
async function api(path, method='GET', body) {
  const options = { method, credentials:'same-origin' };
  if (body !== undefined) {
    options.headers = { 'Content-Type':'application/json' };
    options.body = JSON.stringify(body);
  }
  const response = await fetch('/api'+path, options);
  if (response.status === 204) return;
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error?.message || 'Ошибка запроса к серверу.');
    error.status = response.status;
    throw error;
  }
  return data;
}
export const me = () => demo ? Promise.resolve({displayName:'Демо'}) : api('/auth/me');
export const auth = (register,body) => api('/auth/'+(register?'register':'login'),'POST',body);
export const logout = () => api('/auth/logout','POST');
export const saveSource = steamId => api('/steam/source','PUT',{steamId});
export const importSteam = () => api('/steam/sync','POST');
export function hasAchievements(game) {
  return Boolean(game?.steamAppId && (!demo || demoAchievements[game.steamAppId]));
}
export async function achievements(game, summary=false) {
  if (!demo) return api('/collection/'+game.id+'/achievements'+(summary?'?view=summary':''));
  const items=demoAchievements[game.steamAppId] ?? [];
  if (!summary) return [...items];
  const unlocked=items.filter(item=>item.unlocked).length;
  return {total:items.length,unlocked,perfect:items.length>0 && unlocked===items.length};
}
export function neverPlayed(game) {
  return Boolean(game.steamAppId) && game.playtimeMinutes === 0 && !game.lastPlayedAt;
}
export async function list({q,status,sort,page,pageSize,unplayed}) {
  if (!demo) {
    const params = new URLSearchParams({q,sort,page,pageSize});
    if(status) params.set('status',status);
    if(unplayed) params.set('unplayed','true');
    return api('/collection?'+params);
  }
  const matches = readGames().filter(g=>(!status || g.status===status) && (!unplayed || neverPlayed(g)) &&
    g.title.toLowerCase().includes(q.toLowerCase()));
  const compare = {
    title: (a,b)=>a.title.localeCompare(b.title,'ru'),
    time: (a,b)=>b.playtimeMinutes-a.playtimeMinutes,
    rating: (a,b)=>(b.rating??0)-(a.rating??0),
    recent: (a,b)=>new Date(b.lastPlayedAt)-new Date(a.lastPlayedAt)
  };
  matches.sort((a,b)=>compare[sort](a,b) || a.id-b.id);
  return {items:matches.slice((page-1)*pageSize,page*pageSize),total:matches.length};
}
export async function queue() {
  if (!demo) return api('/queue');
  return readGames().filter(g=>g.status==='planned').sort((a,b)=>(a.queueRank??a.id)-(b.queueRank??b.id));
}
export async function moveQueue(id,direction) {
  if (!demo) return api('/queue/'+id,'PATCH',{direction});
  const games=readGames();
  const ordered=games.filter(g=>g.status==='planned').sort((a,b)=>(a.queueRank??a.id)-(b.queueRank??b.id));
  const i=ordered.findIndex(g=>g.id===id);
  const neighbour=ordered[i+(direction==='up'?-1:1)];
  if (i<0 || !neighbour) return;
  const game=ordered[i];
  [game.queueRank,neighbour.queueRank]=[neighbour.queueRank??neighbour.id,game.queueRank??game.id];
  localStorage.setItem(key,JSON.stringify(games));
}
export async function randomGame(filters) {
  const query={...filters,page:1,pageSize:1};
  const first=await list(query);
  if (!first.total) return null;
  const page=1+Math.floor(Math.random()*first.total);
  if(page===1) return first.items[0];
  return (await list({...query,page})).items[0]??null;
}
export async function stats() {
  if (!demo) return api('/statistics');
  const games = readGames();
  const byStatus = Object.fromEntries(Object.keys(statuses).map(k=>[k,games.filter(g=>g.status===k).length]));
  const rated = games.filter(g=>g.rating!==null);
  return {hasSteamImport:true,totalGames:games.length,byStatus,totalPlaytimeMinutes:games.reduce((n,g)=>n+g.playtimeMinutes,0),
    completionPercent:games.length ? byStatus.completed*100/games.length : 0,
    averageRating:rated.length ? rated.reduce((n,g)=>n+g.rating,0)/rated.length : null,
    topGames:games.filter(g=>g.playtimeMinutes>0).sort((a,b)=>b.playtimeMinutes-a.playtimeMinutes).slice(0,5)};
}
export async function save(id,values) {
  if (!demo) return api('/collection'+(id?'/'+id:''),id?'PATCH':'POST',values);
  const games = readGames();
  const current = id ? games.find(g=>g.id===id) : {id:Math.max(0,...games.map(g=>g.id))+1,steamAppId:null};
  if (!current) throw Error('Игра удалена. Обновите коллекцию.');
  Object.assign(current,values);
  if (current.status!=='completed') current.completedAt=null;
  if (!id) games.push(current);
  localStorage.setItem(key,JSON.stringify(games));
}
export async function remove(id) {
  if (!demo) return api('/collection/'+id,'DELETE');
  localStorage.setItem(key,JSON.stringify(readGames().filter(g=>g.id!==id)));
}
