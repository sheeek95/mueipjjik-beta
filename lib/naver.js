// Cloudflare Pages Functions에서 공유하는 네이버 검색 오픈 API 헬퍼.
// functions/ 디렉터리 바깥에 둬서 라우트로 인식되지 않게 하고, 상대경로 import로 재사용함.

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

async function naverSearch(env, endpoint, query, display) {
  if (!env.NAVER_CLIENT_ID || !env.NAVER_CLIENT_SECRET) return [];
  try {
    const url = `https://openapi.naver.com/v1/search/${endpoint}.json?query=${encodeURIComponent(query)}&display=${display}&sort=sim`;
    const res = await fetch(url, {
      headers: {
        'X-Naver-Client-Id': env.NAVER_CLIENT_ID,
        'X-Naver-Client-Secret': env.NAVER_CLIENT_SECRET,
      },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.items || [];
  } catch (e) {
    return [];
  }
}

export function searchNaverBlog(env, query, display = 3) {
  return naverSearch(env, 'blog', query, display);
}

export function searchNaverShop(env, query, display = 2) {
  return naverSearch(env, 'shop', query, display);
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
