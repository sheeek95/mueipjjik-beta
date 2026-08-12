# 뭐입찍? 베타

가입 없이 쓰는 날씨 기반 옷차림 추천 + AI 코디 상담 베타 서비스.

## 폴더 구조
```
index.html                프론트엔드 전체 (온보딩/홈/AI채팅/설정/알림)
functions/api/chat.js     AI 채팅 프록시 (Cloudflare Pages Function, Cloudflare Workers AI 무료 티어 사용)
functions/api/products.js 홈 화면 "실제 코디템 추천" 카드용 네이버 쇼핑 검색 프록시
lib/naver.js               네이버 검색 API(블로그/쇼핑) 헬퍼
lib/youtube.js              YouTube Data API 헬퍼 (트렌드 검색 + 캐싱)
lib/text.js                 HTML 엔티티 디코딩 등 공통 텍스트 유틸
```

## 배포: Cloudflare Pages 전용
이 프로젝트는 **Cloudflare Pages**에만 배포할 수 있어요. `functions/api/chat.js`가 Cloudflare Pages Functions 런타임에서만 동작하기 때문에, GitHub Pages 같은 순수 정적 호스팅에 올리면 AI 채팅(핏치 코디 상담)이 동작하지 않아요. (과거에 있던 GitHub Pages용 `static.yml` 워크플로우가 삭제된 것도 이 이유예요.)

AI 채팅은 **Cloudflare Workers AI**로 동작해요. 별도 API 키 발급이나 카드 등록 없이, Cloudflare 계정에 기본 포함된 무료 뉴런 할당량(하루 10,000 뉴런) 안에서 바로 쓸 수 있어요.

배포 절차:
1. Cloudflare 대시보드 > Pages > 이 저장소 연결 (빌드 설정 없이 정적 파일 그대로 배포)
2. **Settings > Functions > Bindings > Add binding**에서 타입 `AI`, 변수 이름 `AI`로 바인딩 추가 (키 발급 불필요)
3. (선택) 남용 방지를 위해 **Settings > Functions > KV namespace bindings**에서 `RATE_LIMIT_KV`라는 이름으로 KV 네임스페이스 연결 → IP당 하루 요청 횟수 제한이 자동으로 켜져요
   - KV 네임스페이스가 아직 없다면: 대시보드 **Storage & Databases > KV > Create namespace**로 먼저 만든 뒤, 위 바인딩 화면에서 변수 이름 `RATE_LIMIT_KV`로 방금 만든 네임스페이스를 선택하면 돼요.
4. (선택) 날씨/계절에 맞는 코디 트렌드를 핏치 답변에 반영하려면 **Settings > Environment variables**에 `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET`, `YOUTUBE_API_KEY` 추가 (아래 "코디 트렌드 & 실제 상품 추천" 항목 참고)
5. 배포 후 `/api/chat` 경로로 POST 요청이 정상 응답하는지 확인

⚠️ 하루 10,000 뉴런은 **Cloudflare 계정 전체가 공유하는 무료 한도**예요 (대화 1건당 대략 수백 뉴런 소모). 사용자가 많아지면 하루 중간에 한도가 소진될 수 있으니, 이 경우 Workers AI 사용량 기반 유료 전환을 고려해야 해요.

## 코디 트렌드 & 실제 상품 추천 (선택 기능)
아래 환경변수를 설정하면 켜져요. 전부 크롤링이 아니라 네이버/구글이 공식 제공하는 검색 API를 그대로 씀:

- **`NAVER_CLIENT_ID` / `NAVER_CLIENT_SECRET`가 있으면**
  - AI 채팅(핏치) 답변에 트렌드 반영: 채팅을 보낼 때마다 서버가 계절 + 오늘 체감온도 + 비/눈 여부 + 선택한 스타일로 **블로그 검색 API**를 호출해 상위 글 3개의 제목/요약을, 대표 옷차림 태그로 **쇼핑 검색 API**를 호출해 실제 상품 2개(이름/가격/판매처/링크)를 가져와서 핏치의 시스템 프롬프트에 참고자료로 붙여요.
  - 홈 화면 "실제 코디템 추천" 카드: `functions/api/products.js`가 오늘 추천 옷차림 태그(예: 니트, 가디건) 상위 2개로 **쇼핑 검색 API**를 호출해서 사진/가격/판매처/구매링크가 있는 상품 카드를 보여줘요. 스타일이나 위치를 바꿔서 추천 태그가 달라질 때만 다시 조회해요(같은 조건이면 재요청 안 함).
