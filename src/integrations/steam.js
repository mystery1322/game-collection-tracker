import { ApiError } from '../lib.js';

function unavailable() {
  return new ApiError(502, 'steam_data_unavailable', 'Steam не вернул полный список игр. Проверьте SteamID и видимость игровых данных.');
}

export function parseLibrary(payload) {
  const data = payload?.response;
  if (data?.game_count === 0 && (data.games === undefined || (Array.isArray(data.games) && !data.games.length))) return [];
  if (!Array.isArray(data?.games) || !data.games.length || data.games.length !== data.game_count) throw unavailable();
  const seen = new Set();
  return data.games.map(game => {
    if (!game || !Number.isInteger(game.appid) || game.appid <= 0 || game.appid > 4294967295 ||
        seen.has(game.appid) || typeof game.name !== 'string' || !game.name.trim() ||
        [...game.name].length > 255 || game.name.includes('\0') || !game.name.isWellFormed() ||
        !Number.isInteger(game.playtime_forever) || game.playtime_forever < 0 ||
        game.playtime_forever > 2147483647) throw unavailable();
    seen.add(game.appid);
    const icon = /^[a-f\d]{40}$/i.test(game.img_icon_url)
      ? `https://media.steampowered.com/steamcommunity/public/images/apps/${game.appid}/${game.img_icon_url}.jpg` : null;
    return { appid: game.appid, title: game.name.trim(), minutes: game.playtime_forever, icon };
  });
}

export function steamLibrary(apiKey, fetchImpl = fetch) {
  return async steamId => {
    if (!apiKey) throw new ApiError(503, 'steam_unconfigured', 'Для импорта нужен серверный ключ Steam Web API.');
    const url = new URL('https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/');
    url.searchParams.set('input_json', JSON.stringify({ steamid: steamId, include_appinfo: true, include_played_free_games: true }));
    // Valve accepts the Web API key in a header, keeping it out of URLs.
    let data;
    try {
      const response = await fetchImpl(url, { headers: { 'x-webapi-key': apiKey }, redirect: 'error',
        signal: AbortSignal.timeout(12_000) });
      if (!response.ok) throw new ApiError(502, 'steam_http_error', 'Steam отклонил запрос библиотеки.');
      data = await response.json();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (['TimeoutError','AbortError'].includes(error.name)) throw new ApiError(504, 'steam_timeout', 'Steam не ответил вовремя.');
      throw new ApiError(502, 'steam_unavailable', 'Не удалось получить данные от Steam.');
    }
    return parseLibrary(data);
  };
}
