// Cloudflare Pages Function
// 배포 경로: /api/chat  (파일 위치가 곧 라우트가 됨)
//
// 채팅 백엔드로 Cloudflare Workers AI(무료 티어)를 사용함.
// 별도 API 키/결제수단 없이 Cloudflare 계정의 하루 무료 뉴런 할당량(기본 10,000 뉴런/일) 안에서 동작함.
//
// 설정 방법 (Cloudflare Pages 대시보드):
//   Settings > Functions > Bindings > Add binding
//     Type: AI
//     Variable name: AI
//   (API 키 발급이나 환경변수 설정 필요 없음)
// 선택 사항 (있으면 자동으로 사용됨, 없어도 동작함):
//   Settings > Functions > KV namespace bindings 에서 RATE_LIMIT_KV 라는 이름으로 KV 네임스페이스 연결
//   -> 연결하면 IP당 하루 요청 횟수를 제한해줌 (한 사람이 하루 무료 뉴런 할당량을 다 쓰는 것 방지)
//   Settings > Environment variables 에서 NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 추가 (developers.naver.com, 무료)
//   -> 연결하면 오늘 날씨/계절에 맞는 네이버 블로그 코디 글 + 실제 상품을 검색해 핏치 답변에 참고자료로 녹여줌
//   Settings > Environment variables 에서 YOUTUBE_API_KEY 추가 (Google Cloud Console, 무료, 카드 불필요)
//   -> 연결하면 요즘 패션 유튜버들의 계절별 영상 제목/설명을 핏치 답변 참고자료로 녹여줌 (영상 자체는 화면에 노출 안 함)

import { weatherQueryParts, searchNaverBlog, searchNaverShop, stripNaverMarkup, checkRateLimit, jsonResponse } from '../../lib/naver.js';
import { searchYoutubeTrend } from '../../lib/youtube.js';

const SYSTEM_PROMPT =
  "너는 '핏치'라는 귀엽고 친절한 햄스터 패션 요정이야. 다정하고 친근한 반말로 답해. " +
  "질문으로 시작하지 말고 바로 추천/답변부터 말해. 3~4문장 이내로 짧고 간결하게, 이모지는 가끔만. " +
  "반드시 자연스러운 한국어 문장으로만 답하고, 영어·한자·다른 외국어 단어를 절대 섞지 마. " +
  "별표(*), 마크다운 기호, 번호 매기기는 쓰지 말고 대화하듯 문장을 이어서 말해. " +
  "아래 [오늘의 추천 코디]가 이미 계산된 정답이니 지어내지 말고 이 아이템들을 그대로 언급하면서 자연스럽게 설명해줘.";

// llama-3.1-8b-instruct(지원종료, 2026-05-30) -> llama-3.2-3b-instruct로 교체했다가
// 한국어에 영어/태국어/힌디어가 무작위로 섞여 나오는 문제가 있어서 다시 교체함.
// 이미지 채팅에서 이미 검증된 llama-3.2-11b-vision-instruct는 messages 형식도 지원해서
// 텍스트/이미지 채팅 모두 이 모델 하나로 통일 (더 큰 모델이라 다국어 안정성이 더 나음).
const TEXT_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';
const VISION_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';
const MAX_TOKENS = 300; // 답변을 짧게 유지하기 위해 축소

const DAILY_LIMIT_PER_IP = 20; // 무료 뉴런 할당량을 나눠 쓰기 위한 IP별 하루 요청 한도 (필요시 조정)

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();
    const userContent = body && body.content;

    if (!userContent) {
      return jsonResponse({ error: '요청 내용이 비어 있어요.' }, 400);
    }

    // ---- 아주 단순한 용량/남용 방지 체크 ----
    const roughSize = JSON.stringify(userContent).length;
    if (roughSize > 6_000_000) { // base64 이미지 포함 대략적인 상한 (약 4~5MB 원본 이미지 수준)
      return jsonResponse({ error: '이미지 용량이 너무 커요. 5MB 이하로 올려줘.' }, 413);
    }

    // ---- (선택) KV가 연결되어 있으면 IP당 하루 요청 수 제한 ----
    if (!(await checkRateLimit(env, request, 'rl', DAILY_LIMIT_PER_IP))) {
      return jsonResponse({ error: '오늘의 AI 채팅 무료 사용 횟수를 모두 썼어요. 내일 다시 시도해줘!' }, 429);
    }

    if (!env.AI) {
      return jsonResponse({ error: 'AI 바인딩이 설정되지 않았어요. Cloudflare Pages > Settings > Functions > Bindings에서 AI를 연결해줘.' }, 500);
    }

    const textBlock = Array.isArray(userContent) ? userContent.find((b) => b.type === 'text') : null;
    const imageBlock = Array.isArray(userContent) ? userContent.find((b) => b.type === 'image') : null;
    const userText = (textBlock && textBlock.text) || '이 코디 어때? 색조합이랑 핏 좀 봐줘.';

    const weather = body && body.weather;
    const outfitFact = buildOutfitFact(weather);
    const trendContext = await fetchTrendContext(env, weather);
    const systemPrompt = SYSTEM_PROMPT + outfitFact + trendContext;

    let reply;
    if (imageBlock) {
      // llama-3.2-11b-vision-instruct는 messages가 아니라 image(byte 배열) + prompt(문자열) 형식을 받음
      const binary = atob(imageBlock.source.data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      const result = await runAI(env, VISION_MODEL, {
        image: Array.from(bytes),
        prompt: `${systemPrompt}\n\n사용자: ${userText}`,
        max_tokens: MAX_TOKENS,
        temperature: 0.4,
      });
      reply = result && result.response;
      if (!reply) return jsonResponse({ error: 'AI 응답을 가져오지 못했어요.', debug: safeStringify(result) }, 500);
    } else {
      const result = await runAI(env, TEXT_MODEL, {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userText },
        ],
        max_tokens: MAX_TOKENS,
        temperature: 0.4,
      });
      reply = result && result.response;
      if (!reply) return jsonResponse({ error: 'AI 응답을 가져오지 못했어요.', debug: safeStringify(result) }, 500);
    }

    return jsonResponse({ reply });
  } catch (err) {
    return jsonResponse({ error: '서버 오류가 발생했어요.', debug: String((err && err.stack) || err) }, 500);
  }
}

