'use strict';
{
/* ================= Ayarlar ================= */
const MODELS = [
  { id: 'ecmwf_ifs025',         name: 'ECMWF',    org: 'Avrupa',              color: '#ffb74d' },
  { id: 'ecmwf_aifs025_single', name: 'ECMWF AI', org: 'Avrupa · yapay zekâ', color: '#fff176' },
  { id: 'gfs_seamless',         name: 'GFS',      org: 'ABD',                 color: '#ef9a9a' },
  { id: 'icon_seamless',        name: 'ICON',     org: 'Almanya',             color: '#80deea' },
  { id: 'meteofrance_seamless', name: 'ARPEGE',   org: 'Fransa',              color: '#90caf9' },
  { id: 'ukmo_seamless',        name: 'UKMO',     org: 'İngiltere',           color: '#ce93d8' },
  { id: 'jma_seamless',         name: 'JMA',      org: 'Japonya',             color: '#f48fb1' },
  { id: 'gem_seamless',         name: 'GEM',      org: 'Kanada',              color: '#a5d6a7' },
];
const DEFAULT_LOC = { name: 'İstanbul', region: 'Türkiye', lat: 41.0138, lon: 28.9497 };
const API = 'https://api.open-meteo.com/v1/forecast';
const GEO = 'https://geocoding-api.open-meteo.com/v1/search';
const AQ = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const FORECAST_DAYS = 14;
const HOURLY = 'temperature_2m,precipitation,weather_code,wind_speed_10m';
const DAILY = 'temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code,wind_speed_10m_max';
const RAIN_H = 0.1;   // saatlik: bu kadar mm ve üstü "yağış var"
const RAIN_D = 0.5;   // günlük: bu kadar mm ve üstü "yağışlı gün"
const OFF_T = 3;      // ortak görüşten bu kadar derece sapan model işaretlenir

/* ================= Hava kodları ================= */
const DESC = {0:'Açık',1:'Çoğunlukla açık',2:'Parçalı bulutlu',3:'Kapalı',45:'Sisli',48:'Kırağılı sis',
  51:'Hafif çisenti',53:'Çisenti',55:'Yoğun çisenti',56:'Donan çisenti',57:'Donan çisenti',
  61:'Hafif yağmur',63:'Yağmur',65:'Kuvvetli yağmur',66:'Donan yağmur',67:'Donan yağmur',
  71:'Hafif kar',73:'Kar',75:'Yoğun kar',77:'Kar taneleri',80:'Hafif sağanak',81:'Sağanak',82:'Şiddetli sağanak',
  85:'Kar sağanağı',86:'Yoğun kar sağanağı',95:'Gök gürültülü sağanak',96:'Dolulu fırtına',99:'Dolulu fırtına'};
const CAT_NAME = {clear:'Açık',partly:'Parçalı bulutlu',cloudy:'Bulutlu',fog:'Sisli',rain:'Yağmurlu',snow:'Karlı',storm:'Fırtınalı'};
const SEV = ['clear','partly','cloudy','fog','rain','snow','storm'];
const WET = new Set(['rain','snow','storm']);

function cat(c) {
  if (c == null) return null;
  if (c <= 1) return 'clear';
  if (c === 2) return 'partly';
  if (c === 3) return 'cloudy';
  if (c === 45 || c === 48) return 'fog';
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return 'snow';
  if (c >= 95) return 'storm';
  return 'rain';
}
// En çok tekrar eden kategori; eşitlikte daha şiddetli olan kazanır
function majority(cats) {
  const cnt = {};
  for (const c of cats) if (c) cnt[c] = (cnt[c] || 0) + 1;
  let best = null, bn = 0;
  for (const c of SEV) { const n = cnt[c] || 0; if (n > 0 && n >= bn) { best = c; bn = n; } }
  return best;
}
// Yağış oyu ile hava ikonunu tutarlı yap: çoğunluk yağış demiyorsa ikon yağışlı olmasın
function consensusCat(cats, share) {
  if (share >= 0.5) { const w = majority(cats.filter(c => WET.has(c))); return w || 'rain'; }
  return majority(cats.filter(c => c && !WET.has(c))) || 'cloudy';
}

/* ================= İstatistik ================= */
const nums = a => a.filter(v => typeof v === 'number' && isFinite(v));
function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
// Tek bir uç model güveni düşürmesin: 5+ modelde en uçtaki birer değer atılır
function trimmedSpread(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const k = s.length >= 5 ? 1 : 0;
  return s[s.length - 1 - k] - s[k];
}
const r0 = v =>(v == null ? '–' : String(Math.round(v) || 0));
function rainLvl(share, n) {
  if (!n) return 1;
  if (share <= 0.2 || share >= 0.8) return 2;
  if (share < 0.35 || share > 0.65) return 1;
  return 0;
}
function tempLvl(spread) { return spread <= 2 ? 2 : spread <= 4 ? 1 : 0; }
const LVL_TEXT = ['Modeller anlaşamıyor', 'Kısmen uyuşuyor', 'Modeller uyuşuyor'];

/* ================= Veri hizalama ================= */
// Tek model istendiğinde anahtarlar sade gelir; yine de "_modelid" ekli hâli de denenir
function column(m, part, key, refTimes) {
  const src = m[part];
  if (!src) return refTimes.map(() => null);
  const arr = src[key] ?? src[key + '_' + m.id];
  if (!arr) return refTimes.map(() => null);
  if (src.time && src.time.length === refTimes.length && src.time[0] === refTimes[0]) return arr;
  const map = new Map((src.time || []).map((t, i) => [t, arr[i]]));
  return refTimes.map(t => (map.has(t) ? map.get(t) : null));
}

/* ================= Ortak görüş hesabı ================= */
// weights: { modelId: ağırlık } verilirse sıcaklık ortak görüşü ağırlıklı ortalama olur, yoksa medyan
function consensusT(ms, get, weights) {
  const pairs = ms.map(m => [m.id, get(m)]).filter(([, v]) => typeof v === 'number' && isFinite(v));
  if (!pairs.length) return null;
  if (!weights) return median(pairs.map(p => p[1]));
  const ws = Object.values(weights), avg = ws.reduce((a, b) => a + b, 0) / ws.length;
  let sw = 0, sv = 0;
  for (const [id, v] of pairs) { const w = weights[id] ?? avg; sw += w; sv += w * v; }
  return sv / sw;
}
function compute(data, weights) {
  const H = data.bm.hourly.time, D = data.bm.daily.time;
  const ms = data.models.map(m => ({
    id: m.id, name: m.name, org: m.org, color: m.color,
    h: { t: column(m, 'hourly', 'temperature_2m', H), p: column(m, 'hourly', 'precipitation', H),
         c: column(m, 'hourly', 'weather_code', H), w: column(m, 'hourly', 'wind_speed_10m', H) },
    d: { tx: column(m, 'daily', 'temperature_2m_max', D), tn: column(m, 'daily', 'temperature_2m_min', D),
         p: column(m, 'daily', 'precipitation_sum', D), c: column(m, 'daily', 'weather_code', D),
         w: column(m, 'daily', 'wind_speed_10m_max', D) },
  }));
  const isDayArr = data.bm.hourly.is_day || [];
  const hours = H.map((time, i) => {
    const ts = nums(ms.map(m => m.h.t[i]));
    const ps = nums(ms.map(m => m.h.p[i]));
    const rainN = ps.filter(v => v >= RAIN_H).length;
    const share = ps.length ? rainN / ps.length : 0;
    return {
      time, t: consensusT(ms, m => m.h.t[i], weights), tLo: ts.length ? Math.min(...ts) : null, tHi: ts.length ? Math.max(...ts) : null,
      n: ps.length, rainN, share, p: median(ps), w: median(nums(ms.map(m => m.h.w[i]))),
      cat: consensusCat(ms.map(m => cat(m.h.c[i])), share),
      isDay: isDayArr[i] !== 0,
    };
  });
  const days = D.map((date, i) => {
    const tx = nums(ms.map(m => m.d.tx[i])), tn = nums(ms.map(m => m.d.tn[i]));
    const ps = nums(ms.map(m => m.d.p[i])), ws = nums(ms.map(m => m.d.w[i]));
    const rainN = ps.filter(v => v >= RAIN_D).length;
    const share = ps.length ? rainN / ps.length : 0;
    const spread = trimmedSpread(tx);
    const lvl = ps.length < 2 ? 0 : Math.min(tempLvl(spread), rainLvl(share, ps.length));
    return {
      date, tx: consensusT(ms, m => m.d.tx[i], weights), tn: consensusT(ms, m => m.d.tn[i], weights),
      txLo: tx.length ? Math.min(...tx) : null, txHi: tx.length ? Math.max(...tx) : null,
      tnLo: tn.length ? Math.min(...tn) : null,
      p: median(ps), w: median(ws), n: ps.length, rainN, share, spread, lvl,
      cat: consensusCat(ms.map(m => cat(m.d.c[i])), share),
    };
  });
  const nowT = (data.bm.current && data.bm.current.time) || H[0];
  let start = H.indexOf(nowT.slice(0, 13) + ':00');
  if (start < 0) start = 0;
  return { ms, hours, days, start };
}

/* ================= Hakem kararı ================= */
const hh = t => t.slice(11, 16);
function verdict(c) {
  const win = c.hours.slice(c.start, c.start + 12).filter(h => h.n);
  const d0 = c.days[0];
  const maj = win.find(h => h.share >= 0.5);
  const peak = win.reduce((a, h) => (!a || h.rainN > a.rainN ? h : a), null);
  let text, sub;
  if (maj) {
    const word = maj.cat === 'snow' ? 'kar' : maj.cat === 'storm' ? 'gök gürültülü sağanak' : 'yağmur';
    text = maj === win[0] ? `Şu an ${word} var ya da başlamak üzere.` : `Saat ${hh(maj.time)} civarı ${word} bekleniyor.`;
    sub = `${maj.n} modelden ${maj.rainN} tanesi aynı fikirde. ` +
          (maj.cat === 'snow' ? 'Sıkı giyin, yollar kayabilir.' : 'Şemsiyeni yanına al.');
  } else if (peak && peak.rainN > 0) {
    text = 'Büyük ihtimalle kuru geçecek.';
    sub = `Yalnızca ${peak.n} modelden ${peak.rainN} tanesi ${hh(peak.time)} civarı hafif yağış görüyor. Şemsiye şart değil.`;
  } else {
    text = 'Önümüzdeki 12 saat kuru.';
    sub = `${c.ms.length} modelin hepsi bu konuda hemfikir.`;
  }
  if (d0 && d0.tx != null) {
    const rng = d0.txHi - d0.txLo >= 1 ? `; modeller ${r0(d0.txLo)}° ile ${r0(d0.txHi)}° arasında` : '';
    sub += ` Bugün en yüksek ${r0(d0.tx)}°${rng}.`;
    if (d0.w != null && d0.w >= 40) sub += ` Rüzgâr sert esecek (~${r0(d0.w)} km/sa).`;
  }
  const winLvl = win.length ? Math.min(...win.map(h => rainLvl(h.share, h.n))) : 1;
  const lvl = Math.min(d0 ? d0.lvl : 1, winLvl);
  return { text, sub, lvl };
}

/* ================= Doğruluk karnesi ================= */
const KARNE_MIN_DAYS = 5;     // ağırlıklandırma için gereken gün sayısı
const KARNE_MAX_KM = 150;     // karnenin geçerli sayılacağı en uzak mesafe
function distKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLa = (b.lat - a.lat) * rad, dLo = (b.lon - a.lon) * rad;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function nearestCity(cities, loc) {
  let best = null;
  for (const c of cities || []) { const km = distKm(loc, c); if (!best || km < best.km) best = { city: c, km }; }
  return best;
}
// Yakında, yeterli günü olan bir karne varsa: ağırlık = 1 / hata²
function weightsFor(card, loc) {
  if (!card || !loc) return null;
  const n = nearestCity(card.cities, loc);
  if (!n || n.km > KARNE_MAX_KM || n.city.days < KARNE_MIN_DAYS) return null;
  const ms = (n.city.models || []).filter(m => m.id !== 'ortak' && m.mae != null);
  if (ms.length < 3) return null;
  const w = {};
  for (const m of ms) w[m.id] = 1 / Math.max(0.5, m.mae) ** 2;
  return w;
}

/* ================= Ay: evre, doğuş, batış ================= */
const RAD = Math.PI / 180, DAY_MS = 864e5;
const toJ2000 = ms => ms / DAY_MS + 2440587.5 - 2451545;
function moonAltitude(ms, lat, lon) {
  const d = toJ2000(ms);
  const L = RAD * (218.316 + 13.176396 * d), M = RAD * (134.963 + 13.064993 * d), F = RAD * (93.272 + 13.229350 * d);
  const l = L + RAD * 6.289 * Math.sin(M), b = RAD * 5.128 * Math.sin(F), e = RAD * 23.4397;
  const ra = Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l));
  const dec = Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l));
  const H = RAD * (280.16 + 360.9856235 * d) + RAD * lon - ra, phi = RAD * lat;
  return Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
}
// Yerel gün (dateStr) içinde ayın doğduğu ve battığı saatler, 10 dakikalık adımlarla
function moonTimes(dateStr, offsetSec, lat, lon) {
  const t0 = Date.parse(dateStr + 'T00:00:00Z') - offsetSec * 1000, h0 = 0.133 * RAD;
  let rise = null, set = null, prev = moonAltitude(t0, lat, lon) - h0;
  for (let m = 10; m <= 1440; m += 10) {
    const t = t0 + m * 60000, cur = moonAltitude(t, lat, lon) - h0;
    if (prev < 0 && cur >= 0 && rise == null) rise = t - 600000 * cur / (cur - prev);
    if (prev >= 0 && cur < 0 && set == null) set = t - 600000 * cur / (cur - prev);
    prev = cur;
  }
  const fmt = ms => (ms == null ? null : new Date(ms + offsetSec * 1000).toISOString().slice(11, 16));
  return { rise: fmt(rise), set: fmt(set) };
}
function moonPhase(ms) {
  const SYN = 29.530588853, jd = ms / DAY_MS + 2440587.5;
  const age = (((jd - 2451550.1) % SYN) + SYN) % SYN, frac = age / SYN;
  const names = ['Yeni Ay', 'Büyüyen Hilal', 'İlk Dördün', 'Büyüyen Şişkin Ay', 'Dolunay', 'Küçülen Şişkin Ay', 'Son Dördün', 'Küçülen Hilal'];
  return { age, frac, illum: (1 - Math.cos(2 * Math.PI * frac)) / 2, waxing: frac < 0.5, name: names[Math.floor(frac * 8 + 0.5) % 8] };
}

