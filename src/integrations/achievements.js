import { ApiError } from '../lib.js';

export function steamAchievements(key, fetchImpl = fetch) {
  async function read(method, params, authenticated = true) {
    const url = new URL('https://api.steampowered.com/ISteamUserStats/'+method+'/');
    url.search = new URLSearchParams(params);
    const response = await fetchImpl(url, { headers: authenticated ? { 'x-webapi-key': key } : {},
      redirect: 'error', signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw Error();
    return response.json();
  }
  return async (steamId, appId, summary = false) => {
    if (!key) throw new ApiError(503, 'steam_unconfigured', 'Для загрузки достижений нужен серверный ключ Steam.');
    try {
      const { playerstats } = await read('GetPlayerAchievements/v1',{steamid:steamId,appid:appId,l:'russian'});
      if (playerstats?.success !== true || playerstats.steamID !== steamId) throw Error();
      const items = playerstats.achievements ?? [];
      if (!Array.isArray(items)) throw Error();
      if (items.some(item=>!item.apiname || ![0,1].includes(item.achieved))) throw Error();
      if (summary) return { perfect: items.length>0 && items.every(item=>item.achieved===1) };
      if (!items.length) return [];
      const [schema,global] = await Promise.all([
        read('GetSchemaForGame/v2',{appid:appId,l:'russian'}).catch(()=>null),
        read('GetGlobalAchievementPercentagesForApp/v2',{gameid:appId},false).catch(()=>null)
      ]);
      const definitions=new Map((schema?.game?.availableGameStats?.achievements ?? []).map(a=>[a.name,a]));
      const percentages=new Map((global?.achievementpercentages?.achievements ?? []).map(a=>[a.name,parseFloat(a.percent)]));
      return items.map(item => {
        const def=definitions.get(item.apiname);
        const percent=percentages.get(item.apiname);
        return { name: item.name || def?.displayName || item.apiname, description: item.description || '',
          unlocked: item.achieved===1, icon: def?.icon ?? null,
          globalPercent: percent>=0 && percent<=100 ? percent : null };
      });
    } catch {
      throw new ApiError(502, 'achievements_unavailable', 'Steam не предоставил достижения для этой игры и профиля.');
    }
  };
}
