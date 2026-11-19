import { ApiError } from '../lib.js';

const endpoint = 'https://steamcommunity.com/openid/login';
const namespace = 'http://specs.openid.net/auth/2.0';
const identitySelect = namespace + '/identifier_select';
const requiredSigned = ['op_endpoint','claimed_id','identity','return_to','response_nonce','assoc_handle'];
export const loginLifetime = 10 * 60_000;

function callback(origin, state) {
  const url = new URL('/api/auth/steam/callback', origin);
  url.searchParams.set('state', state);
  return url.href;
}

export function steamSignInUrl(origin, state) {
  const url = new URL(endpoint);
  url.search = new URLSearchParams({
    'openid.ns': namespace, 'openid.mode': 'checkid_setup', 'openid.realm': origin + '/',
    'openid.return_to': callback(origin, state),
    'openid.identity': identitySelect, 'openid.claimed_id': identitySelect
  });
  return url.href;
}

export async function verifySteamLogin(query, challenge, origin, fetchImpl = fetch) {
  const denied = () => new ApiError(401, 'steam_login_failed', 'Steam не подтвердил вход. Попробуйте ещё раз.');
  if (!challenge || Date.now() - challenge.started > loginLifetime || query.state !== challenge.state) throw denied();
  if (query['openid.mode'] === 'cancel') throw new ApiError(401,'steam_cancelled','Вход отменён.');
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (!name.startsWith('openid.')) continue;
    if (typeof value !== 'string') throw denied();
    params.set(name, value);
  }
  const claimed = params.get('openid.claimed_id') || '';
  const id = /^https?:\/\/steamcommunity\.com\/openid\/id\/([0-9]{17})$/.exec(claimed)?.[1];
  const signed = (params.get('openid.signed') || '').split(',');
  const nonce = params.get('openid.response_nonce') || '';
  const time = Date.parse(nonce.slice(0,20));
  if (!id || params.get('openid.identity') !== claimed || params.get('openid.ns') !== namespace ||
      params.get('openid.mode') !== 'id_res' || params.get('openid.op_endpoint') !== endpoint ||
      params.get('openid.return_to') !== callback(origin, challenge.state) ||
      !requiredSigned.every(k => signed.includes(k) && params.has('openid.'+k)) || !params.get('openid.sig') ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ.+$/.test(nonce) ||
      !Number.isFinite(time) || Math.abs(Date.now()-time) > loginLifetime) throw denied();
  params.set('openid.mode', 'check_authentication');
  let reply;
  try {
    const response = await fetchImpl(endpoint, {method:'POST', body:params, redirect:'error', signal:AbortSignal.timeout(12_000)});
    if (response.ok) reply = await response.text();
  } catch {
    throw new ApiError(502,'steam_unavailable','Сервис входа Steam временно недоступен.');
  }
  if (!reply?.split(/\r?\n/).includes('is_valid:true')) throw denied();
  return id;
}