/* ================= Seviyeler ve açıklamalar ================= */
const band = (v, list) => list.find(([lim]) => v < lim)[1];
const aqiInfo = v => band(v, [[20, 'İyi'], [40, 'Makul'], [60, 'Orta'], [80, 'Kötü'], [100, 'Çok kötü'], [Infinity, 'Son derece kötü']]);
const uvInfo = v => band(v, [[3, 'Düşük'], [6, 'Orta'], [8, 'Yüksek'], [11, 'Çok yüksek'], [Infinity, 'Aşırı']]);
const pollenInfo = v => (v == null ? 'Veri yok' : band(v, [[1, 'Yok'], [20, 'Düşük'], [50, 'Orta'], [150, 'Yüksek'], [Infinity, 'Çok yüksek']]));
const windInfo = v => band(v, [[2, 'Sakin'], [6, 'Neredeyse durgun'], [12, 'Hafif bir esinti'], [20, 'Hafif rüzgâr'], [29, 'Orta rüzgâr'], [39, 'Sert esinti'], [50, 'Kuvvetli rüzgâr'], [62, 'Fırtınamsı'], [75, 'Fırtına'], [Infinity, 'Şiddetli fırtına']]);
const visInfo = km => band(km, [[1, 'Sis, çok kısıtlı'], [2, 'Zayıf'], [5, 'Pus var, orta'], [10, 'İyi'], [Infinity, 'Çok iyi']]);
const dewInfo = v => band(v, [[5, 'Hava çok kuru'], [10, 'Hava kuru'], [16, 'Rahat'], [20, 'Biraz nemli'], [24, 'Boğucu'], [Infinity, 'Bunaltıcı']]);
const WIND_FROM = ['Kuzeyden', 'Kuzeydoğudan', 'Doğudan', 'Güneydoğudan', 'Güneyden', 'Güneybatıdan', 'Batıdan', 'Kuzeybatıdan'];
const windFrom = deg => WIND_FROM[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
// Koşu uygunluğu: 0-100
function runScore(t, share, wind, aqi) {
  if (t == null) return null;
  let s = 100;
  if (t < 8) s -= (8 - t) * 4; else if (t > 20) s -= (t - 20) * 5;
  if (share >= 0.5) s -= 45; else s -= share * 40;
  if (wind > 25) s -= (wind - 25) * 1.5;
  if (aqi > 60) s -= (aqi - 60) * 0.8;
  return Math.max(0, Math.min(100, Math.round(s)));
}
const runInfo = s => (s == null ? '–' : s >= 70 ? 'İyi' : s >= 45 ? 'Orta' : 'Kötü');

/* ================= Node testleri için dışa aç ================= */
if (typeof document === 'undefined') {
  if (typeof module !== 'undefined') module.exports = { moonTimes, moonPhase, aqiInfo, uvInfo, pollenInfo, windInfo, windFrom, runScore, runInfo, compute, consensusT, weightsFor, nearestCity, verdict, cat, majority, consensusCat, median, column, MODELS };
} else {
  init();
}

/* ================= Tarayıcı kısmı ================= */
function init() {
  const $ = s => document.querySelector(s);
  const esc = s => String(s).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
  };
  const S = { loc: store.get('hh.loc') || DEFAULT_LOC, data: null, c: null, sel: 0, theme: 'auto', loading: false, card: null };

  /* ---------- İkonlar ---------- */
  const CLOUD = 'M10 27h16a6 6 0 0 0 .7-11.96A8.5 8.5 0 0 0 10.4 13 7 7 0 0 0 10 27z';
  function sunSvg(cx, cy, r) {
    let rays = '';
    for (let k = 0; k < 8; k++) {
      const a = k * Math.PI / 4, c1 = Math.cos(a), s1 = Math.sin(a);
      rays += `<line x1="${(cx + c1 * (r + 2.5)).toFixed(1)}" y1="${(cy + s1 * (r + 2.5)).toFixed(1)}" x2="${(cx + c1 * (r + 5)).toFixed(1)}" y2="${(cy + s1 * (r + 5)).toFixed(1)}"/>`;
    }
    return `<g stroke="#ffd23f" stroke-width="2" stroke-linecap="round">${rays}</g><circle cx="${cx}" cy="${cy}" r="${r}" fill="#ffd23f"/>`;
  }
  const moonSvg = (dx = 0, dy = 0, k = 1) =>
    `<path transform="translate(${dx} ${dy}) scale(${k})" d="M21 6.5a11 11 0 1 0 8.5 17.6A9 9 0 0 1 21 6.5z" fill="#f6eec6"/>`;
  const cloudSvg = (fill, dy = 0) => `<path transform="translate(0 ${dy})" d="${CLOUD}" fill="${fill}"/>`;
  function icon(c, day = true) {
    let g = '';
    switch (c) {
      case 'clear': g = day ? sunSvg(18, 18, 7) : moonSvg(); break;
      case 'partly': g = (day ? sunSvg(13, 12, 5.5) : moonSvg(-5, -4, 0.75)) + cloudSvg('#f4f7fb', 3); break;
      case 'cloudy': g = `<path transform="translate(5 -4) scale(.8)" d="${CLOUD}" fill="#c3cdd8"/>` + cloudSvg('#eef2f7', 2); break;
      case 'fog': g = cloudSvg('#e6ebf0', -4) + '<g stroke="#e6ebf0" stroke-width="2.2" stroke-linecap="round"><line x1="7" y1="28" x2="29" y2="28"/><line x1="10" y1="32" x2="26" y2="32"/></g>'; break;
      case 'rain': g = cloudSvg('#e3e9f0', -5) + '<g stroke="#7cc4ff" stroke-width="2.2" stroke-linecap="round"><line x1="13" y1="26" x2="11.5" y2="31"/><line x1="18.5" y1="26" x2="17" y2="31"/><line x1="24" y1="26" x2="22.5" y2="31"/></g>'; break;
      case 'snow': g = cloudSvg('#eef3f8', -5) + '<g fill="#ffffff" stroke="#9cc8ee" stroke-width=".8"><circle cx="12.5" cy="28" r="1.9"/><circle cx="18.5" cy="31" r="1.9"/><circle cx="24.5" cy="28" r="1.9"/></g>'; break;
      case 'storm': g = cloudSvg('#b9b4d6', -6) + '<path d="M19 22l-5 7h4l-3 6 8-8.5h-4l2.5-4.5z" fill="#ffd23f"/>'; break;
      default: g = cloudSvg('#e3e9f0', 0);
    }
    return `<svg class="ic" viewBox="0 0 36 36" aria-hidden="true">${g}</svg>`;
  }
  const DROP = '<svg class="drop" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1S2 6 2 8a4 4 0 0 0 8 0C10 6 6 1 6 1z" fill="currentColor"/></svg>';

  /* ---------- Yardımcılar ---------- */
  function dayName(date, i) {
    if (i === 0) return 'Bugün';
    if (i === 1) return 'Yarın';
    const s = new Date(date + 'T12:00').toLocaleDateString('tr-TR', { weekday: 'long' });
    return s.charAt(0).toLocaleUpperCase('tr-TR') + s.slice(1);
  }
  const shortDay = date => new Date(date + 'T12:00').toLocaleDateString('tr-TR', { weekday: 'short' });
  let toastT = 0;
  function toast(msg) {
    const el = $('#toast'); el.textContent = msg; el.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => { el.hidden = true; }, 3800);
  }
  async function getJSON(url, ms = 15000) {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
    try {
      const r = await fetch(url, { signal: ac.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally { clearTimeout(t); }
  }
  const qs = o => Object.entries(o).map(([k, v]) => k + '=' + encodeURIComponent(v).replace(/%2C/g, ',')).join('&');

  /* ---------- Veri çekme ---------- */
  async function loadForecast(loc) {
    const base = { latitude: loc.lat, longitude: loc.lon, timezone: 'auto', forecast_days: FORECAST_DAYS };
    const geo = { latitude: loc.lat, longitude: loc.lon, timezone: 'auto' };
    // Ek bilgiler (dün, UV, basınç, görünürlük...) ve hava kalitesi: başarısız olursa uygulama yine çalışır
    const extP = getJSON(API + '?' + qs({ ...geo, past_days: 1, forecast_days: 3,
      current: 'wind_direction_10m,wind_gusts_10m,dew_point_2m,pressure_msl,visibility,uv_index,cloud_cover',
      hourly: 'pressure_msl,relative_humidity_2m,uv_index,visibility',
      daily: 'sunrise,sunset,uv_index_max,daylight_duration,temperature_2m_max,temperature_2m_min,weather_code' })).catch(() => null);
    const aqP = getJSON(AQ + '?' + qs({ ...geo, forecast_days: 1,
      current: 'european_aqi,pm10,pm2_5,alder_pollen,birch_pollen,grass_pollen,mugwort_pollen,olive_pollen,ragweed_pollen' })).catch(() => null);
    const bmP = getJSON(API + '?' + qs({ ...base,
      current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,is_day,wind_speed_10m',
      hourly: 'is_day', daily: 'sunrise,sunset' }));
    const mPs = MODELS.map(m => getJSON(API + '?' + qs({ ...base, hourly: HOURLY, daily: DAILY, models: m.id }))
      .then(d => ({ ...m, hourly: d.hourly, daily: d.daily })));
    const [bm, ext, aq, ...rs] = await Promise.allSettled([bmP, extP, aqP, ...mPs]);
    if (bm.status !== 'fulfilled') throw bm.reason;
    const usable = m => m.hourly && Array.isArray(m.hourly.time) &&
      Object.keys(m.hourly).some(k => k.startsWith('temperature_2m') && (m.hourly[k] || []).some(v => v != null));
    const models = rs.filter(r => r.status === 'fulfilled' && usable(r.value)).map(r => r.value);
    if (models.length < 2) throw new Error('Yeterli model yanıt vermedi');
    return { loc, at: Date.now(), bm: bm.value, models, ext: ext.value || null, aq: aq.value || null };
  }

  function refresh(quiet) {
    if (!isFinite(S.loc.lat)) return Promise.resolve();
    if (S.loading) return S.pending;
    S.pending = doRefresh(quiet);
    return S.pending;
  }
  async function doRefresh(quiet) {
    S.loading = true; $('#refreshBtn').classList.add('spin');
    const loc = S.loc;
    try {
      const data = await loadForecast(loc);
      cachePut(data);
      if (locKey(loc) === locKey(S.loc)) { S.data = data; render(); }
      loadFavTemps();
    } catch (e) {
      console.error(e);
      if (!S.data) {
        $('#nowDesc').textContent = 'Veri alınamadı';
        $('#verdictText').textContent = 'Modellere ulaşılamadı.';
        $('#verdictSub').textContent = 'İnternet bağlantını kontrol edip yenile düğmesine bas.';
      }
      if (!quiet || !S.data) toast('Hava verisi alınamadı. Bağlantıyı kontrol et.');
    } finally {
      S.loading = false; $('#refreshBtn').classList.remove('spin');
      // Yükleme sürerken başka konuma geçildiyse onu da yükle
      if (locKey(loc) !== locKey(S.loc)) refresh(true);
    }
  }

  /* ---------- Çizim ---------- */
  function render() {
    S.w = weightsFor(S.card, S.loc);
    S.c = compute(S.data, S.w);
    const { hours, days, start, ms } = S.c;
    const cur = S.data.bm.current || {};
    $('#placeName').textContent = S.loc.name;

    // Şu an
    const curCat = cat(cur.weather_code) || hours[start].cat;
    const isDay = cur.is_day !== 0;
    $('#nowIcon').innerHTML = icon(curCat, isDay);
    $('#nowTemp').textContent = r0(cur.temperature_2m ?? hours[start].t);
    $('#nowDesc').textContent = DESC[cur.weather_code] || CAT_NAME[curCat] || '';
    const meta = [];
    if (cur.apparent_temperature != null) meta.push(`Hissedilen ${r0(cur.apparent_temperature)}°`);
    if (days[0]) meta.push(`${r0(days[0].tn)}° / ${r0(days[0].tx)}°`);
    if (cur.wind_speed_10m != null) meta.push(`Rüzgâr ${r0(cur.wind_speed_10m)} km/sa`);
    if (cur.relative_humidity_2m != null) meta.push(`Nem %${r0(cur.relative_humidity_2m)}`);
    $('#nowMeta').textContent = meta.join(' · ');

    // Karar
    const v = verdict(S.c);
    $('#verdictText').textContent = v.text;
    $('#verdictSub').textContent = v.sub;
    const b = $('#conf'); b.hidden = false; b.className = 'badge lvl-' + v.lvl; b.textContent = LVL_TEXT[v.lvl];

    renderHours();
    renderDays();
    renderTiles();

    renderTable();
    drawChart();
    renderKarne();
    applyTheme();
    const t = new Date(S.data.at);
    const age = Math.round((Date.now() - S.data.at) / 60000);
    $('#updated').textContent = `${ms.length} model · Güncellendi ${t.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}` + (age > 60 ? ` (${Math.round(age / 60)} saat önce)` : '');
  }

  function renderTable() {
    const { ms, days } = S.c, i = S.sel, d = days[i];
    $('#dayChips').innerHTML = days.map((x, k) =>
      `<button class="chip" type="button" data-i="${k}" aria-pressed="${k === i}">${esc(k < 2 ? dayName(x.date, k) : shortDay(x.date))} ${r0(x.tx)}°</button>`).join('');
    $('#drawerPlace').textContent = S.loc.name + (S.loc.region ? ', ' + S.loc.region : '');
    document.querySelectorAll('.day').forEach(x => x.setAttribute('aria-pressed', String(+x.dataset.i === i)));
    $('#deskDay').textContent = dayName(d.date, i) + ' · ' + new Date(d.date + 'T12:00').toLocaleDateString('tr-TR', { day: 'numeric', month: 'long' });
    const row = m => {
      const tx = m.d.tx[i], tn = m.d.tn[i], p = m.d.p[i], w = m.d.w[i];
      if (tx == null && p == null) return `<tr><td><span class="mname"><i style="background:${m.color}"></i><span>${esc(m.name)}<small>${esc(m.org)}</small></span></span></td><td colspan="5" class="muted small">Bu gün için tahmin yok</td></tr>`;
      const off = (v, med) => (v != null && med != null && Math.abs(v - med) >= OFF_T ? ' class="off"' : '');
      return `<tr>
        <td><span class="mname"><i style="background:${m.color}"></i><span>${esc(m.name)}<small>${esc(m.org)}</small></span></span></td>
        <td>${icon(cat(m.d.c[i]), true)}</td>
        <td${off(tx, d.tx)}>${r0(tx)}°</td>
        <td${off(tn, d.tn)}>${r0(tn)}°</td>
        <td${p != null && p >= RAIN_D ? ' class="wet"' : ''}>${p == null ? "–" : p.toFixed(1)}<span class="u"> mm</span></td>
        <td class="cw">${r0(w)} km/sa</td></tr>`;
    };
    $('#modelTable').innerHTML = `<thead><tr><th>Model</th><th>Hava</th><th>Yüksek</th><th>Düşük</th><th>Yağış (mm)</th><th class="cw">Rüzgâr</th></tr></thead>
      <tbody>${ms.map(row).join('')}
      <tr class="cons"><td>Ortak görüş</td><td>${icon(d.cat, true)}</td><td>${r0(d.tx)}°</td><td>${r0(d.tn)}°</td>
      <td>${d.p == null ? "–" : d.p.toFixed(1)}<span class="u"> mm</span></td><td class="cw">${r0(d.w)} km/sa</td></tr></tbody>`;
  }

  /* ---------- Saatlik şerit: sıcaklık eğrisi + gün doğumu/batımı ---------- */
  const STEP = 68; // .hr genişliği 64 + boşluk 4
  const tMin = t => Date.parse(t + 'Z') / 60000;
  function sunIcon(kind) {
    return `<svg class="ic" viewBox="0 0 36 36" aria-hidden="true"><path d="M11 23.5a7 7 0 0 1 14 0z" fill="#ffd23f"/>` +
      `<g stroke="#ffd23f" stroke-width="2" stroke-linecap="round"><line x1="18" y1="11" x2="18" y2="13.5"/><line x1="9.5" y1="15" x2="11.3" y2="16.8"/><line x1="26.5" y1="15" x2="24.7" y2="16.8"/></g>` +
      `<line x1="6" y1="24.5" x2="30" y2="24.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".8"/>` +
      `<path d="${kind === 'rise' ? 'M18 33v-5m-2.5 2.5L18 28l2.5 2.5' : 'M18 28v5m-2.5-2.5L18 33l2.5-2.5'}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" opacity=".85"/></svg>`;
  }
  function renderHours() {
    const { hours, start } = S.c;
    const list = hours.slice(start, start + 25);
    const d = S.data.bm.daily || {};
    const ev = [...(d.sunrise || []).map(t => ({ t, kind: 'rise' })), ...(d.sunset || []).map(t => ({ t, kind: 'set' }))].filter(e => e.t);
    const items = [];
    list.forEach((h, k) => {
      if (k >= 24) return;
      items.push({ h, k });
      const nx = list[k + 1];
      if (!nx) return;
      for (const e of ev) {
        if (e.t > h.time && e.t < nx.time) {
          const f = (tMin(e.t) - tMin(h.time)) / 60;
          items.push({ sun: e.kind, time: e.t, t: h.t != null && nx.t != null ? h.t + (nx.t - h.t) * f : h.t });
        }
      }
    });
    const temps = items.map(it => (it.sun ? it.t : it.h.t));
    const v = nums(temps), lo = Math.min(...v), hi = Math.max(...v), CH = 30;
    const y = t => 5 + (CH - 10) * (hi === lo ? 0.5 : (hi - t) / (hi - lo));
    let path = '', dots = '';
    temps.forEach((t, i) => {
      if (t == null) return;
      const x = i * STEP + 32;
      path += (path ? 'L' : 'M') + x + ' ' + y(t).toFixed(1);
      dots += `<circle cx="${x}" cy="${y(t).toFixed(1)}" r="${items[i].sun ? 3.2 : 2.4}" fill="${items[i].sun ? '#ffd23f' : 'var(--ink)'}"/>`;
    });
    const W = items.length * STEP - 4;
    $('#hours').innerHTML = `<div class="hours-track" style="width:${W}px">
      <svg class="hcurve" width="${W}" height="${CH}" viewBox="0 0 ${W} ${CH}" aria-hidden="true"><path d="${path}" fill="none" stroke="var(--ink)" stroke-opacity=".55" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${dots}</svg>
      ${items.map(it => it.sun ? `
        <div class="hr sunev">
          <div class="hr-time">${hh(it.time)}</div>${sunIcon(it.sun)}<div class="hr-c"></div>
          <div class="hr-t sm">${it.sun === 'rise' ? 'Gün doğumu' : 'Gün batımı'}</div><div class="hr-r"></div>
        </div>` : `
        <div class="hr${it.k === 0 ? ' first' : ''}">
          <div class="hr-time">${it.k === 0 ? 'Şimdi' : hh(it.h.time) === '00:00' ? esc(shortDay(it.h.time.slice(0, 10))) : hh(it.h.time)}</div>
          ${icon(it.h.cat, it.h.isDay)}<div class="hr-c"></div>
          <div class="hr-t">${r0(it.h.t)}°</div>
          <div class="hr-r">${it.h.rainN ? DROP + it.h.rainN + '/' + it.h.n : ''}</div>
        </div>`).join('')}
    </div>`;
    const sp = $('#hours .hr-c');
    if (sp) $('#hours .hcurve').style.top = sp.offsetTop + 'px';
  }

  /* ---------- 14 gün (+ dün) ---------- */
  let showAllDays = false;
  function renderDays() {
    const { days, ms } = S.c;
    const ed = S.data.ext && S.data.ext.daily;
    let yd = null;
    if (ed && ed.time && ed.time[0] < days[0].date && ed.temperature_2m_max) {
      yd = { tx: ed.temperature_2m_max[0], tn: ed.temperature_2m_min[0], cat: cat(ed.weather_code && ed.weather_code[0]) || 'cloudy' };
    }
    const shown = showAllDays ? days : days.slice(0, 7);
    const all = nums([...shown.flatMap(d => [d.tnLo, d.txHi]), yd && yd.tn, yd && yd.tx]);
    const lo = Math.min(...all), hi = Math.max(...all);
    const pct = t => (((t - lo) / Math.max(1, hi - lo)) * 100).toFixed(1);
    const bar = (a, b, cls) => (a != null && b != null ? `<span class="${cls}" style="left:${pct(a)}%;right:${(100 - pct(b)).toFixed(1)}%"></span>` : '');
    const past = yd ? `<li><div class="day day-past" aria-label="Dün">
        <span class="day-name">Dün</span>${icon(yd.cat, true)}<span class="day-rain"></span>
        <span class="range"><span class="lo">${r0(yd.tn)}°</span><span class="track">${bar(yd.tn, yd.tx, 'core past')}</span><span>${r0(yd.tx)}°</span></span><span></span>
      </div></li>` : '';
    $('#days').innerHTML = past + shown.map((d, i) => `
      <li><button class="day" data-i="${i}" aria-pressed="${i === S.sel}">
        <span class="day-name"><span class="l">${esc(dayName(d.date, i))}</span><span class="s">${esc(i < 2 ? dayName(d.date, i) : shortDay(d.date))}</span></span>
        ${icon(d.cat, true)}
        <span class="day-rain">${d.rainN ? DROP + d.rainN + '/' + d.n : d.n && d.n < ms.length ? `<span class="mcount">${d.n} model</span>` : ''}</span>
        <span class="range">
          <span class="lo">${r0(d.tn)}°</span>
          <span class="track">${bar(d.tnLo, d.txHi, 'spread')}${bar(d.tn, d.tx, 'core')}</span>
          <span>${r0(d.tx)}°</span>
        </span>
        <span class="dot lvl-${d.lvl}" title="${LVL_TEXT[d.lvl]}"></span>
      </button></li>`).join('');
    const mb = $('#moreDays');
    mb.hidden = days.length <= 7;
    mb.textContent = showAllDays ? 'Daha az göster' : `${days.length - 7} gün daha göster`;
    mb.setAttribute('aria-expanded', String(showAllDays));
    const note = $('#horizonNote');
    const minN = Math.min(...days.map(d => d.n).filter(n => n > 0));
    note.hidden = !showAllDays || minN >= ms.length;
    note.textContent = `Modellerin bazıları 4 ile 7 gün ileriyi görüyor. İleriki günlerde ${minN} modele kadar düşüyor, güven de buna göre azalıyor.`;
  }

  /* ---------- Detay kartları ---------- */
  const fmtDur = m => `${Math.floor(m / 60)} sa ${Math.round(m % 60)} dk`;
  const tile = (title, body, wide) => `<article class="tile${wide ? ' wide' : ''}"><h3 class="tile-h">${title}</h3>${body}</article>`;
  const gbar = (p, cls) => `<div class="gbar ${cls}"><span class="mk" style="left:${Math.max(0, Math.min(100, p)).toFixed(1)}%"></span></div>`;
  function face(level) {
    const col = level === 'İyi' ? 'var(--good)' : level === 'Orta' ? 'var(--mid)' : 'var(--bad)';
    const mouth = level === 'İyi' ? 'M12 21q6 5 12 0' : level === 'Orta' ? 'M12.5 22h11' : 'M12 24q6-5 12 0';
    return `<svg viewBox="0 0 36 36" width="34" height="34" aria-hidden="true"><circle cx="18" cy="18" r="15" fill="${col}"/><circle cx="13" cy="14.5" r="1.8" fill="#1b2a38"/><circle cx="23" cy="14.5" r="1.8" fill="#1b2a38"/><path d="${mouth}" fill="none" stroke="#1b2a38" stroke-width="2" stroke-linecap="round"/></svg>`;
  }
  function leaf(on) {
    return `<svg viewBox="0 0 48 48" width="40" height="40" aria-hidden="true"><path d="M10 38C10 20 22 9 40 8c0 18-11 30-29 30z" fill="currentColor" opacity="${on ? '.9' : '.28'}"/><path d="M12 36L30 18" stroke="var(--sky1)" stroke-width="2.4" stroke-linecap="round" opacity=".6"/></svg>`;
  }
  function compass(dir, speed) {
    let ticks = '';
    for (let k = 0; k < 36; k++) {
      const a = k * 10 * RAD, r1 = k % 9 === 0 ? 41 : 44;
      ticks += `<line x1="${(60 + Math.sin(a) * r1).toFixed(1)}" y1="${(60 - Math.cos(a) * r1).toFixed(1)}" x2="${(60 + Math.sin(a) * 48).toFixed(1)}" y2="${(60 - Math.cos(a) * 48).toFixed(1)}"/>`;
    }
    const L = (t, x, y) => `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="central" font-size="11" font-weight="600" fill="currentColor">${t}</text>`;
    return `<svg class="compass" viewBox="0 0 120 120" aria-hidden="true">
      <g stroke="currentColor" stroke-opacity=".45" stroke-width="1.4">${ticks}</g>
      ${L('K', 60, 30)}${L('D', 90, 60)}${L('G', 60, 90)}${L('B', 30, 60)}
      ${dir != null ? `<g transform="rotate(${(dir + 180) % 360} 60 60)"><line x1="60" y1="104" x2="60" y2="22" stroke="var(--accent)" stroke-width="3" stroke-linecap="round"/><path d="M60 12l7 13h-14z" fill="var(--accent)"/><circle cx="60" cy="104" r="4" fill="none" stroke="var(--accent)" stroke-width="2.4"/></g>` : ''}
      <circle cx="60" cy="60" r="21" fill="var(--sky1)" stroke="currentColor" stroke-opacity=".25"/>
      <text x="60" y="57" text-anchor="middle" font-size="16" font-weight="600" fill="currentColor">${r0(speed)}</text>
      <text x="60" y="71" text-anchor="middle" font-size="9" fill="currentColor" opacity=".75">km/sa</text></svg>`;
  }
  function gauge(v) {
    const p = Math.max(0, Math.min(1, (v - 970) / 80)), a0 = 150, a1 = 390, r = 46;
    const pt = a => [60 + r * Math.cos(a * RAD), 60 + r * Math.sin(a * RAD)];
    const [sx, sy] = pt(a0), [ex, ey] = pt(a1), [mx, my] = pt(a0 + 240 * p);
    const big = 240 * p > 180 ? 1 : 0;
    return `<svg class="gauge" viewBox="0 0 120 112" aria-hidden="true">
      <path d="M${sx.toFixed(1)} ${sy.toFixed(1)}A${r} ${r} 0 1 1 ${ex.toFixed(1)} ${ey.toFixed(1)}" fill="none" stroke="currentColor" stroke-opacity=".2" stroke-width="9" stroke-linecap="round"/>
      ${p > 0.01 ? `<path d="M${sx.toFixed(1)} ${sy.toFixed(1)}A${r} ${r} 0 ${big} 1 ${mx.toFixed(1)} ${my.toFixed(1)}" fill="none" stroke="var(--accent)" stroke-width="9" stroke-linecap="round"/>` : ''}
      <circle cx="${mx.toFixed(1)}" cy="${my.toFixed(1)}" r="6.5" fill="#fff" stroke="var(--accent)" stroke-width="3"/>
      <text x="60" y="60" text-anchor="middle" font-size="18" font-weight="600" fill="currentColor">${v.toFixed(0)}</text>
      <text x="60" y="76" text-anchor="middle" font-size="10" fill="currentColor" opacity=".75">hPa</text>
      <text x="22" y="106" text-anchor="middle" font-size="9" fill="currentColor" opacity=".6">970</text><text x="98" y="106" text-anchor="middle" font-size="9" fill="currentColor" opacity=".6">1050</text></svg>`;
  }
  function moonDisc(ph) {
    const cx = 45, cy = 45, r = 36, k = ph.illum;
    let lit = '';
    if (k > 0.985) lit = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#f4f0dc"/>`;
    else if (k > 0.015) {
      const rx = (r * Math.abs(2 * k - 1)).toFixed(2);
      lit = ph.waxing
        ? `<path d="M${cx} ${cy - r}A${r} ${r} 0 0 1 ${cx} ${cy + r}A${rx} ${r} 0 0 ${k > 0.5 ? 1 : 0} ${cx} ${cy - r}z" fill="#f4f0dc"/>`
        : `<path d="M${cx} ${cy - r}A${r} ${r} 0 0 0 ${cx} ${cy + r}A${rx} ${r} 0 0 ${k > 0.5 ? 0 : 1} ${cx} ${cy - r}z" fill="#f4f0dc"/>`;
    }
    return `<svg class="moon" viewBox="0 0 90 90" aria-hidden="true"><circle cx="${cx}" cy="${cy}" r="${r}" fill="#39425a"/>${lit}
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#fff" stroke-opacity=".25"/>
      <g fill="#000" opacity=".08"><circle cx="34" cy="34" r="7"/><circle cx="56" cy="52" r="9"/><circle cx="40" cy="60" r="4"/></g></svg>`;
  }
  function renderTiles() {
    const D = S.data, c = S.c, cur = D.bm.current || {}, ext = D.ext || {}, ec = ext.current || {}, aq = (D.aq && D.aq.current) || {};
    const nowT = cur.time || c.hours[c.start].time, today = nowT.slice(0, 10), nowM = tMin(nowT);
    const out = [];

    // Koşu
    const next = c.hours.slice(c.start, c.start + 4);
    const sc = next.map(h => runScore(h.t, h.share, h.w, aq.european_aqi));
    if (sc[0] != null) {
      out.push(tile('Koşu', `<div class="run"><div><p class="big-txt">Şu anda koşu için hava <b>${runInfo(sc[0]).toLocaleLowerCase('tr-TR')}</b></p>
        <p class="muted small">Sıcaklık, yağış, rüzgâr ve hava kalitesine göre</p></div>
        <div class="run-hours">${next.slice(1).map((h, i) => `<div>${face(runInfo(sc[i + 1]))}<span class="small muted">${hh(h.time)}</span></div>`).join('')}</div></div>`, true));
    }
    // Hava kalitesi
    if (aq.european_aqi != null) {
      out.push(tile('Hava kalitesi', `<p class="big">${aqiInfo(aq.european_aqi)} <span class="unit">(${r0(aq.european_aqi)})</span></p>${gbar(aq.european_aqi, 'aqi')}
        <p class="small muted">PM2.5 ${r0(aq.pm2_5)} · PM10 ${r0(aq.pm10)} µg/m³</p>`));
    }
    // UV
    if (ec.uv_index != null) {
      const eh = ext.hourly || {};
      const rest = nums((eh.time || []).map((t, i) => (t.slice(0, 10) === today && t >= nowT.slice(0, 13) ? eh.uv_index[i] : null)));
      const restMax = rest.length ? Math.max(...rest) : ec.uv_index;
      const lvl = uvInfo(ec.uv_index);
      out.push(tile('UV endeksi', `<p class="big">${r0(ec.uv_index)} <span class="unit">${lvl}</span></p>${gbar(ec.uv_index / 11 * 100, 'uv')}
        <p class="small muted">Günün kalanında ${uvInfo(restMax).toLocaleLowerCase('tr-TR')}. ${restMax >= 6 ? 'Gölgede kal, şapka ve krem kullan.' : restMax >= 3 ? 'Öğle saatlerinde güneş kremi iyi olur.' : 'Korunma gerekmez.'}</p>`));
    }
    // Polen
    const pk = ['alder_pollen', 'birch_pollen', 'olive_pollen', 'grass_pollen', 'mugwort_pollen', 'ragweed_pollen'];
    if (pk.some(k => k in aq)) {
      const mx = keys => { const v = nums(keys.map(k => aq[k])); return v.length ? Math.max(...v) : null; };
      const items = [['Ağaç', mx(['alder_pollen', 'birch_pollen', 'olive_pollen'])], ['Çimen', mx(['grass_pollen'])], ['Yabani ot', mx(['mugwort_pollen', 'ragweed_pollen'])]];
      out.push(tile('Polen', `<div class="pollen">${items.map(([n, v]) => `<div>${leaf(v >= 1)}<b>${pollenInfo(v)}</b><span class="small muted">${n}</span></div>`).join('')}</div>`, true));
    }
    // Nem
    if (cur.relative_humidity_2m != null) {
      const eh = ext.hourly || {};
      const yT = (eh.time || []).find(t => t.slice(0, 10) < today && t.slice(11, 13) === nowT.slice(11, 13));
      const yv = yT != null ? eh.relative_humidity_2m[eh.time.indexOf(yT)] : null;
      const cmp = yv == null ? '' : cur.relative_humidity_2m - yv > 5 ? 'Dünden daha yüksek' : yv - cur.relative_humidity_2m > 5 ? 'Dünden daha düşük' : 'Dünle aynı seviyede';
      out.push(tile('Nem', `<p class="big">%${r0(cur.relative_humidity_2m)}</p><div class="hbar"><span style="width:${cur.relative_humidity_2m}%"></span></div>
        <p class="small muted">${cmp}${yv != null ? ` (dün bu saatte %${r0(yv)})` : ''}</p>`));
    }
    // Çiy noktası
    if (ec.dew_point_2m != null) {
      out.push(tile('Çiy noktası', `<p class="big">${r0(ec.dew_point_2m)}°</p><p class="small">${dewInfo(ec.dew_point_2m)}</p>
        <p class="small muted">Hava bu sıcaklığa inerse çiy ya da sis oluşur.</p>`));
    }
    // Rüzgâr
    if (cur.wind_speed_10m != null) {
      const dir = ec.wind_direction_10m;
      out.push(tile('Rüzgâr', `${compass(dir, cur.wind_speed_10m)}<p class="small">${windInfo(cur.wind_speed_10m)}${dir != null ? ', ' + windFrom(dir).toLocaleLowerCase('tr-TR') + ' esiyor' : ''}</p>
        ${ec.wind_gusts_10m != null ? `<p class="small muted">Hamleler ${r0(ec.wind_gusts_10m)} km/sa</p>` : ''}`));
    }
    // Basınç
    if (ec.pressure_msl != null) {
      const eh = ext.hourly || {}, i0 = (eh.time || []).indexOf(nowT.slice(0, 13) + ':00');
      const dp = i0 >= 3 && eh.pressure_msl ? eh.pressure_msl[i0] - eh.pressure_msl[i0 - 3] : null;
      const tr = dp == null ? '' : Math.abs(dp) < 0.7 ? 'Sabit seyrediyor' : `${Math.abs(dp) >= 2 ? 'Hızla ' : ''}${dp > 0 ? 'yükseliyor' : 'düşüyor'}`;
      out.push(tile('Basınç', `${gauge(ec.pressure_msl)}<p class="small">${tr ? tr.charAt(0).toLocaleUpperCase('tr-TR') + tr.slice(1) : ''}${dp != null ? ` (3 saatte ${dp > 0 ? '+' : ''}${dp.toFixed(1)})` : ''}</p>
        <p class="small muted">${dp != null && dp <= -2 ? 'Hızlı düşüş kötüleşen havaya işaret edebilir.' : dp != null && dp >= 2 ? 'Yükselen basınç genelde açılan hava demek.' : ''}</p>`));
    }
    // Görünürlük
    if (ec.visibility != null) {
      const km = ec.visibility / 1000;
      out.push(tile('Görünürlük', `<p class="big">${km >= 10 ? km.toFixed(0) : km.toFixed(1)} <span class="unit">km</span></p><p class="small">${visInfo(km)}</p>`));
    }
    // Hissedilen
    if (cur.apparent_temperature != null && cur.temperature_2m != null) {
      const df = cur.apparent_temperature - cur.temperature_2m;
      const why = df <= -2 ? (cur.wind_speed_10m > 10 ? 'Rüzgâr yüzünden olduğundan daha soğuk hissettiriyor.' : 'Olduğundan daha soğuk hissettiriyor.')
        : df >= 2 ? (cur.relative_humidity_2m > 60 ? 'Nem yüzünden olduğundan daha sıcak hissettiriyor.' : 'Güneş ve durgun hava yüzünden daha sıcak hissettiriyor.')
        : 'Gerçek sıcaklığa yakın hissettiriyor.';
      out.push(tile('Hissedilen', `<p class="big">${r0(cur.apparent_temperature)}°</p><p class="small">${why}</p>
        <p class="small muted">Gerçek sıcaklık ${r0(cur.temperature_2m)}°</p>`));
    }
    // Güneş
    const bd = D.bm.daily || {}, di = (bd.time || []).indexOf(today);
    if (di >= 0 && bd.sunrise && bd.sunset) {
      const rise = bd.sunrise[di], set = bd.sunset[di], rM = tMin(rise), sM = tMin(set);
      const f = (nowM - rM) / (sM - rM), up = f >= 0 && f <= 1;
      const th = Math.PI * (1 - Math.max(0, Math.min(1, f)));
      const sx = 150 + 130 * Math.cos(th), sy = 92 - 72 * Math.sin(th);
      let msg;
      if (f < 0) msg = `Gün doğumuna ${fmtDur(rM - nowM)} var`;
      else if (up) msg = `Gün batımına ${fmtDur(sM - nowM)} var`;
      else { const nr = bd.sunrise[di + 1]; msg = `Güneş battı${nr ? `. Yarın ${hh(nr)}'de doğacak` : ''}`; }
      out.push(tile('Güneş', `<p class="big-txt">${msg}</p>
        <svg class="sunarc" viewBox="0 0 300 112" aria-hidden="true">
          <line x1="8" y1="92" x2="292" y2="92" stroke="currentColor" stroke-opacity=".35" stroke-width="1.5"/>
          <path d="M20 92A130 72 0 0 1 280 92" fill="none" stroke="currentColor" stroke-opacity=".35" stroke-width="2" stroke-dasharray="4 5"/>
          ${up ? `<path d="M20 92A130 72 0 0 1 ${sx.toFixed(1)} ${sy.toFixed(1)}" fill="none" stroke="#ffd23f" stroke-width="3" stroke-linecap="round"/>` : ''}
          <circle cx="${sx.toFixed(1)}" cy="${(up ? sy : 92).toFixed(1)}" r="9" fill="#ffd23f" ${up ? '' : 'opacity=".45"'}/>
        </svg>
        <div class="sun-times"><span><b>${hh(rise)}</b><span class="small muted">Gün doğumu</span></span>
          <span class="small muted">Gün uzunluğu ${fmtDur(sM - rM)}</span>
          <span><b>${hh(set)}</b><span class="small muted">Gün batımı</span></span></div>`, true));
    }
    // Ay
    {
      const ph = moonPhase(Date.now());
      const off = D.bm.utc_offset_seconds || 0;
      const mt = moonTimes(today, off, S.loc.lat, S.loc.lon);
      const SYN = 29.530588853;
      const toFull = ((0.5 - ph.frac + 1) % 1) * SYN, toNew = ((1 - ph.frac) % 1) * SYN;
      const nxt = ph.name === 'Dolunay' ? `Yeni aya ${Math.round(toNew)} gün` : ph.name === 'Yeni Ay' ? `Dolunaya ${Math.round(toFull)} gün`
        : toFull < 1.5 ? 'Dolunay yarın' : `Dolunaya ${Math.round(toFull)} gün`;
      out.push(tile('Ay', `<div class="moonrow">${moonDisc(ph)}
        <div><p class="big-txt"><b>${ph.name}</b></p><p class="small muted">%${Math.round(ph.illum * 100)} aydınlık · ${nxt}</p>
          <div class="moon-times"><span><span class="small muted">Ay doğuşu</span><b>${mt.rise || '–'}</b></span><span><span class="small muted">Ay batışı</span><b>${mt.set || '–'}</b></span></div></div></div>`, true));
    }
    $('#tiles').innerHTML = out.join('');
  }

  /* ---------- Doğruluk karnesi ---------- */
  const MODEL_BY_ID = Object.fromEntries(MODELS.map(m => [m.id, m]));
  async function loadCard() {
    try {
      const card = await getJSON('data/scorecard.json?v=' + Math.floor(Date.now() / 36e5), 10000);
      if (card && Array.isArray(card.cities)) { S.card = card; store.set('hh.card', card); }
    } catch (e) { /* çevrimdışı ya da dosya yok: önbellekteki karne kullanılır */ }
    if (S.data) render(); else renderKarne();
  }
  function renderKarne() {
    const el = $('#karne'), where = $('#karneWhere');
    const card = S.card;
    const near = card && nearestCity(card.cities, S.loc);
    if (!near) {
      where.textContent = '';
      el.innerHTML = '<p>Her gün modellerin tahminleri kaydedilip ertesi gün havalimanı ölçümleriyle karşılaştırılıyor.</p><p class="muted small">Karne verisi şu an yüklenemedi.</p>';
      return;
    }
    const c = near.city, km = Math.round(near.km);
    where.textContent = `${c.name} · ${c.stationName}`;
    const best = (c.models || []).find(m => m.id !== 'ortak');
    $('#karneTeaser').textContent = c.days && best
      ? `${c.name} için en isabetli: ${(MODEL_BY_ID[best.id] || { name: best.id }).name} (±${best.mae.toFixed(1)}°)`
      : 'Ölçüm birikiyor, ilk sonuçlar yarın';
    const farNote = km > KARNE_MAX_KM
      ? `<p class="muted small">Bulunduğun yere en yakın ölçüm noktası ${esc(c.name)} (${km} km). Bu bölge için ağırlıklandırma yapılmıyor.</p>` : '';
    if (!c.days) {
      el.innerHTML = `<p>Her gün 8 modelin tahmini kaydediliyor ve ertesi gün ${esc(c.stationName)} ölçümleriyle karşılaştırılıyor.</p>
        <p class="muted small">Ölçüm birikiyor. İlk sonuçlar yarın sabah burada görünecek.</p>${farNote}`;
      return;
    }
    const worst = Math.max(...c.models.map(m => m.mae), 1);
    const rows = c.models.map((m, k) => {
      const meta = m.id === 'ortak' ? { name: 'Ortak görüş (medyan)', org: 'Tüm modeller', color: 'var(--ink)' } : (MODEL_BY_ID[m.id] || { name: m.id, org: '', color: '#ccc' });
      return `<tr${m.id === 'ortak' ? ' class="cons"' : ''}>
        <td><span class="mname"><b class="rank">${k + 1}</b><i style="background:${meta.color}"></i><span>${esc(meta.name)}<small>${esc(meta.org)}</small></span></span></td>
        <td><span class="err"><span class="errbar"><span style="width:${(100 * m.mae / worst).toFixed(0)}%"></span></span>±${m.mae.toFixed(1)}°</span></td>
        <td>${m.rainHit == null ? '–' : '%' + m.rainHit}</td></tr>`;
    }).join('');
    const leadTxt = c.lead === 'lead1' ? '1 gün önceden yapılan tahminler' : 'aynı gün yapılan tahminler';
    const wNote = S.w
      ? `<p class="small"><b>Ağırlıklı ortak görüş açık:</b> sıcaklıkta isabetli modeller daha çok söz sahibi.</p>`
      : km <= KARNE_MAX_KM ? `<p class="muted small">${KARNE_MIN_DAYS} gün dolunca ortak görüş isabetli modellere daha çok ağırlık verecek (${Math.min(c.days, KARNE_MIN_DAYS)}/${KARNE_MIN_DAYS}).</p>` : '';
    el.innerHTML = `<p class="muted small">Son ${c.days} gün, ${leadTxt}. Sıcaklık hatası: tahmin ile ölçüm arasındaki ortalama fark (küçük olan iyi). Yağış isabeti: "yağacak mı" sorusunu doğru bilen günlerin oranı.</p>
      <div class="scroll"><table class="mtable karne"><thead><tr><th>Model</th><th>Sıcaklık hatası</th><th>Yağış isabeti</th></tr></thead><tbody>${rows}</tbody></table></div>
      ${wNote}${farNote}`;
  }

  /* ---------- 48 saatlik grafik ---------- */
  let chartK = 0;
  function drawChart() {
    const svg = $('#chart');
    if (!S.c) return;
    const W = svg.clientWidth, Hh = svg.clientHeight;
    if (!W || !Hh) return;
    const { hours, ms, start } = S.c;
    const N = Math.min(48, hours.length - start);
    if (N < 2) { svg.innerHTML = ''; return; }
    const idx = Array.from({ length: N }, (_, k) => start + k);
    const all = [];
    ms.forEach(m => idx.forEach(i => { const v = m.h.t[i]; if (v != null) all.push(v); }));
    if (!all.length) { svg.innerHTML = ''; return; }
    const lo = Math.floor(Math.min(...all)) - 1, hi = Math.ceil(Math.max(...all)) + 1;
    const narrow = W < 520;
    const padL = 34, padR = 10, top = 10, rainH = 34, gap = 26, bottom = 22;
    const plotB = Hh - bottom - rainH - gap;
    const x = k => padL + (W - padL - padR) * k / (N - 1);
    const y = v => top + (plotB - top) * (hi - v) / (hi - lo);
    const step = [1, 2, 5, 10].find(s => (hi - lo) / s <= 5) || 10;
    let out = '';
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      out += `<line x1="${padL}" x2="${W - padR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="var(--line)"/>` +
             `<text x="${padL - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" font-size="12" fill="var(--muted)">${v}°</text>`;
    }
    const every = narrow ? 12 : 6;
    idx.forEach((i, k) => {
      const hr = +hours[i].time.slice(11, 13);
      if (hr % every === 0) {
        const lab = hr === 0 ? shortDay(hours[i].time.slice(0, 10)) : hours[i].time.slice(11, 16);
        out += `<line x1="${x(k).toFixed(1)}" x2="${x(k).toFixed(1)}" y1="${top}" y2="${Hh - bottom}" stroke="var(--line)" stroke-dasharray="${hr === 0 ? '0' : '2 4'}"/>` +
               `<text x="${x(k).toFixed(1)}" y="${Hh - 6}" text-anchor="middle" font-size="12" fill="var(--muted)">${esc(lab)}</text>`;
      }
    });
    const path = arr => {
      let d = '', pen = false;
      idx.forEach((i, k) => {
        const v = arr[i];
        if (v == null) { pen = false; return; }
        d += (pen ? 'L' : 'M') + x(k).toFixed(1) + ' ' + y(v).toFixed(1);
        pen = true;
      });
      return d;
    };
    ms.forEach(m => { out += `<path d="${path(m.h.t)}" fill="none" stroke="${m.color}" stroke-width="1.6" stroke-opacity=".75" stroke-linejoin="round"/>`; });
    out += `<path d="${path(hours.map(h => h.t))}" fill="none" stroke="var(--ink)" stroke-width="3.2" stroke-linejoin="round" stroke-linecap="round"/>`;
    // Yağış uyumu çubukları
    const rb = Hh - bottom, bw = Math.max(2, (W - padL - padR) / N - 2);
    out += `<text x="${padL}" y="${rb - rainH - 6}" font-size="12" fill="var(--muted)">Yağış bekleyen model oranı</text>`;
    idx.forEach((i, k) => {
      const h = hours[i];
      const bh = Math.max(h.share > 0 ? 2 : 0, h.share * rainH);
      out += `<rect x="${(x(k) - bw / 2).toFixed(1)}" y="${(rb - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="1.5" fill="var(--rain)" fill-opacity="${(0.35 + 0.65 * h.share).toFixed(2)}"/>`;
    });
    out += `<line id="cursor" x1="0" x2="0" y1="${top}" y2="${rb}" stroke="var(--ink)" stroke-width="1.2" stroke-opacity=".7"/>` +
           `<rect id="hit" x="${padL}" y="0" width="${W - padL - padR}" height="${Hh}" fill="transparent"/>`;
    svg.innerHTML = out;
    const setK = k => {
      chartK = Math.max(0, Math.min(N - 1, k));
      const c = svg.querySelector('#cursor');
      c.setAttribute('x1', x(chartK).toFixed(1)); c.setAttribute('x2', x(chartK).toFixed(1));
      readout(idx[chartK]);
    };
    svg.querySelector('#hit').addEventListener('pointermove', e => {
      const r = svg.getBoundingClientRect();
      setK(Math.round(((e.clientX - r.left - padL) / (W - padL - padR)) * (N - 1)));
    });
    setK(Math.min(chartK, N - 1));
  }
  function readout(i) {
    const { hours, ms } = S.c, h = hours[i];
    const when = `${dayName(h.time.slice(0, 10), Math.round((new Date(h.time.slice(0, 10)) - new Date(hours[S.c.start].time.slice(0, 10))) / 864e5))} ${hh(h.time)}`;
    $('#readout').innerHTML = `<span><b>${esc(when)}</b></span><span><b>Ortak ${r0(h.t)}°</b></span>` +
      ms.map(m => {
        const t = m.h.t[i], p = m.h.p[i];
        return `<span><i style="background:${m.color}"></i>${esc(m.name)} ${r0(t)}°${p != null && p >= RAIN_H ? ' · ' + p.toFixed(1) + ' mm' : ''}</span>`;
      }).join('');
  }

  /* ---------- Tema ---------- */
  const THEMES = [['auto', 'Otomatik'], ['clear', 'Güneşli'], ['clear-n', 'Gece'], ['partly', 'Parçalı'], ['cloudy', 'Bulutlu'],
    ['rain', 'Yağmurlu'], ['storm', 'Fırtına'], ['snow', 'Karlı'], ['fog', 'Sisli']];
  function applyTheme() {
    let sky = 'clear', night = false;
    if (S.theme === 'auto') {
      const cur = S.data && S.data.bm.current;
      if (cur) { sky = cat(cur.weather_code) || 'clear'; night = cur.is_day === 0; }
    } else if (S.theme === 'clear-n') { sky = 'clear'; night = true; }
    else sky = S.theme;
    document.body.dataset.sky = sky;
    document.body.dataset.night = night ? '1' : '0';
    const col = getComputedStyle(document.body).getPropertyValue('--sky1').trim();
    document.querySelector('meta[name=theme-color]').setAttribute('content', col || '#1d74d6');
    Sky.set(sky, night);
    $('#themeChips').querySelectorAll('.chip').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.t === S.theme)));
  }

  /* ---------- Canlı gökyüzü ---------- */
  const Sky = (() => {
    const cv = $('#sky'), ctx = cv.getContext('2d');
    const reduce = matchMedia('(prefers-reduced-motion: reduce)');
    let W = 0, H = 0, kind = '', night = false, raf = 0, last = 0, flash = 0;
    let drops = [], flakes = [], stars = [], clouds = [], mists = [];
    const R = (a, b) => a + Math.random() * (b - a);
    function seed() {
      const area = (W * H) / (1280 * 800);
      drops = []; flakes = []; stars = []; clouds = []; mists = [];
      if (kind === 'rain' || kind === 'storm') for (let i = 0; i < Math.round(170 * area) + 40; i++) drops.push({ x: R(0, W), y: R(-H, H), l: R(10, 22), v: R(650, 950) });
      if (kind === 'snow') for (let i = 0; i < Math.round(110 * area) + 30; i++) flakes.push({ x: R(0, W), y: R(-H, H), r: R(1.2, 3.4), v: R(25, 70), ph: R(0, 6.28) });
      if (night && (kind === 'clear' || kind === 'partly')) for (let i = 0; i < Math.round(140 * area) + 40; i++) stars.push({ x: R(0, W), y: R(0, H * 0.7), r: R(0.5, 1.6), ph: R(0, 6.28), sp: R(0.6, 2) });
      const nc = { partly: 4, cloudy: 7, rain: 6, storm: 6, fog: 3, snow: 4 }[kind] || 0;
      for (let i = 0; i < nc; i++) clouds.push({ x: R(-200, W), y: R(H * 0.03, H * 0.45), s: R(50, 120) * (W < 600 ? 0.7 : 1), v: R(6, 18) });
      if (kind === 'fog') for (let i = 0; i < 6; i++) mists.push({ y: R(H * 0.2, H), h: R(60, 160), x: R(0, W), v: R(8, 20) });
    }
    function resize() {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      W = innerWidth; H = innerHeight;
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed();
      if (reduce.matches) frame(performance.now());
    }
    function cloud(x, y, s, a) {
      ctx.fillStyle = `rgba(255,255,255,${a})`;
      ctx.beginPath();
      [[0, 0, 0.55], [0.5, -0.2, 0.42], [-0.5, -0.05, 0.38], [0.95, 0.08, 0.32], [-0.9, 0.12, 0.28]]
        .forEach(([dx, dy, r]) => { ctx.moveTo(x + dx * s + r * s, y + dy * s); ctx.arc(x + dx * s, y + dy * s, r * s, 0, 6.2832); });
      ctx.fill();
    }
    function frame(ts) {
      const dt = Math.min(0.05, (ts - (last || ts)) / 1000); last = ts;
      const t = ts / 1000;
      ctx.clearRect(0, 0, W, H);
      if (kind === 'clear' && !night) {
        const r = Math.max(W, H) * (0.42 + 0.02 * Math.sin(t * 0.6));
        const g = ctx.createRadialGradient(W * 0.85, H * 0.08, 0, W * 0.85, H * 0.08, r);
        g.addColorStop(0, 'rgba(255,236,160,.75)'); g.addColorStop(0.18, 'rgba(255,220,120,.30)'); g.addColorStop(1, 'rgba(255,220,120,0)');
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      }
      if (night && (kind === 'clear' || kind === 'partly')) {
        const g = ctx.createRadialGradient(W * 0.82, H * 0.12, 0, W * 0.82, H * 0.12, Math.max(W, H) * 0.3);
        g.addColorStop(0, 'rgba(240,235,200,.22)'); g.addColorStop(1, 'rgba(240,235,200,0)');
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
        for (const s of stars) {
          ctx.globalAlpha = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * s.sp + s.ph));
          ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, 6.2832); ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
      const ca = { partly: 0.55, cloudy: 0.32, rain: 0.13, storm: 0.1, fog: 0.35, snow: 0.4 }[kind] || 0;
      for (const c of clouds) {
        c.x += c.v * dt; if (c.x - c.s * 1.6 > W) c.x = -c.s * 1.6;
        cloud(c.x, c.y, c.s, night ? ca * 0.35 : ca);
      }
      for (const m of mists) {
        m.x += m.v * dt; if (m.x > W) m.x -= W;
        const g = ctx.createLinearGradient(0, m.y - m.h / 2, 0, m.y + m.h / 2);
        g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, `rgba(255,255,255,${night ? 0.1 : 0.28})`); g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(m.x - W, m.y - m.h / 2, W * 0.8, m.h); ctx.fillRect(m.x + 0.1 * W, m.y - m.h / 2, W * 0.7, m.h);
      }
      if (drops.length) {
        ctx.strokeStyle = kind === 'storm' ? 'rgba(200,195,255,.45)' : 'rgba(190,220,255,.5)';
        ctx.lineWidth = 1.2; ctx.lineCap = 'round'; ctx.beginPath();
        for (const d of drops) {
          d.y += d.v * dt; d.x -= d.v * 0.18 * dt;
          if (d.y > H) { d.y = R(-60, -10); d.x = R(0, W * 1.2); }
          ctx.moveTo(d.x, d.y); ctx.lineTo(d.x + d.l * 0.18, d.y - d.l);
        }
        ctx.stroke();
      }
      if (flakes.length) {
        ctx.fillStyle = night ? 'rgba(255,255,255,.85)' : 'rgba(255,255,255,.95)';
        ctx.beginPath();
        for (const f of flakes) {
          f.y += f.v * dt; f.x += Math.sin(t + f.ph) * 18 * dt;
          if (f.y > H + 5) { f.y = -5; f.x = R(0, W); }
          ctx.moveTo(f.x + f.r, f.y); ctx.arc(f.x, f.y, f.r, 0, 6.2832);
        }
        ctx.fill();
      }
      if (kind === 'storm' && !reduce.matches) {
        if (flash < 0.02 && Math.random() < dt * 0.18) flash = 1;
        if (flash > 0.02) { ctx.fillStyle = `rgba(235,230,255,${flash * 0.45})`; ctx.fillRect(0, 0, W, H); flash *= Math.pow(0.02, dt); }
      }
      if (!reduce.matches && !document.hidden) raf = requestAnimationFrame(frame);
    }
    function start() { cancelAnimationFrame(raf); last = 0; raf = requestAnimationFrame(frame); }
    addEventListener('resize', resize);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) start(); });
    reduce.addEventListener && reduce.addEventListener('change', start);
    return {
      set(k, n) { if (k === kind && n === night && W) return; kind = k; night = n; if (!W) resize(); else seed(); start(); },
    };
  })();

  /* ---------- Konum ve arama ---------- */
  function setLoc(loc, dir = 0) {
    S.loc = loc; store.set('hh.loc', loc);
    $('#placeName').textContent = loc.name;
    toggleSearch(false);
    S.sel = 0;
    const c = cacheGet(loc);
    slide(dir, () => {
      if (c) { S.data = c; try { render(); } catch (e) { console.error(e); showLoading(loc); } }
      else showLoading(loc);
      renderFavs();
    });
    window.scrollTo({ top: 0 });
    refresh(!!c);
  }
  function showLoading(loc) {
    S.data = null; S.c = null;
    $('#nowIcon').innerHTML = ''; $('#nowTemp').textContent = '--';
    $('#nowDesc').textContent = 'Yükleniyor…'; $('#nowMeta').textContent = '';
    $('#conf').hidden = true;
    $('#verdictText').textContent = `${loc.name} için modeller soruluyor…`;
    $('#verdictSub').textContent = '';
    $('#hours').innerHTML = ''; $('#days').innerHTML = '';
  }
  // Konum değişirken içerik kayarak çıkar, karşı taraftan girer
  function slide(dir, fn) {
    const m = document.querySelector('main');
    if (!dir || matchMedia('(prefers-reduced-motion: reduce)').matches) { m.style.transform = ''; m.style.opacity = ''; fn(); return; }
    m.style.transition = 'transform .15s ease-in, opacity .15s ease-in';
    m.style.transform = `translateX(${-dir * 40}px)`; m.style.opacity = '0';
    setTimeout(() => {
      fn();
      m.style.transition = 'none'; m.style.transform = `translateX(${dir * 40}px)`;
      void m.offsetWidth;
      m.style.transition = 'transform .22s ease-out, opacity .22s ease-out';
      m.style.transform = ''; m.style.opacity = '';
    }, 150);
  }
  function bounce(dir) {
    const m = document.querySelector('main');
    m.style.transition = 'transform .12s ease-out'; m.style.transform = `translateX(${-dir * 18}px)`;
    setTimeout(() => { m.style.transition = 'transform .2s ease-out'; m.style.transform = ''; }, 120);
  }
  function toggleSearch(open) {
    const el = $('#search'); el.hidden = !open;
    $('#placeBtn').setAttribute('aria-expanded', String(open));
    renderFavs();
    if (open) { $('#searchInput').focus(); }
  }
  let searchT = 0, searchSeq = 0;
  async function search(q) {
    q = q.trim();
    const ul = $('#results');
    if (q.length < 2) { ul.innerHTML = ''; return; }
    const seq = ++searchSeq;
    try {
      const d = await getJSON(GEO + '?' + qs({ name: q, count: 8, language: 'tr', format: 'json' }), 10000);
      if (seq !== searchSeq) return;
      const rs = d.results || [];
      S.results = rs;
      ul.innerHTML = rs.length ? rs.map((r, i) => `<li><button type="button" data-i="${i}">${esc(r.name)}<small>${esc([r.admin1, r.country].filter(Boolean).join(', '))}</small></button></li>`).join('')
        : '<li class="muted small" style="padding:10px 12px">Sonuç bulunamadı</li>';
    } catch (e) { if (seq === searchSeq) ul.innerHTML = '<li class="muted small" style="padding:10px 12px">Arama yapılamadı</li>'; }
  }

  /* ---------- Favori konumlar ve kaydırarak gezilen sayfalar ---------- */
  S.favs = (store.get('hh.favs') || []).filter(f => f && isFinite(f.lat) && isFinite(f.lon));
  S.favTemps = {};
  S.gps = store.get('hh.gps'); // son bilinen konum
  function locKey(l) { return l && isFinite(l.lat) && isFinite(l.lon) ? (+l.lat).toFixed(2) + ',' + (+l.lon).toFixed(2) : 'gps?'; }
  const isFav = l => S.favs.some(f => locKey(f) === locKey(l));
  function saveFavs() { store.set('hh.favs', S.favs); }
  // Favori varsa sayfalar: [Konumum, ...favoriler]
  function pages() { return S.favs.length ? [S.gps || { name: 'Konumum', gps: true, lat: NaN, lon: NaN }, ...S.favs] : []; }
  function pageIndex() {
    const ps = pages();
    if (!ps.length) return -1;
    if (S.loc.gps) return 0;
    return ps.findIndex((p, i) => i > 0 && locKey(p) === locKey(S.loc));
  }
  function toggleFav() {
    if (!isFinite(S.loc.lat)) return;
    if (isFav(S.loc)) {
      S.favs = S.favs.filter(f => locKey(f) !== locKey(S.loc));
      toast(`${S.loc.name} favorilerden çıkarıldı`);
    } else {
      if (S.favs.length >= 12) { toast('En fazla 12 favori eklenebilir'); return; }
      S.favs.push({ name: S.loc.name, region: S.loc.gps ? '' : S.loc.region || '', lat: S.loc.lat, lon: S.loc.lon });
      if (!store.get('hh.hint')) { toast('İpucu: sağa sola kaydırarak konumlar arasında geçebilirsin'); store.set('hh.hint', 1); }
      else toast(`${S.loc.name} favorilere eklendi`);
      loadFavTemps();
    }
    saveFavs(); renderFavs();
  }
  const NAV = '<svg class="nav" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M20 4L4 11l7 2 2 7z" fill="currentColor"/></svg>';
  function favChip(p, i, cur) {
    const tt = isFinite(p.lat) ? S.favTemps[locKey(p)] : null;
    const label = i === 0 ? (S.gps ? S.gps.name : 'Konumum') : p.name;
    return `<button class="fav${i === 0 ? ' gps' : ''}" type="button" data-p="${i}" aria-current="${i === cur}"${i === 0 ? ' aria-label="Bulunduğun konum: ' + esc(label) + '"' : ''}>` +
      (i === 0 ? NAV : '') + (tt ? icon(tt.cat, tt.day) : '') + `<span>${esc(label)}</span>` + (tt ? `<span class="ft">${r0(tt.t)}°</span>` : '') + '</button>';
  }
  function renderFavs() {
    const fb = $('#favBtn'), on = isFav(S.loc);
    fb.setAttribute('aria-pressed', String(on));
    fb.setAttribute('aria-label', on ? 'Favorilerden çıkar' : 'Favorilere ekle');
    const ps = pages(), cur = pageIndex();
    const row = $('#favRow');
    row.hidden = !ps.length;
    row.innerHTML = ps.map((p, i) => favChip(p, i, cur)).join('');
    const act = row.querySelector('[aria-current="true"]');
    if (act) row.scrollTo({ left: act.offsetLeft - (row.clientWidth - act.offsetWidth) / 2, behavior: 'smooth' });
    $('#favManage').hidden = !S.favs.length;
    $('#favList').innerHTML = S.favs.map((f, i) => `<li class="fav-item">
      <button type="button" data-fi="${i}">${esc(f.name)}<small>${esc(f.region || '')}</small></button>
      <button type="button" class="fav-del" data-del="${i}" aria-label="${esc(f.name)} favorisini sil">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>
      </button></li>`).join('');
  }
  // Tüm sayfaların anlık sıcaklığı tek istekte
  async function loadFavTemps() {
    const list = pages().filter(p => isFinite(p.lat));
    if (!list.length) return;
    try {
      const d = await getJSON(API + '?' + qs({
        latitude: list.map(f => f.lat).join(','), longitude: list.map(f => f.lon).join(','),
        current: 'temperature_2m,weather_code,is_day', timezone: 'auto' }), 10000);
      const arr = Array.isArray(d) ? d : [d];
      arr.forEach((x, i) => {
        const f = list[i];
        if (f && x && x.current) S.favTemps[locKey(f)] = { t: x.current.temperature_2m, cat: cat(x.current.weather_code) || 'cloudy', day: x.current.is_day !== 0 };
      });
      renderFavs();
    } catch (e) { /* sıcaklıklar gösterilmez, şerit yine çalışır */ }
  }

  /* ---------- Konum başına önbellek: kaydırınca anında göster ---------- */
  function cacheGet(loc) {
    const all = store.get('hh.caches') || {};
    const c = all[locKey(loc)];
    return c && c.bm && c.models ? c : null;
  }
  function cachePut(data) {
    const all = store.get('hh.caches') || {};
    all[locKey(data.loc)] = data;
    const keep = new Set([...pages().map(locKey), locKey(S.loc)]);
    for (const k of Object.keys(all)) if (!keep.has(k)) delete all[k];
    if (!store.set('hh.caches', all)) store.set('hh.caches', { [locKey(data.loc)]: data });
  }

  /* ---------- Bulunduğun konum ---------- */
  function locateRaw() {
    return new Promise(res => {
      if (!navigator.geolocation) { res(null); return; }
      navigator.geolocation.getCurrentPosition(
        p => res({ lat: +p.coords.latitude.toFixed(4), lon: +p.coords.longitude.toFixed(4) }),
        () => res(null), { timeout: 8000, maximumAge: 300000 });
    });
  }
  async function reverseName(c) {
    try {
      const d = await getJSON(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${c.lat}&longitude=${c.lon}&localityLanguage=tr`, 6000);
      return (d && (d.locality || d.city || d.principalSubdivision)) || null;
    } catch (e) { return null; }
  }
  async function gpsLocate() {
    const c = await locateRaw();
    if (!c) return null;
    const name = await reverseName(c);
    const loc = { name: name || 'Konumum', region: 'Bulunduğun yer', lat: c.lat, lon: c.lon, gps: true };
    S.gps = loc; store.set('hh.gps', loc);
    return loc;
  }
  // GPS sayfasını aç: bilinen konumla hemen, sonra taze konumla güncelle
  function openGps(dir) {
    if (S.gps) {
      setLoc(S.gps, dir);
      gpsLocate().then(l => {
        if (!l || !S.loc.gps) return;
        if (distKm(l, S.loc) > 1) setLoc(l, 0);
        else { S.loc = l; store.set('hh.loc', l); $('#placeName').textContent = l.name; renderFavs(); }
      });
    } else {
      toast('Konumun bulunuyor…');
      gpsLocate().then(l => { if (l) setLoc(l, dir); else toast('Konum alınamadı. İzin verdiğinden emin ol.'); });
    }
  }
  function goPage(i, dir) {
    const p = pages()[i];
    if (!p) return;
    if (i === 0) openGps(dir); else setLoc({ ...p }, dir);
  }
  function swipe(dir) {
    const ps = pages();
    if (ps.length < 2) return;
    const cur = pageIndex();
    const target = cur < 0 ? (dir > 0 ? 0 : ps.length - 1) : cur + dir;
    if (target < 0 || target >= ps.length) { bounce(dir); return; }
    goPage(target, dir);
  }
  // Sağa / sola kaydırma
  {
    let x0 = 0, y0 = 0, lx = 0, ly = 0, t0 = 0, on = false, horiz = null;
    const main = document.querySelector('main');
    document.addEventListener('touchstart', e => {
      on = e.touches.length === 1 && pages().length > 1 && !document.body.classList.contains('drawer-open') &&
        !e.target.closest('.drawer, .hours, .fav-row, .search, .scroll, .fig, .day-chips, input, .themes');
      if (!on) return;
      x0 = lx = e.touches[0].clientX; y0 = ly = e.touches[0].clientY; t0 = Date.now(); horiz = null;
    }, { passive: true });
    document.addEventListener('touchmove', e => {
      if (!on) return;
      lx = e.touches[0].clientX; ly = e.touches[0].clientY;
      const dx = lx - x0, dy = ly - y0;
      if (horiz === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) horiz = Math.abs(dx) > Math.abs(dy) * 1.4;
      if (horiz) { main.style.transition = 'none'; main.style.transform = `translateX(${dx * 0.3}px)`; }
    }, { passive: true });
    const end = () => {
      if (!on) return;
      on = false;
      const dx = lx - x0, dy = ly - y0;
      if (horiz && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.4 && Date.now() - t0 < 900) swipe(dx < 0 ? 1 : -1);
      else if (horiz) { main.style.transition = 'transform .2s ease-out'; main.style.transform = ''; }
    };
    document.addEventListener('touchend', end);
    document.addEventListener('touchcancel', end);
    document.addEventListener('keydown', e => {
      if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || document.body.classList.contains('drawer-open') || e.target.closest('input, .tabs, .hours, .fav-row')) return;
      swipe(e.key === 'ArrowRight' ? 1 : -1);
    });
  }

  /* ---------- Yan panel (ayrıntılar) ---------- */
  const drawer = $('#drawer'), backdrop = $('#backdrop');
  let lastFocus = null;
  function setTab(name) {
    document.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
    document.querySelectorAll('.panel').forEach(p => { p.hidden = p.id !== 'panel-' + name; });
    $('#drawerTitle').textContent = { models: 'Hakem masası', chart: '48 saat grafiği', karne: 'Doğruluk karnesi' }[name];
    $('#drawerBody').scrollTop = 0;
    if (name === 'chart') requestAnimationFrame(drawChart);
  }
  function openDrawer(tab) {
    if (!S.c && tab !== 'karne') { toast('Veriler henüz yüklenmedi'); return; }
    setTab(tab || 'models');
    if (drawer.classList.contains('open')) return;
    lastFocus = document.activeElement;
    backdrop.hidden = false;
    requestAnimationFrame(() => { backdrop.classList.add('show'); drawer.classList.add('open'); });
    drawer.setAttribute('aria-hidden', 'false');
    document.body.classList.add('drawer-open');
    // Telefonun geri tuşu paneli kapatsın
    try { history.pushState({ drawer: 1 }, '', '#detay'); } catch (e) { /* önemli değil */ }
    setTimeout(() => $('#drawerClose').focus(), 320);
  }
  function closeDrawer(fromHistory) {
    if (!drawer.classList.contains('open')) return;
    drawer.classList.remove('open'); backdrop.classList.remove('show');
    drawer.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('drawer-open');
    setTimeout(() => { backdrop.hidden = true; }, 300);
    if (!fromHistory && history.state && history.state.drawer) { try { history.back(); } catch (e) { /* önemli değil */ } }
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  addEventListener('popstate', () => closeDrawer(true));
  if (location.hash === '#detay') { try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* */ } }
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-open]'); if (b) openDrawer(b.dataset.open);
  });
  $('#drawerClose').addEventListener('click', () => closeDrawer());
  backdrop.addEventListener('click', () => closeDrawer());
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });
  document.querySelector('.tabs').addEventListener('click', e => { const t = e.target.closest('.tab'); if (t) setTab(t.dataset.tab); });
  document.querySelector('.tabs').addEventListener('keydown', e => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const tabs = [...document.querySelectorAll('.tab')], i = tabs.findIndex(t => t.getAttribute('aria-selected') === 'true');
    const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    setTab(n.dataset.tab); n.focus();
  });
  $('#dayChips').addEventListener('click', e => {
    const b = e.target.closest('.chip'); if (!b) return;
    S.sel = +b.dataset.i; renderTable();
  });
  // Paneli sağa kaydırarak kapatma
  {
    let sx = 0, sy = 0, dx = 0, track = false;
    drawer.addEventListener('touchstart', e => {
      const sc = e.target.closest('.scroll, .day-chips');
      if (e.target.closest('.fig') || (sc && sc.scrollWidth > sc.clientWidth + 2)) { track = false; return; }
      sx = e.touches[0].clientX; sy = e.touches[0].clientY; dx = 0; track = true;
    }, { passive: true });
    drawer.addEventListener('touchmove', e => {
      if (!track) return;
      dx = e.touches[0].clientX - sx;
      const dy = Math.abs(e.touches[0].clientY - sy);
      if (dy > Math.abs(dx)) { track = false; drawer.style.transform = ''; return; }
      if (dx > 0) { drawer.style.transition = 'none'; drawer.style.transform = `translateX(${dx}px)`; }
    }, { passive: true });
    drawer.addEventListener('touchend', () => {
      if (!track) return;
      drawer.style.transition = ''; drawer.style.transform = '';
      if (dx > 90) closeDrawer();
      track = false;
    });
  }

  /* ---------- Aşağı çekip yenileme ---------- */
  {
    const pull = $('#pull'), TH = 72, MAX = 120;
    let y0 = 0, x0 = 0, dist = 0, active = false, decided = false;
    const canPull = () => window.scrollY <= 0 && !document.body.classList.contains('drawer-open') && !S.loading;
    const show = d => {
      const p = Math.min(1, d / TH);
      pull.style.opacity = String(p);
      pull.style.transform = `translateY(${Math.min(d, MAX) - 50}px) rotate(${d * 3}deg)`;
    };
    document.addEventListener('touchstart', e => {
      if (e.touches.length !== 1 || !canPull() || e.target.closest('.drawer, .hours, .fav-row, .search')) { active = false; return; }
      y0 = e.touches[0].clientY; x0 = e.touches[0].clientX; dist = 0; active = true; decided = false;
      pull.classList.remove('anim');
    }, { passive: true });
    document.addEventListener('touchmove', e => {
      if (!active) return;
      const dy = e.touches[0].clientY - y0, dx = e.touches[0].clientX - x0;
      if (!decided) {
        if (Math.abs(dy) < 6 && Math.abs(dx) < 6) return;
        decided = true;
        if (dy <= 0 || Math.abs(dx) > dy || window.scrollY > 0) { active = false; return; }
      }
      dist = Math.max(0, dy * 0.55);
      if (dist > 0 && e.cancelable) e.preventDefault();
      show(dist);
    }, { passive: false });
    document.addEventListener('touchend', async () => {
      if (!active) return;
      active = false;
      pull.classList.add('anim');
      if (dist >= TH) {
        pull.style.opacity = '1'; pull.style.transform = 'translateY(22px)';
        pull.classList.add('spin');
        await refresh();
        pull.classList.remove('spin');
      }
      pull.style.opacity = '0'; pull.style.transform = 'translateY(-60px)';
      dist = 0;
    });
  }

  /* ---------- Olaylar ---------- */
  $('#placeBtn').addEventListener('click', () => toggleSearch($('#search').hidden));
  $('#refreshBtn').addEventListener('click', () => refresh());
  $('#favBtn').addEventListener('click', toggleFav);
  $('#favRow').addEventListener('click', e => {
    const b = e.target.closest('.fav'); if (!b) return;
    const i = +b.dataset.p, cur = pageIndex();
    if (i === cur) return;
    goPage(i, cur < 0 ? 0 : Math.sign(i - cur));
  });
  $('#favList').addEventListener('click', e => {
    const del = e.target.closest('[data-del]');
    if (del) { const f = S.favs[+del.dataset.del]; S.favs.splice(+del.dataset.del, 1); saveFavs(); renderFavs(); if (f) toast(`${f.name} favorilerden çıkarıldı`); return; }
    const b = e.target.closest('[data-fi]'); if (b) setLoc({ ...S.favs[+b.dataset.fi] });
  });
  $('#searchForm').addEventListener('submit', e => { e.preventDefault(); search($('#searchInput').value); });
  $('#searchInput').addEventListener('input', e => { clearTimeout(searchT); searchT = setTimeout(() => search(e.target.value), 350); });
  $('#searchInput').addEventListener('keydown', e => { if (e.key === 'Escape') toggleSearch(false); });
  $('#results').addEventListener('click', e => {
    const b = e.target.closest('button[data-i]'); if (!b) return;
    const r = S.results[+b.dataset.i];
    setLoc({ name: r.name, region: [r.admin1, r.country].filter(Boolean).join(', '), lat: r.latitude, lon: r.longitude });
  });
  $('#geoBtn').addEventListener('click', () => {
    if (!navigator.geolocation) { toast('Bu cihaz konum vermiyor. Şehir aramayı kullan.'); return; }
    toggleSearch(false);
    toast('Konumun bulunuyor…');
    gpsLocate().then(l => { if (l) setLoc(l); else toast('Konum alınamadı. İzin verdiğinden emin ol ya da şehir ara.'); });
  });
  $('#days').addEventListener('click', e => {
    const b = e.target.closest('.day'); if (!b || !S.c || b.classList.contains('day-past')) return;
    S.sel = +b.dataset.i;
    renderTable();
    openDrawer('models');
  });
  $('#moreDays').addEventListener('click', () => { showAllDays = !showAllDays; renderDays(); });
  $('#themeChips').innerHTML = THEMES.map(([k, l]) => `<button class="chip" type="button" data-t="${k}" aria-pressed="${k === 'auto'}">${l}</button>`).join('');
  $('#themeChips').addEventListener('click', e => {
    const b = e.target.closest('.chip'); if (!b) return;
    S.theme = b.dataset.t; applyTheme();
  });
  const chartRO = new ResizeObserver(() => drawChart());
  chartRO.observe($('#chartFig'));
  setInterval(() => { if (!document.hidden) refresh(true); }, 30 * 60 * 1000);

  /* ---------- Android geri tuşu (Capacitor App eklentisi) ---------- */
  // Dinleyici kaydedilince Android'in varsayılan "uygulamadan çık" davranışı devre dışı kalır
  try {
    const capApp = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
    if (capApp && capApp.addListener) {
      capApp.addListener('backButton', () => {
        if (document.body.classList.contains('drawer-open')) closeDrawer();
        else if (!$('#search').hidden) toggleSearch(false);
        else capApp.exitApp();
      });
    }
  } catch (e) { console.warn('Geri tuşu dinlenemedi', e); }

  /* ---------- Başlangıç ---------- */
  try { localStorage.removeItem('hh.cache'); } catch (e) { /* eski tek konumluk önbellek */ }
  applyTheme();
  S.card = store.get('hh.card');
  if (S.favs.length) {
    // Favori varsa açılışta bulunduğun konum gösterilir; konum alınamazsa ilk favori
    if (S.gps) setLoc(S.gps);
    else {
      S.loc = { name: 'Konumum', gps: true, lat: NaN, lon: NaN };
      $('#placeName').textContent = 'Konum bulunuyor…';
      showLoading({ name: 'Bulunduğun konum' });
      renderFavs();
    }
    gpsLocate().then(l => {
      if (!S.loc.gps) return; // bu arada başka konuma geçildi
      if (l) {
        if (!isFinite(S.loc.lat) || distKm(l, S.loc) > 1) setLoc(l);
        else { S.loc = l; store.set('hh.loc', l); $('#placeName').textContent = l.name; renderFavs(); }
      } else if (!isFinite(S.loc.lat)) {
        toast('Konum alınamadı, ilk favori açıldı');
        setLoc({ ...S.favs[0] });
      }
    });
  } else {
    if (!isFinite(S.loc.lat)) S.loc = DEFAULT_LOC;
    $('#placeName').textContent = S.loc.name;
    renderFavs();
    const c = cacheGet(S.loc);
    if (c) { S.data = c; try { render(); } catch (e) { console.error(e); S.data = null; } }
    refresh(!!S.data);
  }
  loadCard();
}
}
