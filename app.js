import * as data from './data.js';

const $ = selector => document.querySelector(selector);
if (!data.demo) {
  for (const link of document.querySelectorAll('nav a, a.brand')) {
    link.href = link.hash === '#statistics' ? '/statistics' : '/collection';
  }
}
const form = $('#edit-form');
const edit = form.elements;
const authForm = $('#auth-form');
const dialog = $('#editor');
const params = {q:'',status:'',unplayed:false,sort:'title',page:1,pageSize:12};
let user, editing, stepOnly, registering=false, request=0, searchTimer;
let preferredSort = null;
const sortKey = ()=>'savepoint.collection.sort.'+(data.demo?'demo':user.id);

function el(tag,text,className) {
  const node=document.createElement(tag);
  if (text != null) node.textContent=text;
  if (className) node.className=className;
  return node;
}
function button(text,action,css) {
  const node=el('button',text,css);
  node.type='button';
  node.addEventListener('click',action);
  return node;
}
function feedback(error) {
  if (error.status===401 && user) {
    user=null;
    dialog.close();
    layout();
    authForm.querySelector('.error').textContent='Войдите снова, чтобы продолжить.';
  } else {
    $('#fatal').textContent=error.message || 'Не удалось загрузить коллекцию.';
  }
}
function hours(minutes) {
  return new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1}).format(minutes/60)+' ч';
}
function today() {
  const date=new Date();
  return [date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-');
}
for (const [code,label] of Object.entries(data.statuses)) {
  $('#filter').add(new Option(label,code));
  edit.status.add(new Option(label,code));
}
function layout() {
  $('#auth').hidden=Boolean(user);
  $('#workspace').hidden=!user;
  $('#navigation').hidden=!user;
  $('#logout').hidden=!user || data.demo;
  $('#steam-open').hidden=!user || data.demo;
  $('#identity').textContent=data.demo?'Демо · в этом браузере':user?.displayName || '';
  $('#identity').classList.toggle('demo',data.demo);
  $('#fatal').textContent='';
  if (user) {
    let stored;
    try { stored=localStorage.getItem(sortKey()); } catch {}
    preferredSort=Array.from($('#sort').options).some(option=>option.value===stored) ? stored : null;
    refresh().catch(feedback);
  }
}
function authLayout() {
  $('#name-label').hidden=!registering;
  authForm.elements.displayName.required=registering;
  authForm.elements.password.minLength=registering?8:1;
  authForm.elements.password.autocomplete=registering?'new-password':'current-password';
  $('#auth-title').textContent=registering?'Регистрация':'Вход';
  $('#auth-submit').textContent=registering?'Создать аккаунт':'Войти';
  $('#auth-toggle').textContent=registering?'Уже есть аккаунт':'Создать аккаунт';
  authForm.querySelector('.error').textContent='';
}
$('#auth-toggle').onclick=()=>{ registering=!registering; authLayout(); };
authForm.onsubmit=async event=>{
  event.preventDefault();
  const fields=Object.fromEntries(new FormData(authForm));
  if (!registering) delete fields.displayName;
  $('#auth-submit').disabled=true;
  try { user=await data.auth(registering,fields); authForm.reset(); layout(); }
  catch(error) { authForm.querySelector('.error').textContent=error.message; }
  finally { $('#auth-submit').disabled=false; }
};
$('#logout').onclick=async ()=>{
  try { await data.logout(); user=null; params.page=1; $('#cards').replaceChildren(); layout(); }
  catch(error){feedback(error);}
};

const completionCache=new Map();
function achievementPercent(unlocked,total) {
  return Math.floor(100*unlocked/total);
}
function showAchievementProgress(article,summary) {
  article.querySelector('.achievement-badge')?.remove();
  if (!summary?.total) return;
  const {unlocked,total}=summary;
  const perfect=unlocked===total;
  const badge=el('span',(perfect?'💎 ':'')+achievementPercent(unlocked,total)+'%',
    perfect?'achievement-badge perfect':'achievement-badge');
  badge.title='Достижения: '+unlocked+' из '+total;
  badge.setAttribute('aria-label',badge.title);
  article.querySelector('.cover').append(badge);
}
async function loadAchievementProgress(games,cards,ticket) {
  const pending=games.entries();
  async function worker() {
    for (const [i,game] of pending) {
      if (request!==ticket || !user) return;
      if (!data.hasAchievements(game)) continue;
      const key=user.id+':'+game.id;
      let cached=completionCache.get(key);
      if (!cached || cached.until<Date.now()) {
        try {
          const summary=await data.achievements(game,true);
          cached={summary,until:Date.now()+300000};
        } catch {
          cached={summary:null,until:Date.now()+60000};
        }
        completionCache.set(key,cached);
      }
      showAchievementProgress(cards[i],cached.summary);
    }
  }
  await Promise.all([worker(),worker(),worker()]);
}
function card(game) {
  const article=el('article',null,'card');
  article.dataset.entry=game.id;
  const cover=el('div',null,'cover');
  const mono=el('span',game.title.slice(0,2).toUpperCase(),'monogram');
  mono.setAttribute('aria-hidden','true');
  cover.append(mono);
  if (/^\d+$/.test(game.steamAppId)) {
    const image=el('img');
    image.alt='';
    image.loading='lazy';
    image.onload=()=>{mono.hidden=true;};
    image.onerror=()=>image.remove();
    image.src='https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/'+game.steamAppId+'/header.jpg';
    cover.append(image);
  }
  const body=el('div',null,'card-body');
  const head=el('div',null,'card-head');
  const status=el('select',null,'status '+game.status);
  status.setAttribute('aria-label','Статус игры '+game.title);
  for (const [value,label] of Object.entries(data.statuses)) status.add(new Option(label,value));
  status.value=game.status;
  status.onchange=async ()=>{
    status.disabled=true;
    try { await data.save(game.id,{status:status.value}); await refresh(); }
    catch(error){status.value=game.status; feedback(error);}
    finally{status.disabled=false;}
  };
  article.onclick=event=>{
    if (!event.target.closest('button, select, option')) openEditor(game,false);
  };
  head.append(button(game.title,()=>openEditor(game,false),'card-title'),status);
  const step=el('div',null,'step');
  if (game.nextStep) {
    const actions=el('div',null,'actions');
    actions.append(button('Изменить',()=>openEditor(game,true)),button('✓ Готово',async event=>{
      const target=event.currentTarget; target.disabled=true;
      try { await data.save(game.id,{nextStep:''}); await refresh(); $('#message').textContent='Подсказка выполнена.'; }
      catch(error){feedback(error);} finally {target.disabled=false;}
    }));
    step.append(el('strong','В следующий раз'),el('p',game.nextStep),actions);
  } else {
    step.classList.add('empty');
    step.append(button('＋ В следующий раз',()=>openEditor(game,true)));
  }
  const meta=el('p',hours(game.playtimeMinutes)+(game.rating==null?'':' · Оценка '+game.rating+'/10'),'meta');
  if (game.lastPlayedAt) {
    const played=new Date(game.lastPlayedAt);
    const day = date=>Date.UTC(date.getFullYear(),date.getMonth(),date.getDate());
    const daysAgo=(day(new Date())-day(played))/86400000;
    const when=daysAgo>=0 && daysAgo<=7
      ? new Intl.RelativeTimeFormat('ru',{numeric:'auto'}).format(-daysAgo,'day')
      : played.toLocaleDateString('ru-RU',{day:'numeric',month:'short',year:'numeric'});
    const time=el('time','Играл '+when);
    time.dateTime=game.lastPlayedAt;
    time.title=played.toLocaleString('ru-RU');
    meta.append(el('br'),time);
  } else if (data.neverPlayed(game)) {
    meta.append(el('br'), 'Последний запуск: никогда');
  }
  body.append(head,meta,step);
  article.append(cover,body);
  return article;
}
function renderStats(s) {
  const summary=$('#summary');
  summary.replaceChildren();
  for (const [value,label] of [[s.totalGames,'Всего игр'],[s.byStatus.playing,'В процессе'],[hours(s.totalPlaytimeMinutes),'Время в играх']]) {
    const item=el('div'); item.append(el('strong',value),el('span',label)); summary.append(item);
  }
  const rows=Object.entries(s.byStatus).map(([key,value])=>[data.statuses[key],value]);
  rows.push(['Доля пройденных',Math.round(s.completionPercent)+'%'],['Средняя оценка',s.averageRating==null?'Нет оценок':Number(s.averageRating.toFixed(2)).toLocaleString('ru-RU')]);
  $('#status-stats').replaceChildren(...rows.map(([label,v])=>{const row=el('div',null,'stat-row');row.append(el('span',label),el('strong',v));return row;}));
  $('#top').replaceChildren(...s.topGames.map(g=>el('li',g.title+' · '+hours(g.playtimeMinutes))));
  if (!s.topGames.length) $('#top').textContent='Время пока не указано.';
}
async function refresh() {
  const ticket=++request;
  const statistics=location.pathname==='/statistics' || location.hash==='#statistics';
  $('#page-title').textContent=statistics?'Моя статистика':'Моя коллекция';
  $('#library').hidden=statistics; $('#stats').hidden=!statistics;
  for (const a of document.querySelectorAll('nav a')) {
    const activeView = statistics ? 'statistics' : 'collection';
    if(a.hash==='#'+activeView || a.pathname==='/'+activeView) a.setAttribute('aria-current','page'); else a.removeAttribute('aria-current');
  }
  const s=await data.stats();
  if (ticket!==request || !user) return;
  params.sort=preferredSort ?? (s.hasSteamImport?'recent':'title');
  $('#sort').value=params.sort;
  const result=statistics?null:await data.list(params);
  if (ticket!==request || !user) return;
  $('#fatal').textContent=''; $('#message').textContent='';
  renderStats(s);
  if (!result) return;
  const last=Math.max(1,Math.ceil(result.total/params.pageSize));
  if (params.page>last) {params.page=last; return refresh();}
  const cards=result.items.map(card);
  $('#cards').replaceChildren(...cards);
  void loadAchievementProgress(result.items,cards,ticket);
  $('#count').textContent=result.total;
  $('#empty').hidden=Boolean(result.items.length);
  $('#empty').textContent=params.q||params.status||params.unplayed?'По этим условиям игр нет.':'Коллекция пока пуста. Добавьте свою первую игру.';
  const pages=$('#pages'); pages.replaceChildren();
  if(last>1){
    const move=delta=>{params.page+=delta;refresh().catch(feedback);};
    const prev=button('Назад',()=>move(-1)), next=button('Далее',()=>move(1));
    prev.disabled=params.page===1; next.disabled=params.page===last;
    pages.append(prev,el('span',params.page+' / '+last),next);
  }
}
const achievementsPanel=$('#achievements');
let achievementRequest=0;
achievementsPanel.ontoggle=async ()=>{
  const ticket=++achievementRequest;
  if (!achievementsPanel.open || !editing) return;
  const count=$('#achievement-count'), list=$('#achievement-list');
  count.textContent='Загружаем достижения…';
  list.replaceChildren();
  try {
    const items=await data.achievements(editing);
    if (ticket!==achievementRequest || !dialog.open) return;
    const unlocked=items.filter(item=>item.unlocked).length;
    const prefix=data.demo?'Демопример · ':'';
    const percent=items.length ? achievementPercent(unlocked,items.length) : 0;
    count.textContent=items.length ? prefix+'Получено '+unlocked+' из '+items.length+' · '+percent+'%' : 'У игры нет достижений.';
    if (items.length) {
      const bar=el('progress');
      bar.max=items.length; bar.value=unlocked;
      bar.setAttribute('aria-label','Полученные достижения');
      count.append(bar);
    }
    const summary={unlocked,total:items.length};
    completionCache.set(user.id+':'+editing.id,{summary,until:Date.now()+300000});
    const article=document.querySelector('.card[data-entry="'+editing.id+'"]');
    if (article) showAchievementProgress(article,summary);
    for (const item of items.sort((a,b)=>Number(a.unlocked)-Number(b.unlocked))) {
      const row=el('li');
      const art=el('span','✦','achievement-art');
      if (item.icon?.startsWith('https://')) {
        const img=el('img');
        img.alt=''; img.loading='lazy'; img.src=item.icon;
        img.onerror=()=>img.remove();
        art.append(img);
      }
      const details=el('div');
      row.className=item.unlocked?'unlocked':'locked';
      row.append(art,details);
      details.append(el('strong',item.name));
      if (item.description) details.append(el('p',item.description));
      if (item.globalPercent!=null) details.append(el('small',item.globalPercent.toLocaleString('ru-RU',{maximumFractionDigits:2})+'% игроков Steam'));
      if (item.unlocked) details.append(el('span','✓ Получено','earned'));
      else details.append(button('В следующий раз',()=>{
        edit.nextStep.value=Array.from('Получить достижение «'+item.name+'»').slice(0,240).join('');
        achievementsPanel.open=false;
        edit.nextStep.focus();
      }));
      list.append(row);
    }
  } catch(error) {
    if (ticket===achievementRequest && dialog.open) count.textContent=error.message;
  }
};
function openEditor(game,onlyStep) {
  achievementRequest++;
  achievementsPanel.open=false;
  achievementsPanel.hidden=onlyStep || !data.hasAchievements(game);
  form.reset(); editing=game; stepOnly=onlyStep;
  $('#edit-title').textContent=game?.title || 'Новая игра';
  $('#game-fields').hidden=onlyStep;
  $('#remove').hidden=!game||onlyStep;
  form.querySelector('.error').textContent='';
  edit.title.value=game?.title || ''; edit.title.disabled=Boolean(game); edit.title.required=!game;
  const cover=$('#edit-cover'), meta=$('#edit-meta');
  cover.hidden=!game?.steamAppId;
  cover.onerror=()=>{cover.hidden=true;};
  if(game?.steamAppId) cover.src='https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/'+game.steamAppId+'/header.jpg';
  meta.hidden=!game?.steamAppId;
  meta.textContent=game?.steamAppId?'Время в игре · '+hours(game.playtimeMinutes):'';
  edit.title.closest('label').hidden=Boolean(game);
  edit.playtimeMinutes.closest('label').hidden=Boolean(game?.steamAppId);
  edit.status.value=game?.status||'unassigned'; edit.playtimeMinutes.value=game?.playtimeMinutes??0;
  edit.playtimeMinutes.disabled=Boolean(game?.steamAppId);
  edit.rating.value=game?.rating??''; edit.completedAt.value=game?.completedAt||'';
  edit.completedAt.max=today(); edit.completedAt.disabled=edit.status.value!=='completed';
  edit.completedAt.closest('label').hidden=edit.completedAt.disabled;
  edit.notes.value=game?.notes||''; edit.nextStep.value=game?.nextStep||'';
  dialog.showModal();
  (onlyStep?edit.nextStep:game?edit.status:edit.title).focus();
}
edit.status.onchange=()=>{ edit.completedAt.disabled=edit.status.value!=='completed';edit.completedAt.closest('label').hidden=edit.completedAt.disabled;if(edit.completedAt.disabled) edit.completedAt.value=''; };
$('#add').onclick=()=>openEditor(null,false);
const steamDialog=$('#steam-dialog');
const steamForm=$('#steam-form');
$('#steam-open').onclick=()=>{
  steamForm.elements.steamId.value=user.steamId || '';
  steamForm.querySelector('.error').textContent='';
  steamDialog.showModal();
};
$('#steam-close').onclick=()=>steamDialog.close();
steamForm.onsubmit=async event=>{
  event.preventDefault();
  const submit=steamForm.querySelector('.primary');
  submit.disabled=true;
  submit.textContent='Обновляем…';
  steamForm.querySelector('.error').textContent='';
  try {
    const steamId=steamForm.elements.steamId.value;
    await data.saveSource(steamId);
    user.steamId=steamId;
    const result=await data.importSteam();
    params.page=1;
    steamDialog.close();
    await refresh();
    $('#message').textContent='Импорт завершён. Добавлено: '+result.addedCount+', обновлено: '+result.updatedCount+'.';
  } catch(error) {
    if(error.status===401 || !steamDialog.open) {steamDialog.close();feedback(error);}
    else steamForm.querySelector('.error').textContent=error.message;
  } finally {
    submit.disabled=false; submit.textContent='Обновить коллекцию';
  }
};
$('.close').onclick=()=>dialog.close();
form.onsubmit=async event=>{
  event.preventDefault(); const submit=form.querySelector('.primary');submit.disabled=true;
  try {
    const values={nextStep:edit.nextStep.value.trim()};
    if(!stepOnly){
      Object.assign(values,{status:edit.status.value,rating:edit.rating.value===''?null:Number(edit.rating.value),
        completedAt:edit.completedAt.value||null,notes:edit.notes.value});
      if(!editing){values.title=edit.title.value.trim();if(!values.title)throw Error('Введите название игры.');}
      if(!editing?.steamAppId) values.playtimeMinutes=Number(edit.playtimeMinutes.value);
    }
    // A full-card edit sends only changed fields, preserving simultaneous unrelated updates.
    if(editing) for(const key of Object.keys(values)) if(values[key]===editing[key]) delete values[key];
    if(Object.keys(values).length) await data.save(editing?.id,values);
    dialog.close(); await refresh(); $('#message').textContent='Сохранено.';
  }catch(error){if(error.status===401 || !dialog.open) feedback(error);else form.querySelector('.error').textContent=error.message;}
  finally{submit.disabled=false;}
};
$('#remove').onclick=async ()=>{
  if(!editing || !confirm('Удалить «'+editing.title+'» из коллекции?')) return;
  try { await data.remove(editing.id); dialog.close(); await refresh(); }
  catch(error){ if(error.status===401 || !dialog.open)feedback(error);else form.querySelector('.error').textContent=error.message; }
};
function filters(){
  params.q=$('#search').value;
  params.status=$('#filter').value;
  params.unplayed=$('#unplayed').checked;
  params.sort=$('#sort').value;
  params.page=1;
  refresh().catch(feedback);
}
$('#unplayed').onchange=filters;
$('#filter').onchange=filters;
$('#sort').onchange=()=>{
  preferredSort=$('#sort').value;
  try { localStorage.setItem(sortKey(),preferredSort); } catch {}
  filters();
};
$('#search').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(filters,150);};
window.addEventListener('hashchange',()=>{if(user) refresh().catch(feedback);});
authLayout();
try {user=await data.me();layout();} catch(error){layout();if(error.status!==401) feedback(error);}
if (!data.demo) {
  const url=new URL(location.href);
  const loginResult=url.searchParams.get('steamLogin');
  if (user && url.searchParams.get('steamImport')==='1') $('#steam-open').click();
  if (loginResult) {
    const messages={steam_cancelled:'Вход через Steam отменён.',steam_unavailable:'Steam временно недоступен. Попробуйте позже.'};
    authForm.querySelector('.error').textContent=Object.hasOwn(messages,loginResult)
      ? messages[loginResult] : 'Не удалось подтвердить вход через Steam. Попробуйте ещё раз.';
  }
  if (loginResult || url.searchParams.has('steamImport')) {
    url.searchParams.delete('steamLogin');
    url.searchParams.delete('steamImport');
    history.replaceState(null,'',url);
  }
}
