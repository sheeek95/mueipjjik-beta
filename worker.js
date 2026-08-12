// Wrangler 배포용 Worker 진입점.
// /api/chat, /api/products는 기존 Pages Functions 핸들러(functions/api/*.js)를 그대로 재사용하고,
// 그 외 요청은 정적 자산(ASSETS 바인딩, index.html 등)으로 넘김.

import { onRequestPost as handleChat } from './functions/api/chat.js';
import { onRequestPost as handleProducts } from './functions/api/products.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/api/chat') {
      return handleChat({ request, env });
    }
    if (request.method === 'POST' && url.pathname === '/api/products') {
      return handleProducts({ request, env });
    }

    return env.ASSETS.fetch(request);
  },
};
