// Hava Hakemi doğruluk karnesi
// Her gün bir kez çalışır (GitHub Actions):
//   1) Dünün havalimanı ölçümlerini (METAR) saat saat çıkarır
//   2) Dün için daha önce kaydedilmiş model tahminlerini bu ölçümlerle puanlar
//   3) Bugün ve yarın için tüm modellerin tahminlerini kaydeder
//   4) Son 30 günün özetini www/data/scorecard.json dosyasına yazar
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'www', 'data');
const TZ_OFF = 3; // Türkiye: UTC+3, yaz saati yok

export const MODELS = ['ecmwf_ifs025', 'ecmwf_aifs025_single', 'gfs_seamless', 'icon_seamless',
  'meteofrance_seamless', 'ukmo_seamless', 'jma_seamless', 'gem_seamless'];

export const CITIES = [
  { key: 'istanbul', name: 'İstanbul', station: 'LTFJ', stationName: 'Sabiha Gökçen Havalimanı', lat: 40.8986, lon: 29.3092 },
  { key: 'ankara',   name: 'Ankara',   station: 'LTAC', stationName: 'Esenboğa Havalimanı',      lat: 40.1281, lon: 32.9951 },
  { key: 'izmir',    name: 'İzmir',    station: 'LTBJ', stationName: 'Adnan Menderes Havalimanı', lat: 38.2924, lon: 27.1570 },
  { key: 'antalya',  name: 'Antalya',  station: 'LTAI', stationName: 'Antalya Havalimanı',        lat: 36.8987, lon: 30.8005 },
  { key: 'trabzon',  name: 'Trabzon',  station: 'LTCG', stationName: 'Trabzon Havalimanı',        lat: 40.9951, lon: 39.7897 },
];

