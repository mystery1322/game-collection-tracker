export const demo = location.hostname.endsWith('.github.io') || new URLSearchParams(location.search).get('demo') === '1';
export const statuses = { planned:'Планирую', playing:'Играю', completed:'Пройдена', paused:'Отложена', dropped:'Брошена' };
const key = 'savepoint.game-collection.demo.v1';
const examples = [
  ['Celeste','504230','playing',425,9,'Начать главу 4 с последнего костра.'],
  ['Disco Elysium','632470','paused',790,9,'Поговорить с Кимом на балконе.'],
  ['Hades','1145360','playing',980,10,'Взять щит и попробовать новый аспект.'],
  ['Hollow Knight','367520','playing',1130,10,'Вернуться к картографу в Городе слёз.'],
  ['Outer Wilds','753640','planned',0,null,''],
  ['Portal 2','620','completed',530,9,'']
];
function readGames() {
  const raw = localStorage.getItem(key);
  if (raw !== null) return JSON.parse(raw);
  return examples.map(([title,steamAppId,status,playtimeMinutes,rating,nextStep],i)=>({
    id:i+1,title,steamAppId,status,playtimeMinutes,rating,nextStep,notes:'',completedAt:null
  }));
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
export async function list({q,status,sort,page,pageSize}) {
  if (!demo) {
    const params = new URLSearchParams({q,sort,page,pageSize});
    if(status) params.set('status',status);
    return api('/collection?'+params);
  }
  const matches = readGames().filter(g=>(!status || g.status===status) && g.title.toLowerCase().includes(q.toLowerCase()));
  matches.sort((a,b)=>sort==='title' ? a.title.localeCompare(b.title,'ru') :
    (sort==='time' ? b.playtimeMinutes-a.playtimeMinutes : (b.rating??0)-(a.rating??0)) || a.id-b.id);
  return {items:matches.slice((page-1)*pageSize,page*pageSize),total:matches.length};
}
export async function stats() {
  if (!demo) return api('/statistics');
  const games = readGames();
  const byStatus = Object.fromEntries(Object.keys(statuses).map(k=>[k,games.filter(g=>g.status===k).length]));
  const rated = games.filter(g=>g.rating!==null);
  return {totalGames:games.length,byStatus,totalPlaytimeMinutes:games.reduce((n,g)=>n+g.playtimeMinutes,0),
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
