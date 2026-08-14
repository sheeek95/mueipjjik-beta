// Cloudflare Pages Function
// 배포 경로: /api/weather?lat=..&lon=..
//
// 한국 기상청(KMA) 공식 데이터를 우선 쓰고, 설정 안 돼 있거나 실패하면 Open-Meteo(무료, 키
// 불필요하지만 한국 기준 정확도가 떨어짐)로 자동 대체함. KMA는 5km 격자(nx,ny) 기반 관측/예보
// 자료라 한국 안에서는 훨씬 정확함.
//
// 설정 방법 (선택 사항, 없어도 Open-Meteo로 동작함):
//   1. data.go.kr 로그인 > "기상청_단기예보 조회서비스(기상청API허브 연계)" 검색 > 활용신청 (즉시 승인)
//   2. 마이페이지 > 개발계정 상세보기에서 발급된 인증키 중 "일반 인증키(Decoding)" 값을 그대로 복사
//      (⚠️ "Encoding" 키를 넣으면 이 코드가 다시 인코딩해서 이중 인코딩 오류가 남 — 꼭 Decoding 키를 쓸 것)
//   3. Cloudflare 환경변수 KMA_SERVICE_KEY 에 등록
//
// 프론트가 기존 Open-Meteo 응답과 똑같은 모양(current/hourly)을 그대로 쓸 수 있도록 정규화해서 반환함:
//   { source, current:{temperature_2m, apparent_temperature, relative_humidity_2m, weather_code,
//     wind_speed_10m, time}, hourly:{time:[], temperature_2m:[], weather_code:[],
//     precipitation_probability:[]}, debug? }

import { checkRateLimit, jsonResponse } from '../../lib/naver.js';

const DAILY_LIMIT_PER_IP = 200; // 날씨 새로고침마다 KMA를 2번(실황+예보) 부르므로 넉넉히 잡음
const KMA_BASE = 'https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0';

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const lat = parseFloat(url.searchParams.get('lat'));
  const lon = parseFloat(url.searchParams.get('lon'));

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return jsonResponse({ error: 'lat/lon 파라미터가 필요해요' }, 400);
  }

  if (!(await checkRateLimit(env, request, 'rlw', DAILY_LIMIT_PER_IP))) {
    const fallback = await fetchOpenMeteoWeather(lat, lon);
    fallback.debug = 'IP당 하루 요청 한도 초과 (open-meteo로 대체)';
    return jsonResponse(fallback);
  }

  if (env.KMA_SERVICE_KEY) {
    const kmaResult = await fetchKmaWeather(env, lat, lon);
    if (kmaResult && !kmaResult.debug) return jsonResponse(kmaResult);
    const fallback = await fetchOpenMeteoWeather(lat, lon);
    fallback.debug = (kmaResult && kmaResult.debug) || 'kma: 알 수 없는 이유로 실패';
    return jsonResponse(fallback);
  }

  const fallback = await fetchOpenMeteoWeather(lat, lon);
  fallback.debug = fallback.debug || 'KMA_SERVICE_KEY 환경변수가 비어 있어서 open-meteo만 사용함';
  return jsonResponse(fallback);
}

// ---- KMA ----

async function fetchKmaWeather(env, lat, lon) {
  try {
    const { nx, ny } = latLonToGrid(lat, lon);
    const kst = kstNow();

    const [ncst, vilage] = await Promise.all([
      fetchUltraSrtNcst(env, nx, ny, kst),
      fetchVilageFcst(env, nx, ny, kst),
    ]);

    if (ncst.error || vilage.error) {
      return { debug: `nx=${nx} ny=${ny} / ${[ncst.error, vilage.error].filter(Boolean).join(' | ')}` };
    }

    const t1h = parseFloat(ncst.byCategory.T1H);
    const reh = parseFloat(ncst.byCategory.REH);
    const wsdMs = parseFloat(ncst.byCategory.WSD);
    const ptyNow = parseInt(ncst.byCategory.PTY, 10) || 0;

    if (!Number.isFinite(t1h)) {
      return { debug: `ncst 응답에 T1H(기온)이 없음: ${JSON.stringify(ncst.byCategory)}` };
    }

    const windKmh = Number.isFinite(wsdMs) ? wsdMs * 3.6 : 0;
    const feel = apparentTemperature(t1h, reh, windKmh, kst.getUTCMonth() + 1);

    const nowDateStr = kstDateStr(kst);
    const nowSlotKey = `${nowDateStr}${pad(kst.getUTCHours())}00`;
    const futureSlots = vilage.slots.filter((s) => `${s.date}${s.time}` >= nowSlotKey);
    const skyNow = futureSlots.length && futureSlots[0].SKY ? parseInt(futureSlots[0].SKY, 10) : 1;
    const wcode = kmaToWmoCode(skyNow, ptyNow);

    const nowIso = `${nowDateStr.slice(0, 4)}-${nowDateStr.slice(4, 6)}-${nowDateStr.slice(6, 8)}T${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())}`;

    const hourlySource = (futureSlots.length ? futureSlots : vilage.slots).slice(0, 24);
    const hourly = { time: [], temperature_2m: [], weather_code: [], precipitation_probability: [] };
    hourlySource.forEach((s) => {
      hourly.time.push(`${s.date.slice(0, 4)}-${s.date.slice(4, 6)}-${s.date.slice(6, 8)}T${s.time.slice(0, 2)}:${s.time.slice(2, 4)}`);
      hourly.temperature_2m.push(Number(s.TMP));
      hourly.weather_code.push(kmaToWmoCode(parseInt(s.SKY, 10) || skyNow, parseInt(s.PTY, 10) || 0));
      hourly.precipitation_probability.push(Number(s.POP) || 0);
    });

    return {
      source: 'kma',
      current: {
        temperature_2m: t1h,
        apparent_temperature: feel,
        relative_humidity_2m: Number.isFinite(reh) ? reh : 0,
        weather_code: wcode,
        wind_speed_10m: windKmh,
        time: nowIso,
      },
      hourly,
    };
  } catch (e) {
    return { debug: `kma 처리 중 예외: ${String((e && e.stack) || e)}` };
  }
}

