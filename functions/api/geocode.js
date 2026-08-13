// Cloudflare Pages Function
// 배포 경로: /api/geocode
//
// 위치(동네 이름) 검색을 좌표로 변환함. 한국 동/구 단위 정확도가 훨씬 높은
// NCP Maps Geocoding API를 우선 쓰고, 설정 안 돼 있으면 Open-Meteo 지오코딩(무료,
// 키 불필요하지만 한국 행정구역 커버리지가 얇음)으로 자동 대체함.
//
// 설정 방법 (선택 사항, 없어도 Open-Meteo로 동작함):
//   NCP 콘솔(ncloud.com) > AI·NAVER API > Maps > Geocoding 이용 신청
//   -> 발급되는 Client ID / Client Secret을 Cloudflare 환경변수
//      NCP_MAPS_CLIENT_ID / NCP_MAPS_CLIENT_SECRET 에 등록
//   (NAVER_CLIENT_ID/SECRET과는 별개의 애플리케이션/키일 수 있음 — 검색 API와 Maps는 다른 상품임)

import { checkRateLimit, jsonResponse } from '../../lib/naver.js';

const DAILY_LIMIT_PER_IP = 30;

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const query = (url.searchParams.get('query') || '').trim();

  if (!query) return jsonResponse({ results: [] });

  if (!(await checkRateLimit(env, request, 'rlg', DAILY_LIMIT_PER_IP))) {
    return jsonResponse({ results: [], debug: 'IP당 하루 요청 한도 초과' }, 429);
  }

  if (env.NCP_MAPS_CLIENT_ID && env.NCP_MAPS_CLIENT_SECRET) {
    const ncpResult = await searchNcpGeocode(env, query);
    if (ncpResult.results.length) return jsonResponse(ncpResult);
    // NCP가 설정돼 있는데 결과가 없으면(에러 포함) Open-Meteo로 폴백하되 원인은 debug로 남김
    const fallback = await searchOpenMeteoGeocode(query);
    if (ncpResult.debug) fallback.debug = ncpResult.debug;
    return jsonResponse(fallback);
  }

  return jsonResponse(await searchOpenMeteoGeocode(query));
}

async function searchNcpGeocode(env, query) {
  try {
    const res = await fetch(`https://maps.apigw.ntruss.com/map-geocode/v2/geocode?query=${encodeURIComponent(query)}`, {
      headers: {
        'X-NCP-APIGW-API-KEY-ID': env.NCP_MAPS_CLIENT_ID,
        'X-NCP-APIGW-API-KEY': env.NCP_MAPS_CLIENT_SECRET,
      },
    });
    if (!res.ok) {
      let bodyText = '';
      try { bodyText = await res.text(); } catch (e) { /* 무시 */ }
      return { source: 'ncp', results: [], debug: `ncp geocode ${res.status}: ${bodyText.slice(0, 200)}` };
    }
    const data = await res.json();
    const addresses = Array.isArray(data.addresses) ? data.addresses : [];
    return {
      source: 'ncp',
      results: addresses.map((a) => ({
        name: a.roadAddress || a.jibunAddress || query,
        lat: parseFloat(a.y),
        lon: parseFloat(a.x),
      })),
    };
  } catch (e) {
    return { source: 'ncp', results: [], debug: `ncp geocode fetch error: ${String(e)}` };
  }
}

async function searchOpenMeteoGeocode(query) {
  try {
    const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=10&language=ko`);
    if (!res.ok) {
      let bodyText = '';
      try { bodyText = await res.text(); } catch (e) { /* 무시 */ }
      return { source: 'open-meteo', results: [], debug: `open-meteo geocode ${res.status}: ${bodyText.slice(0, 200)}` };
    }
    const data = await res.json();
    const results = Array.isArray(data.results) ? data.results : [];
    const koreaOnly = results.filter((r) => !r.country_code || r.country_code === 'KR');
    const finalResults = koreaOnly.length ? koreaOnly : results;
    return {
      source: 'open-meteo',
      results: finalResults.map((r) => ({
        name: [r.name, r.admin2, r.admin1].filter((v, i, arr) => v && arr.indexOf(v) === i).join(', '),
        lat: r.latitude,
        lon: r.longitude,
      })),
    };
  } catch (e) {
    return { source: 'open-meteo', results: [], debug: `open-meteo geocode fetch error: ${String(e)}` };
  }
}
