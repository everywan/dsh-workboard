// Open-Meteo：免 key，数据 CC BY 4.0（https://open-meteo.com/）。
const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const AIR = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const GEO = 'https://geocoding-api.open-meteo.com/v1/search';
const WEATHER_TTL = 10 * 60_000;
const GEO_TTL = 24 * 3600_000;
const HOURS = 8;

function coord(value, limit) {
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) > limit) throw new Error('invalid coordinates');
  return n.toFixed(2);
}

export async function getWeather(fetcher, {lat, lon, unit}) {
  const latitude = coord(lat, 90);
  const longitude = coord(lon, 180);
  const f = unit === 'f';
  const q = new URLSearchParams({
    latitude, longitude, timezone: 'auto', forecast_days: '2',
    current: 'temperature_2m,apparent_temperature,weather_code,is_day,relative_humidity_2m',
    hourly: 'temperature_2m,weather_code',
    daily: 'temperature_2m_max,temperature_2m_min',
    ...(f ? {temperature_unit: 'fahrenheit'} : {}),
  });
  const [data, air] = await Promise.all([
    fetcher.get(`${FORECAST}?${q}`, {ttlMs: WEATHER_TTL}),
    fetcher.get(`${AIR}?${new URLSearchParams({latitude, longitude, current: 'us_aqi'})}`, {ttlMs: WEATHER_TTL}).catch(() => null),
  ]);
  const c = data?.current;
  if (!c) throw new Error('unexpected weather response');
  const hourStart = String(c.time).slice(0, 13);
  const times = data.hourly?.time ?? [];
  const from = Math.max(0, times.findIndex(t => t.slice(0, 13) >= hourStart));
  return {
    unit: f ? 'f' : 'c',
    time: c.time,
    current: {temp: c.temperature_2m, feels: c.apparent_temperature, code: c.weather_code, isDay: c.is_day === 1, humidity: c.relative_humidity_2m},
    today: {hi: data.daily?.temperature_2m_max?.[0], lo: data.daily?.temperature_2m_min?.[0]},
    hours: times.slice(from, from + HOURS).map((t, i) => ({time: t.slice(11, 16), temp: data.hourly.temperature_2m[from + i], code: data.hourly.weather_code[from + i]})),
    aqi: air?.current?.us_aqi ?? null,
  };
}

const FEATURE_RANK = {PPLC: 0, PPLA: 1, PPLA2: 2, PPLA3: 3, PPLA4: 4, PPL: 5};

// 地名排序：行政级别优先、同级别按人口；再按国家偏好。这样「长沙」不会先给重庆 / 广东的同名小镇。
const placeScore = (r, country) => {
  const rank = FEATURE_RANK[r.feature_code] ?? 6;
  const pop = Number(r.population) || 0;
  const countryPenalty = country && r.country_code !== country ? 1 : 0;
  return countryPenalty * 1e12 + rank * 1e10 + (pop ? 1e10 - Math.log10(pop) * 1e9 : 1e10);
};

export async function searchPlaces(fetcher, {query, lang}) {
  const raw = String(query ?? '').trim().slice(0, 80);
  if (raw.length < 2) return [];
  const zh = lang === 'zh';
  const country = /[\u4e00-\u9fff]/.test(raw) ? 'CN' : '';
  // Open-Meteo 按名字精确匹配，而且不按人口排序：中文地名常带省 / 市后缀，
  // 「湖南长沙」连写直接 0 结果，「长沙」给的同名小镇里没有湖南省会（库里叫「长沙市」）。
  // 因此额外试「去后缀」「补市」「取末尾两字」三种写法，命中省会级结果就提前收工。
  const bare = raw.replace(/[省市区县]$/, '');
  const tries = [];
  const push = v => { if (v && v.length >= 2 && !tries.includes(v)) tries.push(v); };
  push(raw);
  push(bare);
  if (zh) {
    if (!/市$/.test(bare)) push(`${bare}市`);
    if (bare.length > 2) {
      push(bare.slice(-2));
      push(`${bare.slice(-2)}市`);
      push(bare.slice(-3));
      push(`${bare.slice(-3)}市`);
    }
  }
  const seen = new Map();
  let ranked = false;
  for (const name of tries.slice(0, 5)) {
    const q = new URLSearchParams({name, count: '8', language: zh ? 'zh' : 'en', format: 'json'});
    const data = await fetcher.get(`${GEO}?${q}`, {ttlMs: GEO_TTL}).catch(() => null);
    for (const r of data?.results ?? []) {
      const key = `${Number(r.latitude).toFixed(2)},${Number(r.longitude).toFixed(2)}`;
      if (!seen.has(key)) seen.set(key, r);
    }
    if ([...seen.values()].some(r => (FEATURE_RANK[r.feature_code] ?? 9) <= 1)) { ranked = true; break; }
  }
  if (!seen.size) return [];
  const results = [...seen.values()].sort((a, b) => placeScore(a, country) - placeScore(b, country)).slice(0, 8);
  if (!ranked) results.sort((a, b) => placeScore(a, country) - placeScore(b, country));
  return results.map(r => {
    const region = [r.admin1, r.admin2, r.country]
      .filter(Boolean)
      .filter((v, i, arr) => arr.indexOf(v) === i && v !== r.name)
      .join(', ');
    return {name: r.name, region, lat: r.latitude, lon: r.longitude, pop: Number(r.population) || 0};
  });
}