- **`YOUTUBE_API_KEY`가 있으면**: 계절 + 체감온도 + 스타일로 **YouTube Data API**를 검색해서 요즘 패션 유튜버들의 영상 제목/설명/채널명을 가져오고, 이걸 핏치의 참고자료로 붙여요. **영상이나 채널 정보는 화면에 절대 노출하지 않고**, "영상 제목·채널명을 언급하거나 시청을 권하지 말고 스타일링 아이디어만 참고해서 답하라"고 프롬프트에 명시해뒀어요. 순수하게 트렌드 파악용이에요.

모두 링크나 글 제목을 그대로 나열하지 않고 핏치 스타일로 자연스럽게 답변에 녹이도록 지시해뒀어요.

발급 방법:
1. **네이버**: [developers.naver.com](https://developers.naver.com) 로그인 > Application 등록 > 사용 API에서 "검색" 선택 (블로그, 쇼핑 검색이 포함돼 있는지 확인 — 없으면 애플리케이션 수정에서 추가) > 발급된 Client ID / Client Secret을 Cloudflare Pages 환경변수에 등록
2. **YouTube**: [Google Cloud Console](https://console.cloud.google.com) 로그인 > 프로젝트 생성 > API 라이브러리에서 "YouTube Data API v3" 활성화 > 사용자 인증 정보 > API 키 생성 (카드 등록 불필요, 약 5분 소요) > 발급된 키를 `YOUTUBE_API_KEY`로 Cloudflare Pages 환경변수에 등록

설정하지 않아도 서비스는 정상 동작해요 (이 경우 트렌드/상품 카드 없이 기본 추천만 보여줘요).

⚠️ 할당량 안내:
- 네이버 검색 API: 애플리케이션당 하루 25,000건 무료
- YouTube Data API: 프로젝트당 하루 10,000 unit 무료인데, 검색(`search.list`) 1회가 100 unit이라 **실질적으로 하루 최대 약 100회 검색**밖에 못 해요. 그래서 `RATE_LIMIT_KV`가 연결돼 있으면 같은 날씨 조건의 검색 결과를 6시간 동안 캐싱해서 실제 호출 수를 크게 줄여요(사용자가 많아도 같은 계절/기온대면 캐시를 재사용).
- 채팅·상품 조회 모두 `RATE_LIMIT_KV`로 IP당 요청 수를 제한해서 위 한도들을 추가로 보호해요.

## 참고
- 날씨(Open-Meteo), 위치 지오코딩(Open-Meteo Geocoding), 역지오코딩(BigDataCloud) API는 모두 키가 필요 없어서 브라우저에서 바로 호출돼요.
- 기본 위치는 서울시 강남구예요. 위치 권한을 허용하면 현재 위치로, 거부하면 강남구 좌표로 날씨를 보여줘요.
- 설정 탭에서 위치를 추가하면 목록에서 눌러 활성 위치를 바로 전환할 수 있고, ✕ 버튼으로 삭제할 수 있어요.
- 설정 탭 "내 정보"에서 온보딩 때 입력한 성별/키를 나중에 다시 확인하고 바꿀 수 있어요.
- 얼굴/옷 사진은 서버에 저장하지 않고 그 요청 처리에만 사용돼요. 베타 화면에도 이 안내 문구를 넣는 걸 추천해요.
- 성별/키/스타일/위치 설정은 브라우저 `localStorage`에 저장돼서, 사용자가 직접 캐시나 사이트 데이터를 지우지 않는 한 새로고침해도 유지돼요 (DB 없이 클라이언트에만 저장하는 구조라, 다른 기기·브라우저에서는 안 보여요). 채팅 기록/알림 목록은 여전히 새로고침하면 초기화돼요.
