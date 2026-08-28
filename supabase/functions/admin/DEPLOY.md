# 관리자 도구 배포 (CLI 없이 대시보드로)

폰에서 **할인정보 / 좌석배치도** 이미지 → Gemini 판독 → 검토 → Supabase 저장.

- **관리자 화면 = 앱의 `admin.html`** (index.html 과 같은 폴더). Supabase 가 Edge Function 의
  HTML 응답을 sandbox 로 막아서, 화면은 정적 파일로 두고 함수는 JSON API 만 한다.
- 진입: 상담 앱 랜딩페이지 우하단의 작은 **⚙ 톱니** → `admin.html`
- 인증: **공유 비밀번호 하나** (`ADMIN_PASSWORD`). 별도 계정 없음.
- 키(Gemini·service_role)는 전부 Edge Function 시크릿에만. `admin.html` 은 비번·이미지만 보낸다.

---

## 1. Gemini API 키 발급 (1회)

<https://aistudio.google.com/app/apikey> → **Create API key** → 복사 (무료 티어로 충분)

> 남용이 걱정되면 AI Studio / Google Cloud 콘솔에서 그 키에 사용량 한도를 걸어둔다.

## 2. 관리자 비밀번호 정하기

아무 문자열이나. 길게. 폰에서 한 번 입력하면 세션 동안 유지된다(`sessionStorage`).

## 3. Edge Function 배포 — CLI 로 (웹 에디터는 한글 깨짐)

```
npm i -g supabase
supabase login
supabase functions deploy admin --project-ref ewemqbatkrmvzevmlteo --use-api --no-verify-jwt
```

- `--use-api` : Docker 없이 서버에서 번들
- `--no-verify-jwt` : GET 안내·POST 를 무인증 게이트로 (POST 는 코드가 `x-admin-password` 검증)
- `config.toml` 의 `[functions.admin] verify_jwt=false` 도 같은 효과

> 웹 에디터(대시보드)로 붙여넣으면 큰 파일의 멀티바이트(한글)가 깨진다. 반드시 CLI.

## 4. 시크릿 등록

대시보드 → **Edge Functions** → **Secrets** (또는 Project Settings → Edge Functions)
- `ADMIN_PASSWORD` = 2번에서 정한 비밀번호
- `GEMINI_API_KEY` = 1번에서 받은 키
- (선택) `GEMINI_MODEL` = 기본 `gemini-3.6-flash` 외 다른 모델 쓸 때만
  (모델이 또 사라지면 API 404 에러가 대체 모델명을 알려준다 → 그 값으로 이 시크릿 설정)

> `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` 는 자동 주입되므로 등록 불필요.
> (`SUPABASE_ANON_KEY` 는 이제 안 쓴다.)

## 5. 사용

상담 앱 랜딩페이지 우하단 **⚙** → `admin.html` (또는 앱을 호스팅한 주소 뒤에 `/admin.html`)

→ 비밀번호 입력 → 탭 선택

- **할인정보** — 공연 선택 → '할인정보' 화면 캡처 업로드 → **Gemini 로 판독** → 표 확인·수정 → 저장
- **좌석배치도** — 극장 선택 → 배치도 이미지 업로드 → **판독** → 블록/시야제한 확인·수정 → 저장

`admin.html` 은 `data/supabase-config.js` 에서 함수 URL 을 읽는다. 폰에서 쓰려면 앱이
어딘가 호스팅돼 있어야 한다(`file://` 는 폰 접근 불가). 데스크탑은 `file://` 로도 됨.
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

### 할인표 (텍스트) — 대체로 정확
- 저장 전 `rate` 와 `type` 은 눈으로 확인. `type`: STANDING(누구나·상시) / ELIGIBILITY(자격 증빙) / LOYALTY(재관람 전용)
- 확인 안 되는 항목은 그 행을 **지우고** 저장 (PRD 원칙 6 — 추측값 넣지 않기).
- 저장하면 `discounts_verified = true`.

### 좌석배치도 — 거칠다. 검토 필수
- Gemini 가 뽑는 건 **층 / 블록명 / 위치(좌·중·우) / 좌석번호 범위** + 시야제한 구역.
- 통로·벽 위치와 별칭은 위치값에서 **자동 생성**된다 (좌블=번호 큰 쪽이 통로 …).
- 좌석번호 범위를 못 읽은 블록은 저장 시 버려진다. 손으로 채워 넣어도 된다.
- 저장하면 해당 `venues` 행의 `base_geometry.floors` 가 덮이고 `is_estimate=false`,
  `collected=true` 가 된다. 세부(specs·verified_seats)는 그대로.
- 미묘한 값은 데스크탑에서 `data/seed.js` 를 직접 손보는 게 낫다.

## 재배포 (코드 고쳤을 때)

```
supabase functions deploy admin --project-ref ewemqbatkrmvzevmlteo --use-api --no-verify-jwt
```

시크릿은 대시보드에서 관리하거나:
```
supabase secrets set ADMIN_PASSWORD=... GEMINI_API_KEY=... --project-ref ewemqbatkrmvzevmlteo
```
