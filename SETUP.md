# 설정 체크리스트

프로토타입은 `file://` 로 열지만, 로그인·데이터는 Supabase 를 쓴다.
아래는 한 번만 하면 되는 설정.

프로젝트: `ewemqbatkrmvzevmlteo` · 대시보드 <https://supabase.com/dashboard/project/ewemqbatkrmvzevmlteo>

---

## 1. DB 스키마 (SQL Editor 에서 순서대로 Run)

| 파일 | 내용 |
|---|---|
| `data/schema.sql` | venues / seasons + RLS + 해몽가 예시 + **폐막 자동삭제 pg_cron** (하단) |
| `data/consultations.sql` | 상담 기록 테이블 + RLS |
| `data/admin_rate_limit.sql` | 관리자 비번 무차별 대입 방지 테이블 (`DEPLOY.md` §3) |
| `data/elisabeth.sql` | 엘리자벳 6연 (선택 — 예시 공연) |

> `seasons` 신규 컬럼(`aisle_seats` / `side_seats` / `cross_aisles` / `wheelchair_seats` / `discounts_updated_at`)은
> `schema.sql` CREATE 와 하단 `alter` 힌트에 다 있다. 라이브(`ewemqbatkrmvzevmlteo`)엔 이미 적용됨.

## 2. Auth (로그인)

Authentication → **Providers → Email**
- **Confirm email 끄기** — `file://` 에선 확인 링크를 못 여니까.

상담 앱(`index.html`)은 이제 **로그인해야 상담 시작**이 된다.
계정은 앱의 회원가입 화면에서 만들거나, Authentication → Users → Add user.

## 3. 관리자 도구 (기본정보 / 할인정보 / 좌석배치도)

`supabase/functions/admin/DEPLOY.md` 참고. 요약:
- Gemini 키 발급 → 시크릿 `ADMIN_PASSWORD` + `GEMINI_API_KEY` + `ADMIN_ALLOWED_ORIGINS`(호스팅 도메인, 로컬은 자동 허용)
- **배포**: CLI `supabase functions deploy admin --project-ref ewemqbatkrmvzevmlteo --use-api --no-verify-jwt`
  (웹 에디터는 한글 깨짐). CLI 막히면 Management API deploy 엔드포인트 (`DEPLOY.md` §4).
- 관리자 화면은 앱의 `admin.html` (함수는 JSON API 만 — Supabase 가 함수의 HTML 응답을 막음)
- 진입: 랜딩페이지 우하단 **⚙** → `admin.html`. 키는 전부 함수 시크릿에만, 폰은 비번만.
- 탭 3개 — **기본정보**(극명·시즌·극장·공연기간·등급별 정가, 손입력) / **할인정보**(이미지→Gemini) / **좌석배치도**.
  공연명·극장 칸은 자유입력 — 목록에 없으면 저장 시 새로 만들어진다(`create-season` / `create-venue`).