// 초단기실황: 매시 정각 발표, 자료 정리 시간 때문에 발표 후 약 40~45분 지나야 조회 가능 (공식 가이드 권장)
async function fetchUltraSrtNcst(env, nx, ny, kst) {
  let h = kst.getUTCHours();
  const m = kst.getUTCMinutes();
  const d = new Date(kst);
  if (m < 45) {
    d.setUTCHours(d.getUTCHours() - 1);
    h = d.getUTCHours();
  }
  const base_date = kstDateStr(d);
  const base_time = `${pad(h)}00`;

  const res = await kmaRequest(env, 'getUltraSrtNcst', { base_date, base_time, nx, ny, numOfRows: 20 });
  if (res.error) return { error: `ncst ${res.error}` };
  const byCategory = {};
  res.items.forEach((it) => { byCategory[it.category] = it.obsrValue; });
  return { byCategory };
}

// 단기예보: 하루 8회(02,05,08,11,14,17,20,23시) 발표, 발표 후 약 10분 지나야 조회 가능
const VILAGE_BASE_HOURS = [2, 5, 8, 11, 14, 17, 20, 23];
async function fetchVilageFcst(env, nx, ny, kst) {
  const h = kst.getUTCHours();
  const m = kst.getUTCMinutes();
  const d = new Date(kst);
  const usable = VILAGE_BASE_HOURS.filter((bh) => bh < h || (bh === h && m >= 10));
  let base_date, base_time;
  if (usable.length) {
    base_date = kstDateStr(d);
    base_time = `${pad(usable[usable.length - 1])}00`;
  } else {
    d.setUTCDate(d.getUTCDate() - 1);
    base_date = kstDateStr(d);
    base_time = '2300';
  }

  const res = await kmaRequest(env, 'getVilageFcst', { base_date, base_time, nx, ny, numOfRows: 1000 });
  if (res.error) return { error: `vilage ${res.error}` };
  const bySlot = {};
  res.items.forEach((it) => {
    const key = `${it.fcstDate}${it.fcstTime}`;
    if (!bySlot[key]) bySlot[key] = { date: it.fcstDate, time: it.fcstTime };
    bySlot[key][it.category] = it.fcstValue;
  });
  const slots = Object.values(bySlot).sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
  return { slots };
}

async function kmaRequest(env, endpoint, params) {
  const qs = new URLSearchParams({
    serviceKey: env.KMA_SERVICE_KEY,
    dataType: 'JSON',
    pageNo: '1',
    numOfRows: String(params.numOfRows),
    base_date: params.base_date,
    base_time: params.base_time,
    nx: String(params.nx),
    ny: String(params.ny),
  });
  try {
    const res = await fetch(`${KMA_BASE}/${endpoint}?${qs.toString()}`);
    const bodyText = await res.text();
    let data;
    try {
      data = JSON.parse(bodyText);
    } catch (e) {
      return { error: `${res.status} 응답이 JSON이 아님(인증키 문제일 가능성 높음): ${bodyText.slice(0, 200)}` };
    }
    const header = data && data.response && data.response.header;
    if (!header || header.resultCode !== '00') {
      return { error: `${header ? `${header.resultCode} ${header.resultMsg}` : '응답 형식 이상'}` };
    }
    const items = (data.response.body && data.response.body.items && data.response.body.items.item) || [];
    return { items: Array.isArray(items) ? items : [items] };
  } catch (e) {
    return { error: `fetch error: ${String(e)}` };
  }
}

