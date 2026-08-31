# 관리자 도구 배포

폰·데스크탑에서 **기본정보 손입력 + 할인정보 / 좌석배치도** (이미지 → Gemini 초안 → 검토) → Supabase 저장.
관리자 페이지(`admin.html`)는 정적 파일이라 재배포 불필요(새로고침만) — 이 문서의 배포는 **Edge Function** 얘기다.

- **관리자 화면 = 앱의 `admin.html`** (index.html 과 같은 폴더). Supabase 가 Edge Function 의
  HTML 응답을 sandbox 로 막아서, 화면은 정적 파일로 두고 함수는 JSON API 만 한다.
- 진입: 상담 앱 랜딩페이지 우하단의 작은 **⚙ 톱니** → `admin.html`
- 인증: **공유 비밀번호 하나** (`ADMIN_PASSWORD`)를 최초 1회만 보낸다. 서버가 그 자리에서
  몇 시간짜리 세션 토큰을 발급하고, 그 뒤로 `admin.html` 은 비밀번호 원문이 아니라
  이 토큰만 저장·전송한다. 별도 계정 없음. 로그인 시도에는 IP당 레이트리밋이 걸린다.
- 키(Gemini·service_role)는 전부 Edge Function 시크릿에만. `admin.html` 은 비번·이미지만 보낸다.

---

## 1. Gemini API 키 발급 (1회)

<https://aistudio.google.com/app/apikey> → **Create API key** → 복사 (무료 티어로 충분)

> 남용이 걱정되면 AI Studio / Google Cloud 콘솔에서 그 키에 사용량 한도를 걸어둔다.

## 2. 관리자 비밀번호 정하기

아무 문자열이나. 길게. 폰에서 한 번 입력하면 그 자리에서 세션 토큰을 받아
`sessionStorage` 에 저장하고(비밀번호 자체는 저장하지 않음), 토큰이 만료되면(6시간)
다시 물어본다.

## 3. 레이트리밋 테이블 만들기 (1회, 배포 전에)

대시보드 → **SQL Editor** → `data/admin_rate_limit.sql` 내용을 붙여넣고 Run.
비밀번호 무차별 대입을 막는 테이블이다 — 안 돌려도 함수는 동작하지만 그동안은
레이트리밋 없이 열려 있다.

## 4. Edge Function 배포

### CLI (기본)
```
npm i -g supabase
supabase login
supabase functions deploy admin --project-ref ewemqbatkrmvzevmlteo --use-api --no-verify-jwt
```
- `--use-api` : Docker 없이 서버에서 번들 / `--no-verify-jwt` : GET·POST 무인증 게이트(POST 는 코드가 `x-admin-password` 검증)
- Windows PowerShell 은 `.ps1` 실행정책에 막힐 수 있다 → `supabase.cmd functions deploy ...` 또는
  `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force` 후 실행.