- 좌석배치도 입력은 두 갈래 — **메모**(한 줄에 하나) 또는 **격자로 칠하기**. 공연을 고르면 **저장된 배치도가
  표·메모에 자동 로드**되고, "저장된 표에서 격자 만들기" 로 격자도 복원된다.
  격자는 세로 열(row) × 가로 좌석번호를 그대로 펼친 판이고, 칸을 합치지 않는다 (칸 하나 = 좌석 하나).
  층마다 열범위·좌석수가 다르면 **+층** 탭으로 층별로 따로 격자를 둔다(칠한 내용은 층마다 유지).
  붓: 등급(**`시야제한` 포함** — 시야제한석은 등급이다) · 통로 · 장애인석 · 극싸/사이드(수동) · 좌석없음 · 고속도로.
  드래그로 칠한 뒤 **격자 → 아래 표 채우기** → 열범위·번호범위로 압축돼 표에 들어간다(그 층만 갱신).
  마우스로 칠할 때 열 경계 데드밴드로 옆 열 이탈을 막는다. 극싸/사이드 + 지우개 = 자동 점선까지 지운다.
  통로는 **통로에 맞닿은 좌석**에 칠한다 — 나란한 두 통로석 사이가 블록 경계(좌/중/우)가 된다.
  **좌우대칭**(기본 켜짐)을 켜두면 한쪽에 칠한 게 반대쪽 대칭 자리에도 그대로 칠해진다 — 대부분 극장이
  좌우 대칭이라 절반만 칠하면 된다(앞열 부채꼴처럼 비대칭인 열범위는 대칭을 꺼서 씀).
  **극싸/사이드는 손으로 안 칠해도 된다** — 통로 위치로 블록(좌/중/우)이 갈리면 벽·통로까지 거리로
  `data.js classifySide`/`sideZoneFor` 가 상담 때마다 자동 계산하고, 격자에도 그 결과가 항상(토글 없이)
  점선 테두리로 바로 보인다(PRD §5.2). 자동 판정이 틀리는 예외 좌석에만 극싸/사이드 붓(수동, 저장 시
  season.side_seats 로 최우선 적용)을 쓴다 — 저장되는 것도 이 수동 칠뿐이고 자동 계산은 상담 때마다
  다시 되니 저장할 필요가 없다.
  **고속도로(가로통로)**: 평소엔 안 보이다가 격자 붓 목록에서 **고속도로**를 고르면 열과 열 사이에
  클릭 자리가 나타난다 — 원하는 한 곳(예: 엘리자벳 7열-8열 사이)만 클릭하면 그 자리에 놓이고, 다른
  붓으로 바꾸면 클릭 자리는 사라지고 그 열 밑에 굵은 밑줄로만 남는다(오클릭 방지 — 이전엔 열마다
  항상 클릭 가능한 줄이 있어서 격자가 길어지고 잘못 눌리는 일이 많았다).
  `season.cross_aisles` 로 저장되고 `data.js resolveSeat` 가 `cross_aisle: 'before'|'after'|null` 로
  노출한다(아직 상담 문구·점수에는 안 씀 — 참고 데이터로만 조회 가능).

## 4. KOPIS (공연 기본정보 자동 수집) — 현재 미가용

data.go.kr "예술경영지원센터_공연예술통합전산망" 활용신청 → 키 2개(LIST/DETAIL) → `.env`
```
node data/kopis.js "엘리자벳" 2026 6elisabeth
```
→ 생성된 `data/kopis-import.sql` 을 SQL Editor 에.

⚠ **키가 아직 미활성**(`SERVICE KEY IS NOT REGISTERED`). 활성돼도 KOPIS 는 공연명·극장·기간·러닝타임만 주고
정가는 자유텍스트 파싱이라 불안정 — 그동안(그리고 그 뒤로도) **관리자 도구 "기본정보" 탭에서 손입력**한다.

---

## 데이터 흐름

```
KOPIS ─(node data/kopis.js, 현재 미가용)→ SQL ─┐
관리자도구 ─(기본정보 손입력 / 할인·배치도)────┼→ Supabase (venues / seasons)
수동 SQL ──────────────────────────────────────┘   └ pg_cron: 폐막 7일 뒤 seasons 행 삭제
                                               │
          ┌────────────────────────────────────┤
   상담 앱 로드 시 data/seed.live.js 가 Supabase 직접 조회 (항상 최신, 터미널 불필요)
   npm run pull (선택) → data/seed.remote.js  (오프라인·커밋 스냅샷용)
                                               │
상담(index.html, 로그인) → consult.html → consultations 테이블 (RLS 본인 것만)
```

관리자 도구에서 저장하면 상담 앱을 **새로고침만** 하면 반영된다. `npm run pull` 은
오프라인 스냅샷이 필요할 때만.

`.env` 값은 `.env.example` 참고. 브라우저용 공개 설정은 `data/supabase-config.js` (커밋됨).
