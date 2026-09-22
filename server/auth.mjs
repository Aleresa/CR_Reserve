export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const encoder = new TextEncoder();
async function hmac(key, message) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? encoder.encode(key) : key, {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, encoder.encode(message));
}
export async function authenticate(raw, token, now = Date.now()) {
  if (!token || !raw || raw.length > 16000) throw new ApiError(401, 'Откройте приложение заново через Telegram.');
  const data = new URLSearchParams(raw);
  if (new Set(data.keys()).size !== [...data.keys()].length) throw new ApiError(401, 'Некорректная подпись Telegram.');
  const hash = data.get('hash');
  if (!/^[a-f0-9]{64}$/i.test(hash || '')) throw new ApiError(401, 'Некорректная подпись Telegram.');
  data.delete('hash');
  const text = [...data.entries()].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => `${k}=${v}`).join('\n');
  const secret = await hmac('WebAppData', token);
  const expected = new Uint8Array(await hmac(secret, text));
  let diff = 0;
  expected.forEach((byte, i) => { diff |= byte ^ parseInt(hash.slice(i*2,i*2+2),16); });
  const stamp = Number(data.get('auth_date'));
  if (diff || !Number.isInteger(stamp) || stamp > now/1000 + 30 || now/1000 - stamp > 3600) throw new ApiError(401, 'Сессия истекла. Откройте приложение заново через Telegram.');
  let user;
  try { user = JSON.parse(data.get('user')); } catch { throw new ApiError(401, 'Не удалось определить клиента.'); }
  if (!Number.isSafeInteger(user?.id) || user.id <= 0) throw new ApiError(401, 'Не удалось определить клиента.');
  return {id: String(user.id), name: [user.first_name,user.last_name].filter(Boolean).join(' ').slice(0,200) || 'Клиент', username: (user.username || '').slice(0,64)};
}
export function isAdmin(user, env) { return (env.ADMIN_IDS || '').split(',').map(x=>x.trim()).includes(String(user.id)); }