function kstNow() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000); // getUTC*로 KST 필드를 읽기 위해 9시간 더한 Date
}
function pad(n) {
  return String(n).padStart(2, '0');
}
function kstDateStr(d) {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

// 기상청 공식 체감온도 공식. 여름(5~9월, 27도 이상)엔 열지수, 겨울(기온 10도 이하 + 바람 있음)엔
// 풍속냉각지수를 쓰고, 그 외엔 보정 없이 기온을 그대로 씀 (기상청이 실제로 이렇게 운영함)
function apparentTemperature(ta, rh, windKmh, month) {
  if (month >= 5 && month <= 9 && ta >= 27 && Number.isFinite(rh)) {
    const tw = wetBulbTemp(ta, rh);
    const at = -0.2442 + 0.55399 * tw + 0.45535 * ta - 0.0022 * tw * tw + 0.00278 * tw * ta + 3.0;
    return Math.round(at);
  }
  if (ta <= 10 && windKmh >= 4.68) { // 1.3 m/s 이상
    const v16 = Math.pow(windKmh, 0.16);
    const wct = 13.12 + 0.6215 * ta - 11.37 * v16 + 0.3965 * ta * v16;
    return Math.round(wct);
  }
  return Math.round(ta);
}

// Stull(2011) 습구온도 근사식
function wetBulbTemp(ta, rh) {
  return (
    ta * Math.atan(0.151977 * Math.sqrt(rh + 8.313659)) +
    Math.atan(ta + rh) -
    Math.atan(rh - 1.676331) +
    0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh) -
    4.686035
  );
}

// PTY(강수형태)/SKY(하늘상태)를 기존 프론트가 쓰는 Open-Meteo식 WMO 코드로 변환
// (PTY가 있으면 강수 종류를 우선하고, 없으면 SKY로 하늘 상태만 판단)
function kmaToWmoCode(sky, pty) {
  switch (pty) {
    case 1: return 63; // 비
    case 2: return 73; // 비/눈 -> 눈 취급(미끄럼 주의 쪽이 더 안전)
    case 3: return 73; // 눈
    case 4: return 80; // 소나기
    case 5: return 51; // 빗방울
    case 6: return 61; // 빗방울눈날림
    case 7: return 71; // 눈날림
    default: break; // 0: 없음 -> 아래 SKY로 판단
  }
  if (sky === 3) return 2; // 구름많음
  if (sky === 4) return 3; // 흐림
  return 0; // 맑음
}

// 기상청 격자 좌표 변환(LCC DFS 투영). 상수는 기상청 공식 값.
const GRID_RE = 6371.00877, GRID_GRID = 5.0, GRID_SLAT1 = 30.0, GRID_SLAT2 = 60.0,
  GRID_OLON = 126.0, GRID_OLAT = 38.0, GRID_XO = 43, GRID_YO = 136;
function latLonToGrid(lat, lon) {
  const DEGRAD = Math.PI / 180.0;
  const re = GRID_RE / GRID_GRID;
  const slat1 = GRID_SLAT1 * DEGRAD, slat2 = GRID_SLAT2 * DEGRAD;
  const olon = GRID_OLON * DEGRAD, olat = GRID_OLAT * DEGRAD;

  let sn = Math.tan(Math.PI * 0.25 + slat2 * 0.5) / Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sn = Math.log(Math.cos(slat1) / Math.cos(slat2)) / Math.log(sn);
  let sf = Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sf = Math.pow(sf, sn) * Math.cos(slat1) / sn;
  let ro = Math.tan(Math.PI * 0.25 + olat * 0.5);
  ro = re * sf / Math.pow(ro, sn);

  let ra = Math.tan(Math.PI * 0.25 + lat * DEGRAD * 0.5);
  ra = re * sf / Math.pow(ra, sn);
  let theta = lon * DEGRAD - olon;
  if (theta > Math.PI) theta -= 2 * Math.PI;
  if (theta < -Math.PI) theta += 2 * Math.PI;
  theta *= sn;

  const nx = Math.floor(ra * Math.sin(theta) + GRID_XO + 0.5);
  const ny = Math.floor(ro - ra * Math.cos(theta) + GRID_YO + 0.5);
  return { nx, ny };
}

// ---- Open-Meteo (KMA 미설정/실패 시 대체) ----

async function fetchOpenMeteoWeather(lat, lon) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m&hourly=temperature_2m,weather_code,precipitation_probability&forecast_days=2&timezone=auto`;
    const res = await fetch(url);
    const data = await res.json();
    return { source: 'open-meteo', current: data.current, hourly: data.hourly };
  } catch (e) {
    return { source: 'open-meteo', current: null, hourly: null, debug: `open-meteo fetch error: ${String(e)}` };
  }
}
