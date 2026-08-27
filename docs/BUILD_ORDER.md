# 빌드 순서 (Supabase 연동 이후)

> 다음 세션은 이 문서를 읽고 이어서 작업한다. "빌드 순서 문서대로 이어서 해줘" 라고 하면
> 아래 **다음 작업**부터 진행하면 된다.
> 설정(설치·키·SQL)은 `SETUP.md`. 데이터 파이프라인 개요도 거기.

---

## 완료됨

- **데이터 파이프라인** — `data/schema.sql`, `data/pull.js`(`npm run pull`) → `data/seed.remote.js`
  오버레이가 `data/seed.js` 위에 병합. `data.js`/`engine.js` 무수정.
- **KOPIS 수집** — `data/kopis.js` (키 2개 LIST/DETAIL, `data/kopis.js "공연명" 연도 season_id`)
  → `data/kopis-import.sql`. ⚠ data.go.kr 키 활성화 대기 중(발급 다음 영업일).
- **관리자 도구** — `supabase/functions/admin/` Edge Function. 모바일에서 할인 스크린샷
  → Gemini 판독 → 검토 → `seasons.discounts` 저장. 배포: `supabase/functions/admin/DEPLOY.md`.
  범위: 할인정보만 (좌석배치도 판독은 미구현).
- **로그인 + 상담기록** — `index.html` 로그인 게이트(Supabase Auth). `data/auth.js`(`GON_AUTH`),
  `data/supabase-config.js`, `data/consultations.sql`. 판정 후 `consult.html` 이 `consultations`
  테이블에 저장. 우상단 "이용내역" 목록.

---

## 다음 작업

### 2. 사후 피드백 모달 (PRD §3.6 · §10.1)

관람일이 지난 상담에 대해, 다음 접속 때 모달로 결과를 묻는다.

- 트리거: 로그인 후 `consultations` 중 `session_date < 오늘` 이고 `outcome IS NULL` 이고
  "나중에" 로 미룬 적 없는 것. **한 번에 하나만**, 안 하면 다음에 (§10.3 — 자주 물으면 이탈).
- 질문:
  - `result`: **갔음 / 나눔 / 안 감**
  - 갔음 → `seat_sat` (0~4: 최악/별로/보통/좋음/최고)
    + 이벤트가 있었으면 `gift_sat` (0~4)
  - 나눔 → `gift_sat` 만 (자리는 안 물음 — 데이터 오염, §3.6)
  - 안 감 → 끝
- 저장: `GON_AUTH.updateOutcome(id, { result, seat_sat, gift_sat })` (이미 `data/auth.js` 에 있음).
- 관람일 안 지났으면 이용내역에 "관람 예정" 으로만 표시, 피드백 안 물음.
- UI: `index.html` 로그인 직후 체크 → `.modal-backdrop` 재사용. "나중에" 는 localStorage
  (`gon:snooze:<id>`) 로 이번 세션만 스킵.

### 3. 폴백 모달 — 등급 + 시야제한석

`seasons` 데이터가 덜 찼을 때 상담 시작 전에 사용자에게 직접 물어 메운다.

- 트리거 조건:
  - **등급**: `GON_DB.listPrice(season, seatInfo.grade)` 가 null (다등급인데 `seat_grades` 매핑 없음)
  - **시야제한석**: `venue.collected` 가 false (좌석배치도 미수집)
- 질문 (둘 다 필요하면 한 모달에):
  - "예매하신 좌석 등급은?" → `season.prices` 키로 버튼 생성 **+ "시야제한석" 옵션**
    (시야제한석은 가격이 달라서 등급 선택지에 같이 둔다)
  - (등급 옵션에 시야제한석이 이미 있으므로 별도 예/아니오 불필요)
- 엔진 연결:
  - 등급 선택 → 번들 `seat.grade` 를 덮어씀 → `listPrice` 동작 → 비용축이 실제 숫자로 판정
  - "시야제한석" 선택 → `seat.is_restricted = true` → 시야축 반영. 정가는 지불액 그대로 사용.
- 입력값은 **상담 기록에만** 저장. Supabase `seasons` 엔 쓰지 않는다 (사용자 기억 ≠ 검증값, 원칙 6).

### 할인 폴백은 안 만든다 (결정됨)

`discounts` 미수집 시 비용축은 **degraded 모드**: "정가 X, 지불 Y, Z% 할인받으셨어요.
이 공연 할인 목록이 아직 없어 최선이었는지는 판단하지 않았습니다." — 사실만.
"더 큰 할인 받을 수 있었어요?" 같은 질문은 **안 물어본다** (사용자에게 할인 메뉴를
묻는 건 서비스가 무의미). 진짜 해결은 관리자 도구로 `discounts` 수집.
→ 현재 `engine.js agentCost` 가 이미 이렇게 동작하나, **raw 할인율을 문장으로 안 보여줌**.
   degraded 모드에서도 "Z% 받으셨어요" 는 사실로 출력하도록 `agentCost` 몇 줄 수정 필요 (작업 2 또는 3에 끼워서).

---

## 나중 (Phase 4+)

- `consultations` / `outcomes` → 익명화 → 임베딩 → RAG 유사 케이스 검색 (PRD §10)
- 축적 자리 만족도 통계 (극장×블럭) → 시야축 정확도
- `GRADE_RANK` 하드코딩 사다리(`engine.js:78`) — 비표준 등급 라벨(프리미엄/로얄) 별칭표.
  지금은 알려진 한계로 둠 (R-top 공연은 정상 동작).
- 좌석배치도 이미지 판독 (관리자 도구 확장) — 비전 정확도 낮아 항상 수동 검토 전제.
- KOPIS 정기 실행 (cron / scheduled) — 데이터가 잘 안 바뀌어 우선순위 낮음.

---

## 잠긴 설계 결정 (재논의 불필요)

| 결정 | 이유 |
|---|---|
| 상담 저장 = 로그인 + Supabase (localStorage 아님) | 서비스 데이터 축적·RAG 루프 앵커 (PRD §10.1) |
| 상담 시작 = 로그인 필수 | 사용자 요청. 익명 사용은 안 함 |
| baseline 모르면 null, 판정 보류 | 원칙 6 — "최선이었다" 단정 금지 |
| 등급 폴백 모달에 시야제한석 포함 | 가격이 다르고, 사용자가 확실히 앎 |
| 할인 폴백 질문 없음 | 사용자에게 할인 메뉴 묻기 = 서비스 무의미 |
