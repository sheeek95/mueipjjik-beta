# 뭐입찍? 베타

가입 없이 쓰는 날씨 기반 옷차림 추천 + AI 코디 상담 베타 서비스.

## 폴더 구조
```
index.html              프론트엔드 전체 (온보딩/홈/AI채팅/설정/알림)
functions/api/chat.js   Claude API 프록시 (Cloudflare Pages Function)
```

## 배포: Cloudflare Pages 전용
이 프로젝트는 **Cloudflare Pages**에만 배포할 수 있어요. `functions/api/chat.js`가 Cloudflare Pages Functions 런타임에서만 동작하기 때문에, GitHub Pages 같은 순수 정적 호스팅에 올리면 AI 채팅(핏치 코디 상담)이 동작하지 않아요. (과거에 있던 GitHub Pages용 `static.yml` 워크플로우가 삭제된 것도 이 이유예요.)

배포 절차:
1. Cloudflare 대시보드 > Pages > 이 저장소 연결 (빌드 설정 없이 정적 파일 그대로 배포)
2. **Settings > Environment variables**에 `ANTHROPIC_API_KEY` 추가 (Production/Preview 둘 다)
3. (선택) 남용 방지를 위해 **Settings > Functions > KV namespace bindings**에서 `RATE_LIMIT_KV`라는 이름으로 KV 네임스페이스 연결 → IP당 하루 요청 횟수 제한이 자동으로 켜져요
4. 배포 후 `/api/chat` 경로로 POST 요청이 정상 응답하는지 확인

⚠️ `functions/api/chat.js`가 호출하는 모델 ID(`claude-sonnet-4-6`)가 현재 사용 가능한 값인지 배포 전에 꼭 확인해주세요. 잘못된 모델 ID면 AI 채팅 탭 전체가 502/500 오류로 막혀요.

## 참고
- 날씨(Open-Meteo), 위치 지오코딩(Open-Meteo Geocoding), 역지오코딩(BigDataCloud) API는 모두 키가 필요 없어서 브라우저에서 바로 호출돼요.
- 기본 위치는 서울시 강남구예요. 위치 권한을 허용하면 현재 위치로, 거부하면 강남구 좌표로 날씨를 보여줘요.
- 설정 탭에서 위치를 추가하면 목록에서 눌러 활성 위치를 바로 전환할 수 있고, ✕ 버튼으로 삭제할 수 있어요.
- 얼굴/옷 사진은 서버에 저장하지 않고 그 요청 처리에만 사용돼요. 베타 화면에도 이 안내 문구를 넣는 걸 추천해요.
- 새로고침하면 상태가 초기화돼요 (DB가 없는 구조라서 그래요). 가입 기능을 붙이기 전까지는 정상 동작이에요.