### Management API (CLI 가 막힐 때 — 토큰만 있으면 됨)
```
curl -X POST "https://api.supabase.com/v1/projects/ewemqbatkrmvzevmlteo/functions/deploy?slug=admin" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -F 'metadata={"name":"admin","entrypoint_path":"index.ts","verify_jwt":false};type=application/json' \
  -F 'file=@index.ts;filename=index.ts;type=application/typescript'
```
(`supabase/functions/admin/` 에서 실행. 토큰: <https://supabase.com/dashboard/account/tokens>, 쓰고 revoke.)
같은 엔드포인트 `POST /v1/projects/{ref}/database/query` `{"query":"..."}` 로 SQL(마이그레이션·pg_cron)도 실행.

> 웹 에디터(대시보드)로 붙여넣으면 큰 파일의 멀티바이트(한글)가 깨진다. CLI 나 Management API 만.
> ⚠ 한글이 든 요청 본문은 파일에 UTF-8 로 써서 `curl --data-binary @file` — 인라인 `-d '{"k":"한글"}'` 은
>   Windows 셸에서 깨진다 (라이브 데이터 한 번 손상됐던 적 있음).

## 5. 시크릿 등록

대시보드 → **Edge Functions** → **Secrets** (또는 Project Settings → Edge Functions)
- `ADMIN_PASSWORD` = 2번에서 정한 비밀번호
- `ADMIN_ALLOWED_ORIGINS` = `admin.html` 을 올릴 도메인. 예:
  `https://example.github.io` (여러 개면 쉼표로). **비워두면 file:// 로 여는 것과
  localhost/127.0.0.1(Live Server 등)만 되고, 호스팅한 admin.html 에서는 API 호출이
  CORS 로 막힌다** — 앱을 실제로 배포하면 그 도메인을 여기 반드시 추가할 것.
  (로컬 개발 origin — `file://`, `http://localhost:*`, `http://127.0.0.1:*` — 은
  이 시크릿과 무관하게 함수 코드가 항상 허용한다.)
- `GEMINI_API_KEY` = 1번에서 받은 키
- (선택) `GEMINI_MODEL` = 기본 `gemini-3.6-flash` 외 다른 모델 쓸 때만
  (모델이 또 사라지면 API 404 에러가 대체 모델명을 알려준다 → 그 값으로 이 시크릿 설정)

> `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` 는 자동 주입되므로 등록 불필요.
> (`SUPABASE_ANON_KEY` 는 이제 안 쓴다.)

## Claude 챗으로 수동 판독 (Gemini 초안이 안 맞을 때)

좌석배치도는 이미지 → **Gemini** 가 메모 초안(문단)을 뽑고, 사람이 그 메모를 고쳐서 저장한다.
(이미지에서 격자를 **자동 재구성**하던 Vision/OCR 경로는 폐지 — Claude API 는 이 관리자 도구엔 안 쓴다,
상담 에이전트 전용. 사람이 손으로 칠하는 **격자 색칠판**은 그대로 있다.)
Gemini 초안이 부실하면, 배치도 이미지를 <https://claude.ai> 챗에 직접 올려서 아래 프롬프트로 물어보고, 답을
**"좌석배치도" 탭 → 메모칸**(Gemini 초안이 들어가는 그 textarea)에 그대로
붙여넣은 뒤 **"↓ 이 메모대로 아래 표 채우기"**를 누르면 된다 — 이 형식은
`admin.html` 이 이미 파싱하는 문법이라 코드를 더 손볼 필요가 없다.

```
이 이미지는 한국 공연장의 좌석배치도야. 아래 형식의 줄로만 답해줘. 설명 없이.

1층                                    ← 층은 단독 줄로
블록 좌 1-8 / 중 9-40 / 우 41-48       ← 블록(왼쪽 통로/가운데/오른쪽 통로) 좌석범위
1-15열 9-14번 R / 15-34번 VIP / 35-40번 R   ← 열범위 좌석번호범위 등급 (등급 보이면)
1-15열 1-2번 시야제한                  ← 시야제한석은 등급으로 (정가가 따로라서)
1-15열 통로 8,9,40,41                  ← 통로석 있으면
1열 장애인석 1,2                       ← 휠체어석/장애인석 표시 있으면

여러 층이면 층마다 반복. 실제로 보이는 것만 적고, 안 보이면 그 줄은 빼.
```

메모칸 하단의 문법 설명(블록/등급/통로/장애인석/극싸·사이드, 홀수열·짝수열)이
곧 이 프롬프트가 기대하는 문법이니, Claude 답이 표로 안 채워지면 그 설명과
비교해서 형식을 맞추면 된다. 표 채우기 후에는 다른 판독 경로와 똑같이 확인 →
**"이 공연 배치도로 저장"**.

## 6. 사용

상담 앱 랜딩페이지 우하단 **⚙** → `admin.html` (또는 앱을 호스팅한 주소 뒤에 `/admin.html`)

→ 비밀번호 입력 → 탭 선택

**"공연 (시즌)" 칸은 자유입력이다.** 목록에 있는 이름을 고르면 기존 시즌을 편집하는
것이고, 목록에 없는 새 이름을 타이핑하면 **저장 버튼을 누르는 순간** 그 이름으로
새 시즌이 만들어진다(`action=create-season`) — 이미지 판독 자체는 시즌 선택과
무관하게 되니, 새 공연이어도 바로 이미지 올려서 정보를 쌓아둘 수 있다. 좌석배치도
탭에서 블록(좌석 기하)까지 저장하려면 그 공연에 극장이 있어야 한다
(할인정보·등급·통로만 쌓을 땐 극장 없이도 됨).

**"극장" 칸도 자유입력이다** — 공연 칸과 똑같이, 목록에 없는 극장명을 타이핑하면
저장 시점에 새로 만들어진다(`action=create-venue`). 열 표기(A·B·C / 1·2·3)는 안 주면
`null` 로 두고 `data.js` 가 좌석 라벨 모양으로 추론한다.

- **공연 기본정보** (좌석배치도 탭 상단 카드) — 극장 · **등급별 정가** · 개막/폐막일.
  KOPIS 미승인·불충분이라 여기서 손입력한다. 정가 표에 **시야제한** 행을 넣으면 그게
  시야제한석 정가다. → `seasons` 한 행에 저장 (`action=save-season-meta`, `prices_verified=true`).
- **할인정보** — 공연 선택(또는 새 이름 입력) → '할인정보' 화면 캡처 업로드 → **Gemini 로 판독** → 표 확인·수정 → 저장
- **좌석배치도** — 공연 선택 → 배치도 이미지(등급 색상 있는 것) 업로드 → **판독** →
  블록 / **등급 구역(열 범위)** 확인·수정 → 저장. 시야제한석은 이제 **등급**("시야제한")으로 칠한다.
  극장 기하는 `venues`, 등급 매핑은 `seasons.seat_grades` 에 열별로 펼쳐 저장.

**폐막 자동삭제** — 폐막일 7일 뒤 그 공연의 `seasons` 행이 pg_cron 으로 삭제된다
(무료플랜 용량). `venues`(극장 기하)·`consultations`(상담기록·시야만족도)는 유지.
설정 SQL 은 `data/schema.sql` 하단 참고.

`admin.html` 은 `data/supabase-config.js` 에서 함수 URL 을 읽는다. 폰에서 쓰려면 앱이
어딘가 호스팅돼 있어야 한다(`file://` 는 폰 접근 불가). 데스크탑은 `file://` 로도 됨.
홈 화면에 추가해두면 앱처럼 쓸 수 있다.

## 7. 앱에 반영

저장은 Supabase 에 바로 들어가고, 상담 앱은 **새로고침만** 하면 반영된다
(`data/seed.live.js` 가 로드 시 Supabase 를 직접 읽음). `npm run pull` 은
오프라인 스냅샷(`data/seed.remote.js`)이 필요할 때만.

---

## 판독 정확도

### 할인표 (텍스트) — 대체로 정확
- 저장 전 `rate` 와 `type` 은 눈으로 확인. `type`: STANDING(누구나·상시) / ELIGIBILITY(자격 증빙) / LOYALTY(재관람 전용)
- 확인 안 되는 항목은 그 행을 **지우고** 저장 (PRD 원칙 6 — 추측값 넣지 않기).
- 저장하면 `discounts_verified = true`.

### 좌석배치도 — 거칠다. 검토 필수
- Gemini 가 뽑는 건 메모 초안(문단) 하나뿐 — **층 / 블록명 / 위치 / 좌석번호 범위** +
  **등급 구역(열 범위, 시야제한 포함)** 을 사람이 메모칸에서 확인·수정 후 "표 채우기".
- 통로·벽 위치와 별칭은 위치값에서 **자동 생성**된다 (좌블=번호 큰 쪽이 통로 …).
- 등급 구역은 `{층, 열범위, 좌석번호범위, 등급}` — 구역 그대로 `seasons.seat_grades` 에 저장.
  같은 열에서 가운데 VIP·양끝 R 이면 좌석번호 범위로 구역을 쪼갠다 (좁은 구역 우선).
  색↔등급은 범례를 읽는다. 틀리면 행을 고치면 됨.
- 좌석번호 범위를 못 읽은 블록, 등급 없는 zone 은 저장 시 버려진다. 손으로 채워도 된다.
- `venues.base_geometry.floors` 덮임(층별 병합) + `is_estimate=false` + `collected=true`. 세부(specs·verified_seats)는 그대로.
- **공연을 다시 고르면** 저장된 블록·등급·통로·장애인석·극싸/사이드·고속도로가 표·메모에 자동으로 뜬다 —
  "저장된 표에서 격자 만들기" 로 격자도 복원. 거기서 고쳐 다시 저장.
- 미묘한 값은 라이브(Supabase) 를 SQL Editor 나 관리자 도구로 직접 손본다. `data/seed.js` 는 폴백·테스트용이라 안 건드린다.

## 재배포 (코드 고쳤을 때)

```
supabase functions deploy admin --project-ref ewemqbatkrmvzevmlteo --use-api --no-verify-jwt
```

시크릿은 대시보드에서 관리하거나:
```
supabase secrets set ADMIN_PASSWORD=... GEMINI_API_KEY=... --project-ref ewemqbatkrmvzevmlteo
```
