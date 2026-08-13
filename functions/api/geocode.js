// Cloudflare Pages Function
// 배포 경로: /api/geocode
//
// 위치(동네 이름) 검색을 좌표로 변환함. 한국 동/구 단위 정확도가 훨씬 높은
// 카카오 로컬 API를 우선 쓰고, 설정 안 돼 있으면 Open-Meteo 지오코딩(무료,
// 키 불필요하지만 한국 행정구역 커버리지가 얇음)으로 자동 대체함.
//
// NCP Maps Geocoding을 먼저 써봤는데 무료 한도 안에서도 결제수단 등록이 필요해서
// 카카오 로컬 API로 교체함 (하루 10만 건 무료, 카드 등록 불필요).
//
// 설정 방법 (선택 사항, 없어도 Open-Meteo로 동작함):
//   Kakao Developers(developers.kakao.com) 로그인 > 내 애플리케이션 > 애플리케이션 추가
//   -> 앱 생성 시 자동 발급되는 "REST API 키"를 Cloudflare 환경변수
//      KAKAO_REST_API_KEY 에 등록 (플랫폼/도메인 등록 없이 서버에서 바로 호출 가능)

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

  if (env.KAKAO_REST_API_KEY) {
    const kakaoResult = await searchKakaoGeocode(env, query);
    if (kakaoResult.results.length) return jsonResponse(kakaoResult);
    // 카카오가 설정돼 있는데 결과가 없으면(에러 포함) Open-Meteo로 폴백하되 원인은 debug로 남김
    // (카카오가 진짜 0건을 반환한 건지, 요청 자체가 실패한 건지 구분되게 항상 debug를 채움)
    const fallback = await searchOpenMeteoGeocode(query);
    fallback.debug = kakaoResult.debug || 'kakao: 주소/키워드 검색 모두 0건 (API 자체는 정상 응답)';
    return jsonResponse(fallback);
  }

  const fallback = await searchOpenMeteoGeocode(query);
  fallback.debug = fallback.debug || 'KAKAO_REST_API_KEY 환경변수가 비어 있어서 open-meteo만 사용함';
  return jsonResponse(fallback);
}

async function searchKakaoGeocode(env, query) {
  const headers = { Authorization: `KakaoAK ${env.KAKAO_REST_API_KEY}` };
  try {
    // 1) 주소 검색(정식 지번/도로명 주소용) 먼저 시도
    const addrDocs = await kakaoRequest('https://dapi.kakao.com/v2/local/search/address.json', query, headers);
    if (addrDocs.error) return { source: 'kakao', results: [], debug: addrDocs.error };
    if (addrDocs.documents.length) {
      return {
        source: 'kakao',
        results: addrDocs.documents.map((d) => ({
          name: d.address_name || query,
          lat: parseFloat(d.y),
          lon: parseFloat(d.x),
        })),
      };
    }
    // 2) 주소 검색 결과가 없으면(예: "금천구"처럼 완전한 주소 형식이 아닌 경우) 키워드 검색으로 재시도
    const kwDocs = await kakaoRequest('https://dapi.kakao.com/v2/local/search/keyword.json', query, headers);
    if (kwDocs.error) return { source: 'kakao', results: [], debug: kwDocs.error };
    return {
      source: 'kakao',
      results: kwDocs.documents.map((d) => ({
        name: d.address_name || d.place_name || query,
        lat: parseFloat(d.y),
        lon: parseFloat(d.x),
      })),
    };
  } catch (e) {
    return { source: 'kakao', results: [], debug: `kakao geocode fetch error: ${String(e)}` };
  }
}

async function kakaoRequest(endpoint, query, headers) {
  const res = await fetch(`${endpoint}?query=${encodeURIComponent(query)}`, { headers });
  if (!res.ok) {
    let bodyText = '';
    try { bodyText = await res.text(); } catch (e) { /* 무시 */ }
    return { documents: [], error: `kakao ${res.status}: ${bodyText.slice(0, 200)}` };
  }
  const data = await res.json();
  return { documents: Array.isArray(data.documents) ? data.documents : [] };
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
