# 설정 체크리스트

프로토타입은 `file://` 로 열지만, 로그인·데이터는 Supabase 를 쓴다.
아래는 한 번만 하면 되는 설정.

프로젝트: `ewemqbatkrmvzevmlteo` · 대시보드 <https://supabase.com/dashboard/project/ewemqbatkrmvzevmlteo>

---

## 1. DB 스키마 (SQL Editor 에서 순서대로 Run)

| 파일 | 내용 |
|---|---|
| `data/schema.sql` | venues / seasons / seatmaps + RLS + 해몽가 예시 |
| `data/consultations.sql` | 상담 기록 테이블 + RLS |
| `data/elisabeth.sql` | 엘리자벳 6연 (선택 — 예시 공연) |

## 2. Auth (로그인)

Authentication → **Providers → Email**
- **Confirm email 끄기** — `file://` 에선 확인 링크를 못 여니까.

상담 앱(`index.html`)은 이제 **로그인해야 상담 시작**이 된다.
계정은 앱의 회원가입 화면에서 만들거나, Authentication → Users → Add user.

## 3. 관리자 도구 (할인정보 / 좌석배치도 이미지 → Gemini)

`supabase/functions/admin/DEPLOY.md` 참고. 요약:
- Gemini 키 발급 → 시크릿 `ADMIN_PASSWORD` + `GEMINI_API_KEY` (별도 관리자 계정 없음)
- **CLI 로 배포** (웹 에디터는 한글 깨짐):
  `supabase functions deploy admin --project-ref ewemqbatkrmvzevmlteo --use-api --no-verify-jwt`
- 관리자 화면은 앱의 `admin.html` (함수는 JSON API 만 — Supabase 가 함수의 HTML 응답을 막음)
- 진입: 랜딩페이지 우하단 **⚙** → `admin.html`. 키는 전부 함수 시크릿에만, 폰은 비번만.

## 4. KOPIS (공연 기본정보 자동 수집)

data.go.kr "예술경영지원센터_공연예술통합전산망" 활용신청 → 키 2개(LIST/DETAIL) → `.env`
```
node data/kopis.js "엘리자벳" 2026 6elisabeth
```
→ 생성된 `data/kopis-import.sql` 을 SQL Editor 에.

---

## 데이터 흐름

```
KOPIS ─(node data/kopis.js)→ SQL ─┐
관리자도구 ─(할인/배치도 메모)─────┼→ Supabase (venues/seasons)
수동 SQL ─────────────────────────┘
                                   │
          ┌────────────────────────┤
   상담 앱 로드 시 data/seed.live.js 가 Supabase 직접 조회 (항상 최신, 터미널 불필요)
   npm run pull (선택) → data/seed.remote.js  (오프라인·커밋 스냅샷용)
                                   │
상담(index.html, 로그인) → consult.html → consultations 테이블
```

관리자 도구에서 저장하면 상담 앱을 **새로고침만** 하면 반영된다. `npm run pull` 은
오프라인 스냅샷이 필요할 때만.

`.env` 값은 `.env.example` 참고. 브라우저용 공개 설정은 `data/supabase-config.js` (커밋됨).
