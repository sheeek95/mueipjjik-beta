// Cloudflare Pages Functions에서 쓰는 YouTube Data API v3 헬퍼.
// 무료지만 search.list 1회 호출이 하루 할당량(10,000 unit)의 100 unit을 쓰기 때문에
// (하루 최대 약 100회 검색) RATE_LIMIT_KV가 있으면 동일 검색어 결과를 캐싱해서 호출량을 크게 줄임.

import { decodeHtmlEntities } from './text.js';

const CACHE_TTL_SECONDS = 6 * 60 * 60; // 6시간: 날씨 조건이 자주 안 바뀌므로 캐시로 대부분 커버됨

export async function searchYoutubeTrend(env, query, max = 3) {
  if (!env.YOUTUBE_API_KEY) return [];

  const cacheKey = `ytcache:${query}`;
  if (env.RATE_LIMIT_KV) {
    const cached = await env.RATE_LIMIT_KV.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch (e) {
        // 캐시 파싱 실패 시 무시하고 새로 조회
      }
    }
  }

  try {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=relevance&maxResults=${max}&q=${encodeURIComponent(query)}&key=${env.YOUTUBE_API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    const items = (data.items || []).map((it) => ({
      title: decodeHtmlEntities(it.snippet.title),
      description: decodeHtmlEntities(it.snippet.description),
      channel: decodeHtmlEntities(it.snippet.channelTitle),
    }));

    if (env.RATE_LIMIT_KV && items.length) {
      await env.RATE_LIMIT_KV.put(cacheKey, JSON.stringify(items), { expirationTtl: CACHE_TTL_SECONDS });
    }
    return items;
  } catch (e) {
    return [];
  }
}
