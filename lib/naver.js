// Cloudflare Pages Functions에서 공유하는 네이버 검색 API(NAVER API HUB) 헬퍼.
// functions/ 디렉터리 바깥에 둬서 라우트로 인식되지 않게 하고, 상대경로 import로 재사용함.
//
// 네이버가 기존 openapi.naver.com 검색 API를 NAVER API HUB(NCP 산하)로 이관하면서
// 엔드포인트/인증 헤더가 바뀜. NAVER_CLIENT_ID/SECRET 값은 developers.naver.com이 아니라
// ncloud.com의 "NAVER API HUB"에서 발급받은 Client ID / Client Secret을 그대로 넣으면 됨.

import { decodeHtmlEntities } from './text.js';

export function currentSeasonKST() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const month = kst.getUTCMonth() + 1;
  if (month === 12 || month <= 2) return '겨울';
  if (month <= 5) return '봄';
  if (month <= 8) return '여름';
  return '가을';
}

export function stripNaverMarkup(s) {
  return decodeHtmlEntities(String(s).replace(/<\/?b>/g, ''));
}

// 계절 + 체감온도 + 강수/적설 + 스타일로 검색어 뼈대를 만듦
export function weatherQueryParts(weather) {
  const parts = [currentSeasonKST()];
  if (weather && typeof weather.feel === 'number') parts.push(`${Math.round(weather.feel)}도`);
  if (weather && weather.isSnow) parts.push('눈 오는 날');
  else if (weather && weather.isRain) parts.push('비 오는 날');
  if (weather && weather.style) parts.push(weather.style);
  return parts;
}

// debugSink를 넘기면 실패 원인(HTTP 상태/본문 일부)을 그 배열에 담아줌 (기본 동작은 그대로 조용히 [] 반환)
async function naverSearch(env, endpoint, query, display, debugSink) {
  if (!env.NAVER_CLIENT_ID || !env.NAVER_CLIENT_SECRET) return [];
  try {
    // NAVER API HUB 엔드포인트 (구 openapi.naver.com/v1/search/*.json 방식은 더 이상 안 씀)
    const url = `https://naverapihub.apigw.ntruss.com/search/v1/${endpoint}?query=${encodeURIComponent(query)}&display=${display}&sort=sim&format=json`;
    const res = await fetch(url, {
      headers: {
        'X-NCP-APIGW-API-KEY-ID': env.NAVER_CLIENT_ID,
        'X-NCP-APIGW-API-KEY': env.NAVER_CLIENT_SECRET,
      },
    });
    if (!res.ok) {
      if (debugSink) {
        let bodyText = '';
        try { bodyText = await res.text(); } catch (e) { /* 무시 */ }
        debugSink.push(`${endpoint} ${res.status}: ${bodyText.slice(0, 200)}`);
      }
      return [];
    }
    const data = await res.json();
    return data.items || [];
  } catch (e) {
    if (debugSink) debugSink.push(`${endpoint} fetch error: ${String(e)}`);
    return [];
  }
}

export function searchNaverBlog(env, query, display = 3, debugSink) {
  return naverSearch(env, 'blog', query, display, debugSink);
}

// IP당 하루 요청 수 제한 (RATE_LIMIT_KV 바인딩이 없으면 그냥 통과시킴)
export async function checkRateLimit(env, request, prefix, limit) {
  if (!env.RATE_LIMIT_KV) return true;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const todayKey = `${prefix}:${ip}:${new Date().toISOString().slice(0, 10)}`;
  const current = parseInt((await env.RATE_LIMIT_KV.get(todayKey)) || '0', 10);
  if (current >= limit) return false;
  await env.RATE_LIMIT_KV.put(todayKey, String(current + 1), { expirationTtl: 60 * 60 * 24 });
  return true;
}

export function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
