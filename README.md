# 뭐입찍? 베타

가입 없이 쓰는 날씨 기반 옷차림 추천 + AI 코디 상담 베타 서비스.

## 폴더 구조
```
index.html              프론트엔드 전체 (온보딩/홈/AI채팅/설정/알림)
functions/api/chat.js   AI 채팅 프록시 (Cloudflare Pages Function, Cloudflare Workers AI 무료 티어 사용)
```

## 배포: Cloudflare Pages 전용
이 프로젝트는 **Cloudflare Pages**에만 배포할 수 있어요. `functions/api/chat.js`가 Cloudflare Pages Functions 런타임에서만 동작하기 때문에, GitHub Pages 같은 순수 정적 호스팅에 올리면 AI 채팅(핏치 코디 상담)이 동작하지 않아요. (과거에 있던 GitHub Pages용 `static.yml` 워크플로우가 삭제된 것도 이 이유예요.)

AI 채팅은 **Cloudflare Workers AI**로 동작해요. 별도 API 키 발급이나 카드 등록 없이, Cloudflare 계정에 기본 포함된 무료 뉴런 할당량(하루 10,000 뉴런) 안에서 바로 쓸 수 있어요.

배포 절차:
1. Cloudflare 대시보드 > Pages > 이 저장소 연결 (빌드 설정 없이 정적 파일 그대로 배포)
2. **Settings > Functions > Bindings > Add binding**에서 타입 `AI`, 변수 이름 `AI`로 바인딩 추가 (키 발급 불필요)
3. (선택) 남용 방지를 위해 **Settings > Functions > KV namespace bindings**에서 `RATE_LIMIT_KV`라는 이름으로 KV 네임스페이스 연결 → IP당 하루 요청 횟수 제한이 자동으로 켜져요
   - KV 네임스페이스가 아직 없다면: 대시보드 **Storage & Databases > KV > Create namespace**로 먼저 만든 뒤, 위 바인딩 화면에서 변수 이름 `RATE_LIMIT_KV`로 방금 만든 네임스페이스를 선택하면 돼요.
4. (선택) 날씨/계절에 맞는 코디 트렌드를 핏치 답변에 반영하려면 **Settings > Environment variables**에 `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET` 추가 (아래 "코디 트렌드 참고" 항목 참고)
5. 배포 후 `/api/chat` 경로로 POST 요청이 정상 응답하는지 확인

⚠️ 하루 10,000 뉴런은 **Cloudflare 계정 전체가 공유하는 무료 한도**예요 (대화 1건당 대략 수백 뉴런 소모). 사용자가 많아지면 하루 중간에 한도가 소진될 수 있으니, 이 경우 Workers AI 사용량 기반 유료 전환을 고려해야 해요.

## 코디 트렌드 참고 (네이버 블로그, 선택 기능)
`NAVER_CLIENT_ID`/`NAVER_CLIENT_SECRET`을 설정하면, 사용자가 채팅을 보낼 때마다 서버가 현재 계절 + 오늘 체감온도 + 비/눈 여부 + 선택한 스타일로 네이버 블로그 검색 API를 호출해서 상위 글 3개의 제목/요약을 가져오고, 이걸 핏치의 시스템 프롬프트에 참고자료로 붙여줘요. 핏치가 블로그 링크를 그대로 나열하지 않고, 요즘 트렌드를 자연스럽게 녹여서 답하도록 지시해뒀어요.

발급 방법:
1. [developers.naver.com](https://developers.naver.com) 로그인 > Application 등록
2. 사용 API에서 "검색" 선택
3. 발급된 Client ID / Client Secret을 Cloudflare Pages 환경변수에 등록

설정하지 않아도 서비스는 정상 동작해요 (이 경우 트렌드 참고 없이 핏치가 바로 답변해요). 무료 한도는 하루 25,000건이고, 채팅 1건당 검색 1회를 쓰므로 `RATE_LIMIT_KV`로 채팅 요청 자체를 제한해두면 이 한도도 자연히 보호돼요.

## 참고
- 날씨(Open-Meteo), 위치 지오코딩(Open-Meteo Geocoding), 역지오코딩(BigDataCloud) API는 모두 키가 필요 없어서 브라우저에서 바로 호출돼요.
- 기본 위치는 서울시 강남구예요. 위치 권한을 허용하면 현재 위치로, 거부하면 강남구 좌표로 날씨를 보여줘요.
- 설정 탭에서 위치를 추가하면 목록에서 눌러 활성 위치를 바로 전환할 수 있고, ✕ 버튼으로 삭제할 수 있어요.
- 얼굴/옷 사진은 서버에 저장하지 않고 그 요청 처리에만 사용돼요. 베타 화면에도 이 안내 문구를 넣는 걸 추천해요.
- 새로고침하면 상태가 초기화돼요 (DB가 없는 구조라서 그래요). 가입 기능을 붙이기 전까지는 정상 동작이에요.
