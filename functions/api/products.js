// Cloudflare Pages Function
// 배포 경로: /api/products
//
// 홈 화면의 "실제 코디템 추천" 카드용. 네이버 쇼핑 검색 API(공식, 크롤링 아님)로
// 오늘 날씨/계절에 어울리는 옷차림 태그별 실제 상품(사진/가격/판매처/링크)을 찾아줌.
// NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 환경변수는 functions/api/chat.js와 공유해서 씀.
// 설정 안 돼 있으면 빈 목록을 돌려주고, 프론트엔드는 그 경우 섹션을 숨김.

import { weatherQueryParts, searchNaverShop, stripNaverMarkup, checkRateLimit, jsonResponse } from '../../lib/naver.js';

const MAX_ITEMS = 2; // 요청당 검색할 옷차림 태그 수 (Naver 쇼핑 API 호출량 절약)
const PRODUCTS_PER_ITEM = 2;
const DAILY_LIMIT_PER_IP = 40; // 홈 화면 로드/스타일 변경마다 자동 호출되므로 채팅보다 여유 있게 설정

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();

    if (!env.NAVER_CLIENT_ID || !env.NAVER_CLIENT_SECRET) {
      return jsonResponse({ groups: [] }); // 미설정 시 조용히 빈 배열
    }

    if (!(await checkRateLimit(env, request, 'rlp', DAILY_LIMIT_PER_IP))) {
      return jsonResponse({ groups: [], debug: 'IP당 하루 요청 한도 초과 (RATE_LIMIT_KV)' }, 429);
    }

    const items = Array.isArray(body && body.items) ? body.items.filter((v) => typeof v === 'string').slice(0, MAX_ITEMS) : [];
    if (!items.length) {
      return jsonResponse({ groups: [] });
    }

    const baseParts = weatherQueryParts(body && body.weather);
    const debugSink = [];

    const groups = await Promise.all(items.map(async (item) => {
      const query = [...baseParts, item].join(' ');
      const results = await searchNaverShop(env, query, PRODUCTS_PER_ITEM, debugSink);
      return {
        tag: item,
        products: results.map((r) => ({
          title: stripNaverMarkup(r.title),
          image: r.image,
          price: Number(r.lprice) || null,
          mall: r.mallName,
          link: r.link,
        })),
      };
    }));

    const filtered = groups.filter((g) => g.products.length);
    const responseBody = { groups: filtered };
    // 상품이 하나도 없을 때만 실패 원인을 같이 보내줌 (정상적으로 검색 결과가 없는 경우와 구분하기 위함)
    if (!filtered.length && debugSink.length) responseBody.debug = debugSink;
    return jsonResponse(responseBody);
  } catch (err) {
    return jsonResponse({ groups: [], debug: String((err && err.stack) || err) }, 200);
  }
}
