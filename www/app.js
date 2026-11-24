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
function compute(data) {
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
      time, t: median(ts), tLo: ts.length ? Math.min(...ts) : null, tHi: ts.length ? Math.max(...ts) : null,
      n: ps.length, rainN, share, p: median(ps),
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
      date, tx: median(tx), tn: median(tn),
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

/* ================= Node testleri için dışa aç ================= */
if (typeof document === 'undefined') {
  if (typeof module !== 'undefined') module.exports = { compute, verdict, cat, majority, consensusCat, median, column, MODELS };
} else {
  init();
}

/* ================= Tarayıcı kısmı ================= */
function init() {
  const $ = s => document.querySelector(s);
  const esc = s => String(s).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* depolama yoksa sorun değil */ } },
  };
  const S = { loc: store.get('hh.loc') || DEFAULT_LOC, data: null, c: null, sel: 0, theme: 'auto', loading: false };

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
    const base = { latitude: loc.lat, longitude: loc.lon, timezone: 'auto', forecast_days: 7 };
    const bmP = getJSON(API + '?' + qs({ ...base,
      current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,is_day,wind_speed_10m',
      hourly: 'is_day', daily: 'sunrise,sunset' }));
    const mPs = MODELS.map(m => getJSON(API + '?' + qs({ ...base, hourly: HOURLY, daily: DAILY, models: m.id }))
      .then(d => ({ ...m, hourly: d.hourly, daily: d.daily })));
    const [bm, ...rs] = await Promise.allSettled([bmP, ...mPs]);
    if (bm.status !== 'fulfilled') throw bm.reason;
    const usable = m => m.hourly && Array.isArray(m.hourly.time) &&
      Object.keys(m.hourly).some(k => k.startsWith('temperature_2m') && (m.hourly[k] || []).some(v => v != null));
    const models = rs.filter(r => r.status === 'fulfilled' && usable(r.value)).map(r => r.value);
    if (models.length < 2) throw new Error('Yeterli model yanıt vermedi');
    return { loc, at: Date.now(), bm: bm.value, models };
  }

  async function refresh(quiet) {
    if (S.loading) return;
    S.loading = true; $('#refreshBtn').classList.add('spin');
    try {
      const data = await loadForecast(S.loc);
      S.data = data; store.set('hh.cache', data);
      render();
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
    }
  }

  /* ---------- Çizim ---------- */
  function render() {
    S.c = compute(S.data);
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

    // Saatlik
    $('#hours').innerHTML = hours.slice(start, start + 24).map((h, k) => `
      <div class="hr${k === 0 ? ' first' : ''}">
        <div class="hr-time">${k === 0 ? 'Şimdi' : hh(h.time) === '00:00' ? esc(shortDay(h.time.slice(0, 10))) : hh(h.time)}</div>
        ${icon(h.cat, h.isDay)}
        <div class="hr-t">${r0(h.t)}°</div>
        <div class="hr-r">${h.rainN ? DROP + h.rainN + '/' + h.n : ''}</div>
      </div>`).join('');

    // Günler
    const lo = Math.min(...nums(days.map(d => d.tnLo))), hi = Math.max(...nums(days.map(d => d.txHi)));
    const pct = t => (((t - lo) / Math.max(1, hi - lo)) * 100).toFixed(1);
    $('#days').innerHTML = days.map((d, i) => `
      <li><button class="day" data-i="${i}" aria-pressed="${i === S.sel}">
        <span class="day-name"><span class="l">${esc(dayName(d.date, i))}</span><span class="s">${esc(i < 2 ? dayName(d.date, i) : shortDay(d.date))}</span></span>
        ${icon(d.cat, true)}
        <span class="day-rain">${d.rainN ? DROP + d.rainN + '/' + d.n : ''}</span>
        <span class="range">
          <span class="lo">${r0(d.tn)}°</span>
          <span class="track">
            ${d.tnLo != null && d.txHi != null ? `<span class="spread" style="left:${pct(d.tnLo)}%;right:${(100 - pct(d.txHi)).toFixed(1)}%"></span>` : ''}
            ${d.tn != null && d.tx != null ? `<span class="core" style="left:${pct(d.tn)}%;right:${(100 - pct(d.tx)).toFixed(1)}%"></span>` : ''}
          </span>
          <span>${r0(d.tx)}°</span>
        </span>
        <span class="dot lvl-${d.lvl}" title="${LVL_TEXT[d.lvl]}"></span>
      </button></li>`).join('');

    renderTable();
    drawChart();
    applyTheme();
    const t = new Date(S.data.at);
    const age = Math.round((Date.now() - S.data.at) / 60000);
    $('#updated').textContent = `${ms.length} model · Güncellendi ${t.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}` + (age > 60 ? ` (${Math.round(age / 60)} saat önce)` : '');
  }

  function renderTable() {
    const { ms, days } = S.c, i = S.sel, d = days[i];
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
  function setLoc(loc) {
    S.loc = loc; store.set('hh.loc', loc);
    $('#placeName').textContent = loc.name;
    toggleSearch(false);
    S.sel = 0;
    refresh();
  }
  function toggleSearch(open) {
    const el = $('#search'); el.hidden = !open;
    $('#placeBtn').setAttribute('aria-expanded', String(open));
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

  /* ---------- Olaylar ---------- */
  $('#placeBtn').addEventListener('click', () => toggleSearch($('#search').hidden));
  $('#refreshBtn').addEventListener('click', () => refresh());
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
    navigator.geolocation.getCurrentPosition(
      p => setLoc({ name: 'Konumum', region: '', lat: +p.coords.latitude.toFixed(4), lon: +p.coords.longitude.toFixed(4) }),
      () => toast('Konum izni verilmedi. Şehir aramayı kullan.'),
      { timeout: 12000, maximumAge: 600000 });
  });
  $('#days').addEventListener('click', e => {
    const b = e.target.closest('.day'); if (!b || !S.c) return;
    S.sel = +b.dataset.i;
    document.querySelectorAll('.day').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    renderTable();
    if (innerWidth < 760) $('#desk').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('#themeChips').innerHTML = THEMES.map(([k, l]) => `<button class="chip" type="button" data-t="${k}" aria-pressed="${k === 'auto'}">${l}</button>`).join('');
  $('#themeChips').addEventListener('click', e => {
    const b = e.target.closest('.chip'); if (!b) return;
    S.theme = b.dataset.t; applyTheme();
  });
  const chartRO = new ResizeObserver(() => drawChart());
  chartRO.observe($('#chartFig'));
  setInterval(() => { if (!document.hidden) refresh(true); }, 30 * 60 * 1000);

  /* ---------- Başlangıç ---------- */
  $('#placeName').textContent = S.loc.name;
  applyTheme();
  const cached = store.get('hh.cache');
  if (cached && cached.loc && cached.loc.lat === S.loc.lat && cached.loc.lon === S.loc.lon && cached.bm && cached.models) {
    S.data = cached;
    try { render(); } catch (e) { console.error(e); S.data = null; }
  }
  refresh(!!S.data);
}
}
