# 뭐입찍? 베타

가입 없이 쓰는 날씨 기반 옷차림 추천 + AI 코디 상담 베타 서비스.

## 폴더 구조
```
index.html              프론트엔드 전체 (온보딩/홈/AI채팅/설정/알림)
functions/api/chat.js   Claude API 프록시 (Cloudflare Pages Function)
```

## 배포 방법: GitHub → Cloudflare Pages (완전 무료)

### 1. GitHub에 올리기
1. GitHub에서 새 저장소 생성 (예: `mueipjjik-beta`)
2. 이 폴더 전체를 그 저장소에 push
   ```
   git init
   git add .
   git commit -m "beta v1"
   git branch -M main
   git remote add origin https://github.com/{내계정}/mueipjjik-beta.git
   git push -u origin main
   ```

### 2. Cloudflare Pages 연결
1. https://dash.cloudflare.com → **Workers & Pages** → **Create application** → **Pages** → **Connect to Git**
2. 방금 만든 GitHub 저장소 선택
3. 빌드 설정: **Framework preset: None**, Build command 비워두기, Build output directory: `/` (루트)
4. **Save and Deploy** 클릭 → 몇 분 안에 `https://mueipjjik-beta.pages.dev` 같은 무료 링크가 생겨요. 이 링크가 베타 링크예요.

### 3. Claude API 키 등록 (필수)
1. 방금 만든 Pages 프로젝트 → **Settings** → **Environment variables**
2. `ANTHROPIC_API_KEY` 이름으로 값 등록 (Production, Preview 둘 다)
3. 저장하면 자동으로 재배포되거나, **Deployments**에서 최신 배포를 **Retry** 하면 적용돼요.

### 4. (선택, 나중에 해도 됨) 익명 요청 제한용 KV 연결
가입이 없는 서비스라 AI 채팅을 무제한으로 돌릴 위험이 있어요. 지금 코드는 KV가 연결되어 있으면 **IP당 하루 20회**로 자동 제한하고, 없으면 그냥 제한 없이 동작해요.
1. Cloudflare 대시보드 → **Workers & Pages** → **KV** → 네임스페이스 생성 (예: `rate-limit`)
2. Pages 프로젝트 → **Settings** → **Functions** → **KV namespace bindings** → 변수 이름 `RATE_LIMIT_KV`로 방금 만든 네임스페이스 연결

### 이후 업데이트 방법
로컬에서 코드 수정 → `git push` 하면 Cloudflare Pages가 자동으로 재배포해요. 매번 대시보드에서 다시 설정할 필요 없어요.

## 참고
- 날씨(Open-Meteo), 위치 지오코딩 API는 키가 필요 없어서 브라우저에서 바로 호출돼요.
- 얼굴/옷 사진은 서버에 저장하지 않고 그 요청 처리에만 사용돼요. 베타 화면에도 이 안내 문구를 넣는 걸 추천해요.
- 새로고침하면 상태가 초기화돼요 (DB가 없는 구조라서 그래요). 가입 기능을 붙이기 전까지는 정상 동작이에요.