// Meta의 일부 모델(Llama 3.2 등)은 계정에서 최초 1회 라이선스 동의가 필요함
// (AiError 5016: "User has not agreed to Llama3.2 model terms"). 대시보드 클릭이 아니라
// prompt:"agree" 요청을 한 번 보내는 방식이라, 실패하면 자동으로 동의 요청 후 재시도함.
async function runAI(env, model, input) {
  try {
    return await env.AI.run(model, input);
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (msg.includes('5016') || /agree/i.test(msg)) {
      try {
        await env.AI.run(model, { prompt: 'agree' });
      } catch (e2) {
        // 동의 요청 자체가 실패해도 아래에서 원래 에러를 다시 시도해서 판단함
      }
      return await env.AI.run(model, input); // 재시도. 여기서 또 실패하면 그대로 위로 던져짐
    }
    throw err;
  }
}

function safeStringify(obj) {
  try {
    return JSON.stringify(obj);
  } catch (e) {
    return String(obj);
  }
}

// 프론트에서 이미 (기온대 x 스타일)로 계산해서 보낸 실제 추천 아이템을 "정답"으로 프롬프트에 박아넣음.
// 모델이 스스로 옷차림을 지어내지 않고, 이미 정해진 조합을 자연스럽게 설명하게 하기 위함.
function buildOutfitFact(weather) {
  if (!weather || !Array.isArray(weather.items) || !weather.items.length) return '';
  const bits = [`[오늘의 추천 코디] ${weather.items.join(', ')}`];
  if (weather.shoe) bits.push(`신발: ${weather.shoe}`);
  if (weather.style) bits.push(`스타일: ${weather.style}`);
  return `\n\n${bits.join(' / ')}`;
}

// ---- 날씨/계절에 맞는 네이버 블로그 코디 글 + 실제 상품 + 유튜브 트렌드를 찾아 시스템 프롬프트에 참고자료로 덧붙임 ----
async function fetchTrendContext(env, weather) {
  const hasNaver = !!(env.NAVER_CLIENT_ID && env.NAVER_CLIENT_SECRET);
  const hasYoutube = !!env.YOUTUBE_API_KEY;
  if (!hasNaver && !hasYoutube) return '';

  const baseParts = weatherQueryParts(weather);
  const blogQuery = [...baseParts, '코디'].join(' ');
  const ytQuery = [...baseParts, '데일리룩'].join(' ');
  const hasTopItem = weather && Array.isArray(weather.items) && weather.items.length > 0;
  const shopQuery = hasTopItem ? [...baseParts, weather.items[0]].join(' ') : '';

  const [blogItems, shopItems, ytItems] = await Promise.all([
    hasNaver ? searchNaverBlog(env, blogQuery, 3) : Promise.resolve([]),
    hasNaver && hasTopItem ? searchNaverShop(env, shopQuery, 2) : Promise.resolve([]), // 대표 아이템 1개만 조회해 API 호출량 절약
    hasYoutube ? searchYoutubeTrend(env, ytQuery, 3) : Promise.resolve([]),
  ]);

  const productLines = shopItems.map((p, i) => {
    const price = Number(p.lprice);
    const priceLabel = Number.isFinite(price) ? `${price.toLocaleString()}원` : '';
    return `${i + 1}. ${stripNaverMarkup(p.title)} - ${priceLabel} (${p.mallName}) ${p.link}`;
  });

  if (!blogItems.length && !productLines.length && !ytItems.length) return '';

  let ctx = '';
  if (blogItems.length) {
    const lines = blogItems.map((it, i) => `${i + 1}. ${stripNaverMarkup(it.title)} - ${stripNaverMarkup(it.description)}`);
    ctx += `\n\n[참고 자료: '${blogQuery}' 네이버 블로그 검색 결과]\n${lines.join('\n')}`;
  }
  if (productLines.length) {
    ctx += `\n\n[참고 자료: 지금 날씨에 어울리는 실제 판매 상품]\n${productLines.join('\n')}\n상품을 추천할 땐 이 목록 중 어울리는 걸 골라 이름과 링크를 자연스럽게 언급해줘.`;
  }
  if (ytItems.length) {
    const lines = ytItems.map((v, i) => `${i + 1}. [${v.channel}] ${v.title} - ${v.description.slice(0, 80)}`);
    ctx += `\n\n[참고 자료: 요즘 패션 유튜버 영상 트렌드]\n${lines.join('\n')}\n영상 제목·채널명을 언급하거나 시청을 권하지 말고, 그 안에 담긴 스타일링 아이디어(색상 조합, 아이템, 레이어링 방식)만 골라 네 코디 조언에 자연스럽게 녹여줘.`;
  }
  ctx += '\n\n위 참고 자료를 답변에 자연스럽게 녹여줘. 글 제목이나 채널명을 그대로 나열하진 말고, 어울리는 내용만 골라 네 스타일로 이야기해줘.';
  return ctx;
}