const UA = { 'User-Agent': 'hava-hakemi (github.com/furkankurt17/hava-hakemi)' };
const isNum = v => typeof v === 'number' && isFinite(v);
const r1 = v => (isNum(v) ? Math.round(v * 10) / 10 : null);
const r2 = v => (isNum(v) ? Math.round(v * 100) / 100 : null);
export function median(a) {
  const s = a.filter(isNum).sort((x, y) => x - y);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/* ---------- Tarih yardımcıları (Türkiye saati) ---------- */
export const dayStr = ms => new Date(ms + TZ_OFF * 3600e3).toISOString().slice(0, 10);
export const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
// Yerel d günü saat h:00'ın UTC milisaniyesi
export const localHourUTC = (d, h) => Date.parse(d + 'T00:00:00Z') - TZ_OFF * 3600e3 + h * 3600e3;

/* ---------- METAR çözümleme ---------- */
// Sadece gözlem kısmına bakılır; TEMPO/BECMG gibi tahmin ekleri ve RMK atılır.
export function parseMetar(raw) {
  let s = ' ' + String(raw).replace(/\s+/g, ' ').trim() + ' ';
  const cut = s.search(/ (TEMPO|BECMG|NOSIG|RMK|FM\d{6}|PROB\d{2}) /);
  if (cut > 0) s = s.slice(0, cut) + ' ';
  const tm = s.match(/ (M?\d{2})\/(M?\d{2})? /);
  const temp = tm ? (tm[1][0] === 'M' ? -parseInt(tm[1].slice(1), 10) : parseInt(tm[1], 10)) : null;
  // Yağış grupları: -RA, +SHRA, TSRA, DZ, SN, FZRA ... (VC = civarda ve RE = az önce sayılmaz)
  const precip = /\s[-+]?(?:MI|PR|BC|DR|BL|SH|TS|FZ)?(?:DZ|RA|SN|SG|PL|GR|GS|UP)+(?=\s)/.test(s);
  return { temp, precip };
}

// d günü için saatlik gözlem: sıcaklık (saat başına en yakın, ±35 dk) ve yağış (önceki 1 saatte herhangi bir raporda)
export function hourlyObs(list, d) {
  const t = Array(24).fill(null), rain = Array(24).fill(null);
  for (let h = 0; h < 24; h++) {
    const T = localHourUTC(d, h);
    let best = null, bd = Infinity;
    for (const o of list) {
      const dd = Math.abs(o.time - T);
      if (o.temp != null && dd < bd) { bd = dd; best = o; }
    }
    if (best && bd <= 35 * 60e3) t[h] = best.temp;
    const win = list.filter(o => o.time > T - 3600e3 && o.time <= T);
    if (win.length) rain[h] = win.some(o => o.precip);
  }
  return { t, rain };
}

/* ---------- Puanlama ---------- */
// models: { id: { t:[24], p:[24] } }, obs: { t:[24], rain:[24] }, fromHour: bu saatten önceki saatler sayılmaz
export function scoreSet(models, obs, fromHour = 0) {
  const ids = Object.keys(models);
  const all = { ...models };
  if (ids.length >= 2) {
    const t = [], p = [];
    for (let h = 0; h < 24; h++) {
      t.push(median(ids.map(i => models[i].t[h])));
      p.push(median(ids.map(i => models[i].p[h])));
    }
    all.ortak = { t, p };
  }
  const known = obs.rain.filter((v, h) => h >= fromHour && v !== null).length;
  const span = 24 - fromHour;
  const obsRain = known >= Math.ceil(span * 0.75) ? obs.rain.some((v, h) => h >= fromHour && v === true) : null;
  const res = {};
  for (const [id, m] of Object.entries(all)) {
    let abs = 0, n = 0;
    for (let h = fromHour; h < 24; h++) {
      if (isNum(obs.t[h]) && isNum(m.t[h])) { abs += Math.abs(m.t[h] - obs.t[h]); n++; }
    }
    const ps = m.p.slice(fromHour).filter(isNum);
    const fRain = ps.length >= Math.ceil(span * 0.8) ? ps.reduce((a, b) => a + b, 0) >= 0.5 : null;
    res[id] = { abs: r2(abs), n, rain: obsRain === null || fRain === null ? null : fRain === obsRain };
  }
  return { fromHour, obsRain, models: res };
}

// Son 30 günün özeti. Tercihen 1 gün önceden yapılmış tahminler (lead1); yeterli gün yoksa aynı gün (lead0).
export function summarize(cityScores) {
  const dates = Object.keys(cityScores || {}).sort().slice(-30);
  const pick = lead => {
    const agg = {}; let days = 0;
    for (const d of dates) {
      const s = cityScores[d][lead];
      if (!s) continue;
      days++;
      for (const [id, v] of Object.entries(s.models)) {
        const a = agg[id] || (agg[id] = { abs: 0, n: 0, hit: 0, rd: 0, days: 0 });
        a.abs += v.abs; a.n += v.n; a.days++;
        if (v.rain !== null) { a.rd++; if (v.rain) a.hit++; }
      }
    }
    return { days, agg };
  };
  let lead = 'lead1', r = pick('lead1');
  if (r.days < 3) { const r0 = pick('lead0'); if (r0.days > r.days) { lead = 'lead0'; r = r0; } }
  const models = Object.entries(r.agg).filter(([, a]) => a.n > 0)
    .map(([id, a]) => ({ id, mae: r2(a.abs / a.n), rainHit: a.rd ? Math.round((100 * a.hit) / a.rd) : null, rainDays: a.rd, days: a.days }))
    .sort((x, y) => x.mae - y.mae);
  return { lead, days: r.days, models };
}

/* ---------- Ağ ---------- */
async function getJSON(url) {
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (r.ok) return await r.json();
      console.warn('HTTP', r.status, url);
      if (r.status === 400) return null;
    } catch (e) { console.warn('Bağlantı hatası', e.message, url); }
    await new Promise(res => setTimeout(res, 2500 * (a + 1)));
  }
  return null;
}
async function readJSON(f, def) { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return def; } }
async function writeJSON(f, o) { await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, JSON.stringify(o) + '\n'); }

