/* ===== Player info lookup (UID -> nickname, level, region) =====
   EVERY check goes to the live API (cache: 'no-store'); nothing from a lookup is cached or saved in the database.
   Calls the player-info API straight from the browser. If that API does not allow browser calls (CORS) put the
   Cloudflare relay in front of it (cloudflare-worker/README.md) and paste the relay URL here instead.
   `{uid}` is replaced by the UID being checked. Leave empty to turn the live lookup off. */
/* The list of player-info API endpoints (tried in this order; the first one that answers wins). Admin -> 🔎 API Test lets you add /
   remove / reorder them and test each one without touching the code. `full:true` = returns the complete account data (needed by the
   Player Info / Account Value pages); `full:false` = nickname-only backup (good enough to verify a UID before an order). */
const PLAYER_INFO_DEFAULT_ENDPOINTS = [
  { name: 'Primary', url: 'https://auraffxserverinfocheckerapi.onrender.com/api/player?uid={uid}', full: true },
  { name: 'Backup (nickname)', url: 'https://ff-info-api-pi.vercel.app/nickname?uid={uid}', full: false }
];
let PLAYER_INFO_ENDPOINTS = PLAYER_INFO_DEFAULT_ENDPOINTS.map(e => Object.assign({}, e));
const PLAYER_INFO_URL = PLAYER_INFO_DEFAULT_ENDPOINTS[0].url;     // kept as the "lookup is enabled" flag used by the pages
const PLAYER_INFO_TIMEOUT_MS = 20000;                             // free Render servers can take a while to wake up
function setPlayerEndpoints(list){
  const ok = (Array.isArray(list) ? list : []).filter(e => e && typeof e.url === 'string' && /^https?:\/\//i.test(e.url.trim()))
    .map(e => ({ name: String(e.name || 'API').slice(0, 30), url: e.url.trim(), full: !!e.full }));
  PLAYER_INFO_ENDPOINTS = ok.length ? ok : PLAYER_INFO_DEFAULT_ENDPOINTS.map(e => Object.assign({}, e));
}
window.__piDiag = [];                                              // last attempts (status / time / error) — shown by Admin -> API Test and in the console
/* false = if the lookup service is down / unreachable the UID is still accepted (format check only) so customers can
   still order; the UID is only rejected when the service clearly says "not found".  true = never accept without a lookup. */
const PLAYER_INFO_STRICT = false;

/* looked-up region code -> store region (used only for a friendly mismatch warning) */
const PLAYER_REGION_TO_STORE = {
  SG:'SG/MY/LK', MY:'SG/MY/LK', LK:'SG/MY/LK', BD:'Bangladesh', BR:'Brazil', ID:'Indonesia', TH:'Thailand',
  VN:'Vietnam', TW:'Taiwan', PH:'Philippines', EU:'Europe', ME:'Middle East & North Africa'
};
const PI_NICK_KEYS   = ['nickname', 'nick_name', 'playername', 'player_name', 'accountname', 'account_name', 'username', 'name'];
const PI_LEVEL_KEYS  = ['level', 'lvl', 'accountlevel', 'account_level'];
const PI_REGION_KEYS = ['region', 'server', 'countrycode', 'country_code', 'country'];
const PI_LIKES_KEYS  = ['likes', 'liked', 'like_count'];

function piClean(t){ return String(t == null ? '' : t).replace(/[<>&"'`]/g, '').trim().slice(0, 40); }
/* first value (shallowest first) stored under any of `keys`, searched in priority order */
function piDeepFind(root, keys){
  for(const key of keys){
    const queue = [root];
    while(queue.length){
      const cur = queue.shift();
      if(!cur || typeof cur !== 'object') continue;
      for(const k of Object.keys(cur)){
        if(k.toLowerCase() === key && cur[k] != null && typeof cur[k] !== 'object' && String(cur[k]).trim() !== '') return cur[k];
      }
      for(const k of Object.keys(cur)) if(cur[k] && typeof cur[k] === 'object') queue.push(cur[k]);
    }
  }
  return null;
}
/* keep digits only — no spaces / invisible characters from copy-paste */
function piDigits(v){ return String(v == null ? '' : v).replace(/\D/g, ''); }
function piBuildUrl(uid, tpl){
  const u = piDigits(uid);                     // -> ...?uid=8674177274   (nothing between "=" and the number)
  tpl = tpl || PLAYER_INFO_ENDPOINTS[0].url;
  if(tpl.indexOf('{uid}') >= 0) return tpl.replace('{uid}', u);
  return tpl + (tpl.indexOf('?') >= 0 ? '&' : '?') + 'uid=' + u;
}
/* free hosting sleeps when idle — poke every endpoint as soon as the page opens so the first real lookup is fast */
function warmUpPlayerInfo(){
  PLAYER_INFO_ENDPOINTS.forEach(ep => { try{ fetch(new URL(ep.url.replace('{uid}', '0')).origin + '/', { mode: 'no-cors' }).catch(() => {}); }catch(e){} });
}

/* opts.needRaw = only endpoints that return the full account data (Player Info / Account Value pages) */
async function lookupPlayerInfo(uid, opts){
  opts = opts || {};
  const unavailable = () => PLAYER_INFO_STRICT || opts.needRaw
    ? { ok: false, error: 'unavailable' }
    : { ok: true, fallback: true, uid, nickname: '', level: null, region: '' };
  const eps = PLAYER_INFO_ENDPOINTS.filter(e => e.url && (!opts.needRaw || e.full));
  window.__piDiag = [];
  for(const ep of eps){
    // a sleeping free server often fails the very first request, so try once more after a short pause
    let res = await piAttempt(uid, ep);
    if(res.retry){ await new Promise(r => setTimeout(r, 2500)); res = await piAttempt(uid, ep); }
    if(res.info){ res.info.source = ep.name; return res.info; }
    if(res.notFound) return { ok: false, error: 'not_found' };          // a clear "not found" from an API is final
  }                                                                      // otherwise: try the next endpoint
  return unavailable();
}
/* one request to one endpoint -> { info } | { notFound:true } | { retry:true } ; also records window.__piDiag */
async function piAttempt(uid, ep){
  uid = piDigits(uid);
  const ctl = new AbortController(), t0 = Date.now();
  const timer = setTimeout(() => ctl.abort(), ep.full ? PLAYER_INFO_TIMEOUT_MS : 12000);
  const diag = { name: ep.name, url: ep.url, status: null, ms: 0, error: null, sample: '' };
  window.__piDiag.push(diag);
  try{
    const r = await fetch(piBuildUrl(uid, ep.url), { signal: ctl.signal, cache: 'no-store' });   // always the live API — never a cached copy
    diag.status = r.status;
    const raw = await r.text(); diag.sample = raw.slice(0, 160);
    let d = null; try{ d = JSON.parse(raw); }catch(e){}
    if(!d){
      const t = raw.trim();                                         // nickname-only APIs may answer with plain text
      if(r.ok && ep.full === false && t && t.length <= 40 && !/[<>{}]/.test(t)) return { info: { ok: true, uid, nickname: piClean(t), level: null, region: '', likes: null, raw: null } };
      diag.error = 'not JSON'; return { retry: true };               // HTML / "server is waking up" page, empty body ...
    }
    const nick = (d.ok === true && d.nickname) ? d.nickname : piDeepFind(d, PI_NICK_KEYS);
    if(nick){
      const level = (d.ok === true && d.level != null) ? d.level : piDeepFind(d, PI_LEVEL_KEYS);
      const region = (d.ok === true && d.region) ? d.region : piDeepFind(d, PI_REGION_KEYS);
      const likesRaw = (d.ok === true && d.likes != null) ? d.likes : piDeepFind(d, PI_LIKES_KEYS);
      const likes = likesRaw != null && /\d/.test(String(likesRaw)) ? parseInt(String(likesRaw).replace(/\D/g, ''), 10) : null;
      return { info: { ok: true, uid, nickname: piClean(nick), level: level != null ? (Number(level) || null) : null, region: piClean(region).toUpperCase(), likes, raw: d } };
    }
    // a JSON answer without a player: only a clear "not found" from the API itself rejects the UID
    const text = JSON.stringify(d);
    if(d.success === false || d.ok === false || d.error || /not\s*found|invalid\s*uid|no\s*player/i.test(text)) return { notFound: true };
    diag.error = 'no player in response'; return { retry: true };
  } catch(e){
    diag.error = e && e.name === 'AbortError' ? 'timeout' : 'network / CORS blocked';
    return { retry: true };
  } finally { clearTimeout(timer); diag.ms = Date.now() - t0; }
}
function playerInfoChip(info){
  if(info.fallback) return 'UID accepted';
  const parts = [info.nickname];
  if(info.level) parts.push('Lv ' + info.level);
  if(info.region) parts.push(info.region);
  return parts.join(' · ');
}
/* '' when fine / unknown, otherwise a warning sentence */
function playerRegionWarning(infoRegion, selectedStoreRegion){
  const expected = PLAYER_REGION_TO_STORE[infoRegion];
  if(!expected || !selectedStoreRegion || expected === selectedStoreRegion) return '';
  return '⚠️ මේ account එකේ region එක ' + infoRegion + ' — ඔබ තෝරපු region එක (' + selectedStoreRegion + ') වෙනස්. නිවැරදි region එක තෝරන්න.';
}
if(typeof window !== 'undefined') window.addEventListener('load', warmUpPlayerInfo);

/* Final live check right before an order is charged. Returns { ok:true, info } or { ok:false, message }. */
async function liveVerifyBeforeOrder(uid){
  if(!PLAYER_INFO_ENDPOINTS.length) return { ok: true, info: null };
  const info = await lookupPlayerInfo(uid);
  if(info.ok) return { ok: true, info };
  return { ok: false, message: info.error === 'not_found'
    ? '❌ මේ UID එක හොයාගන්න බැරි උනා. UID එක නිවැරදිද බලන්න.'
    : '⚠️ UID එක verify කරන්න බැරි උනා (සේවාව දැනට වැඩ නැහැ). ටිකකින් නැවත try කරන්න.' };
}


/* ---------- verified player card (used by EVERY Free Fire verify: Free Fire page, other FF games, FF Likes, Reseller, Shell Topup, lookup pages) ---------- */
function pvEsc(t){ return String(t == null ? '' : t).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function playerCardHtml(info, uid, ok){
  if(ok === undefined) ok = true;
  const rows = [['👤', 'Nickname', info.nickname], ['⭐', 'Level', info.level ? 'Lv ' + info.level : null], ['🌍', 'Region', info.region]]
    .filter(r => r[2] != null && r[2] !== '');
  return `<div class="pv-card ${ok ? '' : 'warn'}">
    <div class="pv-head"><span class="pv-tick">${ok ? '✅' : '⚠️'}</span><div><b>${ok ? 'UID Verified' : 'Account found'}</b>${uid ? `<small>UID ${pvEsc(uid)}</small>` : ''}</div></div>
    <div class="pv-rows">${rows.map(r => `<div class="pv-row"><span>${r[0]} ${r[1]}</span><b>${pvEsc(r[2])}</b></div>`).join('')}</div>
  </div>`;
}
/* ✅ rain — called whenever a UID is verified */
function celebrateVerified(){
  if(typeof document === 'undefined' || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
  const box = document.createElement('div'); box.className = 'fall-wrap'; box.setAttribute('data-noemo', '');
  for(let i = 0; i < 22; i++){
    const s = document.createElement('span'); s.className = 'fall-emo'; s.textContent = '✅';
    s.style.left = (Math.random() * 94 + 2) + '%'; s.style.fontSize = (18 + Math.random() * 24) + 'px';
    s.style.animationDuration = (1.7 + Math.random() * 1.5) + 's'; s.style.animationDelay = (Math.random() * 0.7) + 's';
    s.style.setProperty('--sway', ((Math.random() - 0.5) * 120) + 'px');
    box.appendChild(s);
  }
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 4000);
}


/* =====================================================================
   GUILD LOOKUP (Glory Bots): Guild ID -> guild name / level / members / leader / region
   Endpoints are editable in Admin -> 🔎 API Test -> "Guild API". {id} = the Guild ID. If no endpoint answers, the order is blocked
   (a Bots order for the wrong guild can't be undone), so make sure at least one working endpoint is configured.
   ===================================================================== */
const GUILD_DEFAULT_ENDPOINTS = [{ name: 'Primary', url: 'https://auraffxserverinfocheckerapi.onrender.com/api/guild?id={id}' }];
let GUILD_ENDPOINTS = GUILD_DEFAULT_ENDPOINTS.map(e => Object.assign({}, e));
function setGuildEndpoints(list){
  const ok = (Array.isArray(list) ? list : []).filter(e => e && typeof e.url === 'string' && /^https?:\/\//i.test(e.url.trim())).map(e => ({ name: String(e.name || 'API').slice(0, 30), url: e.url.trim() }));
  GUILD_ENDPOINTS = ok.length ? ok : GUILD_DEFAULT_ENDPOINTS.map(e => Object.assign({}, e));
}
window.__gDiag = [];
function gBuildUrl(id, tpl){
  const g = String(id).replace(/\D/g, '');
  tpl = tpl || GUILD_ENDPOINTS[0].url;
  return tpl.indexOf('{id}') >= 0 ? tpl.replace('{id}', g) : (tpl.indexOf('{uid}') >= 0 ? tpl.replace('{uid}', g) : tpl + (tpl.indexOf('?') >= 0 ? '&' : '?') + 'id=' + g);
}
const G_NAME = ['guild_name', 'guildname', 'clan_name', 'clanname', 'name'];
const G_LEVEL = ['guild_level', 'guildlevel', 'clan_level', 'clanlevel', 'level', 'lvl'];
const G_MEMBERS = ['member_count', 'membercount', 'members_count', 'num_members', 'current_members', 'currentmembers', 'members'];
const G_CAP = ['capacity', 'max_members', 'maxmembers', 'member_capacity', 'max_member'];
const G_LEADER = ['leader_name', 'leadername', 'leader_nickname', 'owner_name', 'captain_name', 'leader', 'owner', 'captain'];
const G_REGION = ['region', 'server', 'region_name', 'country'];
const G_ID = ['guild_id', 'guildid', 'clan_id', 'clanid', 'id'];
function gParse(d, id){
  const root = (d && typeof d === 'object') ? (['guild', 'clan', 'guild_info', 'data', 'result'].map(k => d[k]).find(v => v && typeof v === 'object' && !Array.isArray(v)) || d) : d;
  const name = piDeepFind(root, G_NAME);
  if(!name) return null;
  let leader = null;
  for(const k of ['leader', 'owner', 'captain']){ const v = root[k]; if(v && typeof v === 'object'){ leader = piDeepFind(v, ['nickname', 'name', 'leader_name']); if(leader) break; } }
  if(!leader) leader = piDeepFind(root, G_LEADER);
  const num = x => { const n = parseInt(String(x == null ? '' : x).replace(/\D/g, ''), 10); return isFinite(n) ? n : null; };
  let members = piDeepFind(root, G_MEMBERS);
  if(Array.isArray(root.members)) members = root.members.length;
  return { ok: true, id: String(piDeepFind(root, G_ID) || id), name: piClean(name), level: num(piDeepFind(root, G_LEVEL)), members: num(members), capacity: num(piDeepFind(root, G_CAP)),
    leader: leader ? piClean(leader) : '', region: piClean(piDeepFind(root, G_REGION) || piDeepFind(d, G_REGION)).toUpperCase(), raw: d };
}
async function gAttempt(id, ep){
  const ctl = new AbortController(), t0 = Date.now(), timer = setTimeout(() => ctl.abort(), PLAYER_INFO_TIMEOUT_MS);
  const diag = { name: ep.name, url: ep.url, status: null, ms: 0, error: null, sample: '' };
  window.__gDiag.push(diag);
  try{
    const r = await fetch(gBuildUrl(id, ep.url), { signal: ctl.signal, cache: 'no-store' });
    diag.status = r.status;
    const raw = await r.text(); diag.sample = raw.slice(0, 160);
    let d = null; try{ d = JSON.parse(raw); }catch(e){}
    if(!d){ diag.error = 'not JSON'; return { retry: true }; }
    const info = gParse(d, id);
    if(info) return { info };
    if(d.success === false || d.ok === false || d.error || /not\s*found|invalid|no\s*guild|no\s*clan/i.test(JSON.stringify(d).slice(0, 400))) return { notFound: true };
    diag.error = 'no guild in response'; return { retry: true };
  }catch(e){ diag.error = e && e.name === 'AbortError' ? 'timeout' : 'network / CORS blocked'; return { retry: true }; }
  finally{ clearTimeout(timer); diag.ms = Date.now() - t0; }
}
async function lookupGuildInfo(id){
  id = String(id).replace(/\D/g, ''); window.__gDiag = [];
  for(const ep of GUILD_ENDPOINTS){
    let res = await gAttempt(id, ep);
    if(res.retry){ await new Promise(r => setTimeout(r, 2500)); res = await gAttempt(id, ep); }
    if(res.info) return res.info;
    if(res.notFound) return { ok: false, error: 'not_found' };
  }
  return { ok: false, error: 'unavailable' };
}
function guildCardHtml(g){
  const rows = [['🏰', 'Guild Name', g.name], ['🆔', 'Guild ID', g.id], ['⭐', 'Level', g.level != null ? 'Lv ' + g.level : null],
    ['👥', 'Members', g.members != null ? g.members + (g.capacity ? ' / ' + g.capacity : '') : null], ['👑', 'Leader', g.leader], ['🌍', 'Region', g.region]].filter(r => r[2] != null && r[2] !== '');
  return `<div class="pv-card"><div class="pv-head"><span class="pv-tick">✅</span><div><b>Guild Verified</b><small>Guild details successfully loaded</small></div></div>
    <div class="pv-rows">${rows.map(r => `<div class="pv-row"><span>${r[0]} ${r[1]}</span><b>${pvEsc(r[2])}</b></div>`).join('')}</div></div>`;
}
