import { ApiError } from '../lib.js';

export function steamAchievements(key, fetchImpl = fetch) {
  return async (steamId, appId) => {
    if (!key) throw new ApiError(503, 'steam_unconfigured', 'Для загрузки достижений нужен серверный ключ Steam.');
    const url = new URL('https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/');
    url.search = new URLSearchParams({ steamid: steamId, appid: appId, l: 'russian' });
    try {
      const response = await fetchImpl(url, { headers: { 'x-webapi-key': key }, redirect: 'error',
        signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw Error();
      const { playerstats } = await response.json();
      if (playerstats?.success !== true || playerstats.steamID !== steamId) throw Error();
      const items = playerstats.achievements ?? [];
      if (!Array.isArray(items)) throw Error();
      return items.map(item => {
        if (!item.apiname || ![0,1].includes(item.achieved)) throw Error();
        return { name: item.name || item.apiname, description: item.description || '', unlocked: item.achieved === 1 };
      });
    } catch {
      throw new ApiError(502, 'achievements_unavailable', 'Steam не предоставил достижения для этой игры и профиля.');
    }
  };
}