async function fetchForecasts(city) {
  const out = {};
  await Promise.all(MODELS.map(async id => {
    const d = await getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}` +
      `&hourly=temperature_2m,precipitation&timezone=Europe%2FIstanbul&forecast_days=3&models=${id}`);
    if (!d || !d.hourly) return;
    const H = d.hourly;
    const tk = Object.keys(H).find(k => k.startsWith('temperature_2m'));
    const pk = Object.keys(H).find(k => k.startsWith('precipitation'));
    if (tk && pk) out[id] = { time: H.time, t: H[tk], p: H[pk] };
  }));
  return out;
}
function sliceDay(fc, d) {
  const res = {};
  for (const [id, f] of Object.entries(fc)) {
    const i = f.time.indexOf(d + 'T00:00');
    if (i < 0) continue;
    const t = f.t.slice(i, i + 24), p = f.p.slice(i, i + 24);
    if (t.length < 24 || t.every(v => v == null)) continue;
    res[id] = { t: t.map(r1), p: p.map(r2) };
  }
  return res;
}

/* ---------- Ana akış ---------- */
async function main() {
  const now = Date.now();
  const today = dayStr(now), yest = addDays(today, -1), tomorrow = addDays(today, 1);
  const nowHour = new Date(now + TZ_OFF * 3600e3).getUTCHours();
  console.log(`Bugün ${today}, puanlanacak gün ${yest}`);

  // 1) Gözlemler
  const ids = CITIES.map(c => c.station).join(',');
  const metars = (await getJSON(`https://aviationweather.gov/api/data/metar?ids=${ids}&format=json&hours=36`)) || [];
  console.log('Gelen METAR sayısı:', Array.isArray(metars) ? metars.length : 'geçersiz');
  const byStation = {};
  for (const o of Array.isArray(metars) ? metars : []) {
    const raw = o.rawOb || o.raw_text;
    if (!raw) continue;
    const st = o.icaoId || (raw.match(/\b[A-Z]{4}\b/) || [])[0];
    const time = isNum(o.obsTime) ? o.obsTime * 1000 : Date.parse(o.reportTime || o.receiptTime);
    if (!st || !isFinite(time)) continue;
    (byStation[st] || (byStation[st] = [])).push({ time, ...parseMetar(raw) });
  }
  const obsAll = { date: yest, cities: {} };
  for (const c of CITIES) {
    const o = hourlyObs(byStation[c.station] || [], yest);
    obsAll.cities[c.key] = { station: c.station, ...o };
    console.log(`${c.name}: ${o.t.filter(v => v != null).length}/24 saat sıcaklık, ${o.rain.filter(v => v).length} saat yağış`);
  }
  await writeJSON(path.join(DATA, 'obs', yest + '.json'), obsAll);

  // 2) Dünü puanla
  const scoresFile = path.join(DATA, 'scores.json');
  const scores = await readJSON(scoresFile, {});
  const fcY = await readJSON(path.join(DATA, 'forecasts', yest + '.json'), null);
  if (!fcY) console.log('Dün için kayıtlı tahmin yok, puanlama atlandı.');
  for (const c of CITIES) {
    const fc = fcY && fcY.cities && fcY.cities[c.key];
    const ob = obsAll.cities[c.key];
    if (!fc || ob.t.filter(v => v != null).length < 12) continue;
    const entry = {};
    for (const lead of ['lead0', 'lead1']) {
      if (fc[lead] && Object.keys(fc[lead].models).length >= 2) entry[lead] = scoreSet(fc[lead].models, ob, fc[lead].fromHour || 0);
    }
    if (Object.keys(entry).length) {
      (scores[c.key] || (scores[c.key] = {}))[yest] = entry;
      const s = entry.lead1 || entry.lead0;
      console.log(`${c.name} puan:`, Object.entries(s.models).map(([id, v]) => `${id}=${v.n ? (v.abs / v.n).toFixed(1) : '-'}°`).join(' '));
    }
  }
  const cutoff = addDays(today, -60);
  for (const k of Object.keys(scores)) for (const d of Object.keys(scores[k])) if (d < cutoff) delete scores[k][d];
  await writeJSON(scoresFile, scores);

  // 3) Bugün (lead0) ve yarın (lead1) için tahminleri kaydet
  const files = {};
  for (const d of [today, tomorrow]) files[d] = await readJSON(path.join(DATA, 'forecasts', d + '.json'), { date: d, cities: {} });
  for (const c of CITIES) {
    const fc = await fetchForecasts(c);
    console.log(`${c.name}: ${Object.keys(fc).length} model tahmini alındı`);
    const made = new Date(now).toISOString();
    const t0 = sliceDay(fc, today), t1 = sliceDay(fc, tomorrow);
    if (Object.keys(t0).length) (files[today].cities[c.key] ||= {}).lead0 = { made, fromHour: Math.min(23, nowHour + 1), models: t0 };
    if (Object.keys(t1).length) (files[tomorrow].cities[c.key] ||= {}).lead1 = { made, models: t1 };
  }
  for (const d of [today, tomorrow]) await writeJSON(path.join(DATA, 'forecasts', d + '.json'), files[d]);

  // 4) Karne özeti
  const card = {
    updated: new Date(now).toISOString(),
    cities: CITIES.map(c => ({ key: c.key, name: c.name, station: c.station, stationName: c.stationName, lat: c.lat, lon: c.lon, ...summarize(scores[c.key]) })),
  };
  await writeJSON(path.join(DATA, 'scorecard.json'), card);

  // 5) Eski dosyaları temizle
  for (const [dir, keep] of [['forecasts', 5], ['obs', 40]]) {
    const limit = addDays(today, -keep);
    for (const f of await fs.readdir(path.join(DATA, dir)).catch(() => [])) {
      if (f.endsWith('.json') && f.slice(0, 10) < limit) await fs.unlink(path.join(DATA, dir, f));
    }
  }
  console.log('Karne güncellendi.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}
