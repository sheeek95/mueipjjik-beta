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
//   -> 연결하면 오늘 날씨/계절에 맞는 네이버 블로그 코디 글을 검색해 핏치 답변에 트렌드로 녹여줌

const SYSTEM_PROMPT =
  "너는 '핏치'라는 귀엽고 친절한 햄스터 패션 요정이야. 사용자의 옷차림/사진을 보고 " +
  "스타일리스트처럼 객관적인 피드백(색조합, 체형에 맞는 핏, 개선점, 추천 아이템)을 주되, " +
  "말투는 다정하고 존댓말 대신 친근한 반말로, 너무 길지 않게 3~6문장 정도로 답해. 이모지를 가끔 섞어서 써.";

const TEXT_MODEL = '@cf/meta/llama-3.1-8b-instruct';
const VISION_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';
const MAX_TOKENS = 512;

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
    if (env.RATE_LIMIT_KV) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const todayKey = `rl:${ip}:${new Date().toISOString().slice(0, 10)}`;
      const current = parseInt((await env.RATE_LIMIT_KV.get(todayKey)) || '0', 10);
      if (current >= DAILY_LIMIT_PER_IP) {
        return jsonResponse({ error: '오늘의 AI 채팅 무료 사용 횟수를 모두 썼어요. 내일 다시 시도해줘!' }, 429);
      }
      await env.RATE_LIMIT_KV.put(todayKey, String(current + 1), { expirationTtl: 60 * 60 * 24 });
    }

    if (!env.AI) {
      return jsonResponse({ error: 'AI 바인딩이 설정되지 않았어요. Cloudflare Pages > Settings > Functions > Bindings에서 AI를 연결해줘.' }, 500);
    }

    const textBlock = Array.isArray(userContent) ? userContent.find((b) => b.type === 'text') : null;
    const imageBlock = Array.isArray(userContent) ? userContent.find((b) => b.type === 'image') : null;
    const userText = (textBlock && textBlock.text) || '이 코디 어때? 색조합이랑 핏 좀 봐줘.';

    const trendContext = await fetchTrendContext(env, body && body.weather);
    const systemPrompt = SYSTEM_PROMPT + trendContext;

    let reply;
    if (imageBlock) {
      // llama-3.2-11b-vision-instruct는 messages가 아니라 image(byte 배열) + prompt(문자열) 형식을 받음
      const binary = atob(imageBlock.source.data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      const result = await env.AI.run(VISION_MODEL, {
        image: Array.from(bytes),
        prompt: `${systemPrompt}\n\n사용자: ${userText}`,
        max_tokens: MAX_TOKENS,
      });
      reply = result && result.response;
    } else {
      const result = await env.AI.run(TEXT_MODEL, {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userText },
        ],
        max_tokens: MAX_TOKENS,
      });
      reply = result && result.response;
    }

    if (!reply) {
      return jsonResponse({ error: 'AI 응답을 가져오지 못했어요.' }, 500);
    }

    return jsonResponse({ reply });
  } catch (err) {
    return jsonResponse({ error: '서버 오류가 발생했어요.' }, 500);
  }
}

// ---- 날씨/계절에 맞는 네이버 블로그 코디 트렌드를 찾아 시스템 프롬프트에 참고자료로 덧붙임 ----
function currentSeasonKST() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const month = kst.getUTCMonth() + 1;
  if (month === 12 || month <= 2) return '겨울';
  if (month <= 5) return '봄';
  if (month <= 8) return '여름';
  return '가을';
}

function stripNaverMarkup(s) {
  return String(s)
    .replace(/<\/?b>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'");
}

async function fetchTrendContext(env, weather) {
  if (!env.NAVER_CLIENT_ID || !env.NAVER_CLIENT_SECRET) return '';

  const parts = [currentSeasonKST()];
  if (weather && typeof weather.feel === 'number') parts.push(`${Math.round(weather.feel)}도`);
  if (weather && weather.isSnow) parts.push('눈 오는 날');
  else if (weather && weather.isRain) parts.push('비 오는 날');
  if (weather && weather.style) parts.push(weather.style);
  parts.push('코디');
  const query = parts.join(' ');

  try {
    const url = `https://openapi.naver.com/v1/search/blog.json?query=${encodeURIComponent(query)}&display=3&sort=sim`;
    const res = await fetch(url, {
      headers: {
        'X-Naver-Client-Id': env.NAVER_CLIENT_ID,
        'X-Naver-Client-Secret': env.NAVER_CLIENT_SECRET,
      },
    });
    if (!res.ok) return '';
    const data = await res.json();
    const items = (data.items || []).slice(0, 3);
    if (!items.length) return '';

    const lines = items.map((it, i) => `${i + 1}. ${stripNaverMarkup(it.title)} - ${stripNaverMarkup(it.description)}`);
    return `\n\n[참고 자료: '${query}' 네이버 블로그 검색 결과]\n${lines.join('\n')}\n위 내용을 참고해서 요즘 트렌드를 자연스럽게 답변에 녹여줘. 블로그 제목이나 링크를 그대로 나열하지는 말고, 어울리는 내용만 골라서 네 스타일로 이야기해줘.`;
  } catch (e) {
    return '';
  }
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
