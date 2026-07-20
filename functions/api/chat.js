// Cloudflare Pages Function
// 배포 경로: /api/chat  (파일 위치가 곧 라우트가 됨)
// 이 파일 안에서만 ANTHROPIC_API_KEY를 사용해서 브라우저에는 절대 키가 노출되지 않음.
//
// 설정 방법 (Cloudflare Pages 대시보드):
//   Settings > Environment variables > ANTHROPIC_API_KEY 값 추가 (Production/Preview 둘 다)
// 선택 사항 (있으면 자동으로 사용됨, 없어도 동작함):
//   Settings > Functions > KV namespace bindings 에서 RATE_LIMIT_KV 라는 이름으로 KV 네임스페이스 연결
//   -> 연결하면 IP당 하루 요청 횟수를 제한해줌 (익명 서비스라 남용 방지에 필요)

const SYSTEM_PROMPT =
  "너는 '핏치'라는 귀엽고 친절한 햄스터 패션 요정이야. 사용자의 옷차림/사진을 보고 " +
  "스타일리스트처럼 객관적인 피드백(색조합, 체형에 맞는 핏, 개선점, 추천 아이템)을 주되, " +
  "말투는 다정하고 존댓말 대신 친근한 반말로, 너무 길지 않게 3~6문장 정도로 답해. 이모지를 가끔 섞어서 써.";

const DAILY_LIMIT_PER_IP = 20; // 익명 서비스라 IP당 하루 요청 한도를 둠 (필요시 조정)

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

    if (!env.ANTHROPIC_API_KEY) {
      return jsonResponse({ error: '서버에 API 키가 설정되지 않았어요. Cloudflare Pages 환경변수를 확인해줘.' }, 500);
    }

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      }),
    });

    const data = await anthropicRes.json();

    if (!anthropicRes.ok) {
      return jsonResponse({ error: (data.error && data.error.message) || 'AI 응답을 가져오지 못했어요.' }, anthropicRes.status);
    }

    const reply = (data.content || []).map((b) => b.text || '').join('\n');
    return jsonResponse({ reply });
  } catch (err) {
    return jsonResponse({ error: '서버 오류가 발생했어요.' }, 500);
  }
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
