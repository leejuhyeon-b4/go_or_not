# 관리자 도구 배포 (CLI 없이 대시보드로)

모바일에서 할인정보 스크린샷 → Gemini 판독 → 검토 → `seasons.discounts` 저장.

---

## 1. 관리자 계정 만들기 (1회)

Supabase 대시보드 → **Authentication** → **Users** → **Add user** → **Create new user**
- 이메일 + 비밀번호 입력, "Auto Confirm User" 체크
- 이 계정으로 관리자 페이지에 로그인한다. **아무한테도 공유 금지.**

## 2. Gemini API 키 발급 (1회)

<https://aistudio.google.com/app/apikey> → **Create API key** → 복사 (무료 티어로 충분)

## 3. Edge Function 배포

대시보드 → **Edge Functions** → **Create a new function**
- 이름: `admin`
- `supabase/functions/admin/index.ts` 내용을 전부 붙여넣기 → **Deploy**

배포 후 함수 설정에서:
- **Details → Verify JWT** → **끄기** (OFF)   ← 페이지(GET)를 로그인 없이 열어야 하므로. POST 는 코드가 직접 검증함.

## 4. 시크릿 등록

대시보드 → **Edge Functions** → **Secrets** (또는 Project Settings → Edge Functions)
- `GEMINI_API_KEY` = 2번에서 받은 키
- (선택) `GEMINI_MODEL` = `gemini-2.0-flash` 외 다른 모델 쓸 때만

> `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` 는 자동 주입되므로 등록 불필요.

## 5. 사용

폰 브라우저에서:

```
https://ewemqbatkrmvzevmlteo.supabase.co/functions/v1/admin
```

→ 로그인 → 공연 선택 → 할인정보 스크린샷 촬영/업로드 → **Gemini 로 판독** → 표 확인·수정 → **저장**

홈 화면에 추가해두면 앱처럼 쓸 수 있다.

## 6. 앱에 반영

저장은 Supabase 에 바로 들어간다. 상담 앱(`index.html`)은 프리페치 방식이라,
데스크탑에서 한 번:

```
npm run pull
```

하면 `data/seed.remote.js` 가 갱신되고 반영된다.

---

## 판독 정확도

- **할인표(텍스트)** — 대체로 정확. 그래도 저장 전 `rate` 와 `type` 은 눈으로 확인할 것.
  - `type` 규칙: STANDING(누구나·상시) / ELIGIBILITY(자격 증빙 필요) / LOYALTY(재관람 전용)
- 확인 안 되는 항목은 그 행을 **지우고** 저장 (PRD 원칙 6 — 추측값 넣지 않기).
- 저장하면 `discounts_verified = true` 로 표시된다.

## CLI 로 배포하려면 (선택)

```
npm i -g supabase
supabase login
supabase link --project-ref ewemqbatkrmvzevmlteo
supabase functions deploy admin           # config.toml 의 verify_jwt=false 자동 적용
supabase secrets set GEMINI_API_KEY=...
```
