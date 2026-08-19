/* =============================================================
   engine.js — 「이 회차 갈까말까」 목업 판단 엔진

   백엔드·LLM이 아직 없으므로 PRD의 규칙 부분을 브라우저에서 돌린다.
   - 축 점수: PRD §5의 판단 기준을 규칙으로 축약
   - 팀장:   PRD §6.3 가드레일 STEP 1~8은 원문 그대로, LLM이 맡을
             "판단" 층만 규칙으로 대체
   - 교차표·수수료표는 PRD의 표를 그대로 옮겼다 (공식으로 바꾸지 않음)

   ▶ 교체 지점: runConsult(bundle) 하나만 API 호출로 바꾸면 된다.
     화면은 Promise만 보고 있으므로 다른 코드는 손댈 필요가 없다.

   ⚠ 이 파일의 추정치(체감 등급별 적정가 밴드, 자할 폭 30%)는 DB가 생기면
     좌석배치도·정가 테이블로 교체해야 하는 임시값이다. 해당 항목은 전부
     missing_info에 기록되어 confidence를 낮춘다 (PRD 원칙 6).
   ============================================================= */
window.GON = (function(){
  "use strict";

  /* ---------------------------------------------------------
     상수 — PRD §4 가중치 / §7.2 드라이버 열거값
  --------------------------------------------------------- */
  const WEIGHTS = { DEOKSIM:1.2, SIYA:1.0, COST:1.2, EVENT:0.8, CONDITION:1.0 };
  const AGENT_ORDER = ['DEOKSIM','SIYA','COST','EVENT','CONDITION'];
  const AGENT_LABEL = {
    DEOKSIM:'덕심', SIYA:'시야', COST:'비용', EVENT:'이벤트', CONDITION:'컨디션'
  };

  /* ---------------------------------------------------------
     유틸
  --------------------------------------------------------- */
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const won = n => Number(n||0).toLocaleString('ko-KR') + '원';

  // 받침 유무로 주격 조사를 고른다 ("시야이" 같은 문장이 나오지 않게)
  function subj(word){
    const last = word.charCodeAt(word.length - 1);
    if(last < 0xAC00 || last > 0xD7A3) return word + '가';
    return word + (((last - 0xAC00) % 28) ? '이' : '가');
  }

  function base(agent, over){
    return Object.assign({
      agent: agent,
      axis_score: 0,
      primary_drivers: [],
      confidence: 0.5,
      irreplaceable: false,
      veto: false,
      defer: false,
      not_applicable: false,
      is_muted: false,
      placard: '',
      detail: '',
      missing_info: []
    }, over);
  }

  // 회색 푯말: 자리는 지키되 푯말을 들지 않는다 (PRD §7.3, design.md §5.1)
  function muted(agent, placard){
    return base(agent, { not_applicable:true, is_muted:true, confidence:1, placard:placard, detail:'' });
  }

  // 열 번호는 data.js 가 극장 표기 체계를 보고 이미 풀어서 번들에 넣어준다.
  // 번들에 없을 때만(구버전 번들 등) 표기만 보고 추론한다.
  const HANGUL_ROWS = '가나다라마바사아자차카타파하';
  function rowIndex(seat){
    if(seat && seat.row_index != null) return seat.row_index;
    const s = seat && seat.row != null ? String(seat.row).trim() : null;
    if(!s) return null;
    if(/^\d+$/.test(s)) return Number(s);
    if(/^[A-Za-z]$/.test(s)) return s.toUpperCase().charCodeAt(0) - 64;
    const h = HANGUL_ROWS.indexOf(s);
    return h > -1 ? h + 1 : null;
  }

  // 등급 서열 — 체감 등급과 지불 등급을 같은 자로 재야 gap 이 나온다
  const GRADE_RANK = { B:0, A:1, S:2, S_HIGH:2.5, R:3, R_HIGH:3.5, VIP:4 };

  function hits(patterns, text){
    if(!text) return [];
    return patterns.filter(p => p.re.test(text));
  }

  /* =========================================================
     기타란 파서 — 모든 축이 같은 해석을 나눠 쓴다

     예전에는 축마다 자기 정규식을 따로 돌려서 비용·컨디션만 기타란을
     읽었고, 덕심·시야·이벤트는 사용자가 적은 문장을 통째로 흘렸다.
     "애배는 좋은데 극이 불호"라고 적어도 덕심이 못 보던 것이 그 탓이다.
     이제 텍스트를 한 번만 훑어 슬롯을 채우고 각 축이 자기 것만 꺼낸다.

     ⚠ 슬롯은 항상 존재한다. 기타란이 비어도 빈 모양으로 돌려주므로
       축마다 null 체크를 반복하지 않는다.
     ========================================================= */

  // 컨디션 — 부담 / 완화
  const BURDEN = [
    { re:/막차|끊기|끊길|늦게|늦은\s?밤|새벽|택시|귀가/,          driver:'TRAVEL_BURDEN' },
    { re:/멀|장거리|KTX|기차|고속버스|지방|왕복|편도/,             driver:'TRAVEL_BURDEN' },
    { re:/다음\s?날|담날|내일|아침|출근|등교|학교|수업|자습|시험|과제|알바|당직|야근|회식|약속/, driver:'SCHEDULE_CONFLICT' },
    { re:/피곤|지침|지쳐|몸살|감기|아프|아픔|허리|무리|체력|컨디션\s?난조|잠\s?못/, driver:'FATIGUE' },
    { re:/연속|이틀|사흘|연달아|이번\s?주.*(또|세\s?번)/,          driver:'FATIGUE' }
  ];
  const RELIEF = [
    { re:/휴일|공휴일|주말|쉬는\s?날|연차|다음\s?날\s?쉬|쉬어도/ },
    { re:/집\s?근처|가까|도보|걸어서|차로\s?\d+분|20분|30분/ },
    { re:/낮공|여유|일찍\s?끝|괜찮/ }
  ];
  const ADVERSATIVE = /지만|하지만|그러나|그런데|근데|다만/;

  // 덕심 — 작품 자체에 대한 감정. 배우가 아니라 극을 가리키는 말만 잡는다
  const WORK_DISLIKE = /불호|취향s?아니|취향s?이?s?아닌|안s?맞|별로|노잼|재미없|지루|기대s?이하|실망|극이s?좀|작품이s?좀/;
  const WORK_LIKE    = /인생작|최애작|또s?보고s?싶|계속s?보고|극이s?좋|작품이s?좋|명작/;
  // 페어는 선택 항목이다. 사용자가 먼저 꺼냈을 때만 이쪽에서도 말한다
  const PAIR_MENTION  = /페어|조합|케미/;
  const ACTOR_MENTION = /배우|애배|본진|캐스팅|캐스트|배역/;
  const SEAT_CONCERN  = /시야|가림|가려|기둥|난간|정수리|치우|목s?아프|안s?보이/;
  const EVENT_MENTION = /이벤트|굿즈|특전|포토|사인|무대인사|커튼콜|럭드|럭키드로우|엽서|포카/;

  function quoteOf(text, re){
    const m = text ? text.match(re) : null;
    return m ? m[0] : null;
  }

  // 기타란에서 부대비용 추출 (PRD §5.3 ④)
  function extraCost(text){
    if(!text) return 0;
    let sum = 0;
    (text.match(/(\d+)\s*만\s*원?/g) || []).forEach(m => { sum += Number(m.replace(/\D/g,'')) * 10000; });
    (text.match(/(\d{4,7})\s*원/g)   || []).forEach(m => { sum += Number(m.replace(/\D/g,'')); });
    return sum;
  }

  // 기타란이 비어도 같은 모양을 돌려준다 — 축마다 null 체크를 하지 않게
  const EMPTY_FREE_TEXT = {
    raw:null, tail:'', money:0, burden:[], relief:[], reliefAny:[],
    work:  { sentiment:null, quote:null },
    pair:  { mentioned:false, quote:null },
    actor: { mentioned:false, quote:null },
    seat:  { concern:false,   quote:null },
    event: { mentioned:false, quote:null }
  };

  function parseFreeText(text){
    if(!text) return EMPTY_FREE_TEXT;

    // 역접 뒤 절을 강조로 읽는다. 앞 절의 표현은 대비지 본심이 아니다 (CASE 5)
    const parts = text.split(ADVERSATIVE);
    const tail = parts[parts.length - 1];

    // 작품 감정도 같은 규칙을 쓴다. "배우는 좋은데 극이 별로"의 본심은 뒷절이다
    let sentiment = null, workQuote = null;
    if(WORK_DISLIKE.test(tail))      { sentiment = 'DISLIKE'; workQuote = quoteOf(tail, WORK_DISLIKE); }
    else if(WORK_LIKE.test(tail))    { sentiment = 'LIKE';    workQuote = quoteOf(tail, WORK_LIKE); }
    else if(WORK_DISLIKE.test(text)) { sentiment = 'DISLIKE'; workQuote = quoteOf(text, WORK_DISLIKE); }
    else if(WORK_LIKE.test(text))    { sentiment = 'LIKE';    workQuote = quoteOf(text, WORK_LIKE); }

    return {
      raw: text,
      tail: tail,
      money: extraCost(text),
      burden: hits(BURDEN, text),
      relief: hits(RELIEF, tail),    // 완화는 뒷절에서만 — 기존 컨디션 동작 그대로
      reliefAny: hits(RELIEF, text), // "특이사항 없음" 판정용 (전체 범위)
      work:  { sentiment: sentiment, quote: workQuote },
      pair:  { mentioned: PAIR_MENTION.test(text),  quote: quoteOf(text, PAIR_MENTION) },
      actor: { mentioned: ACTOR_MENTION.test(text), quote: quoteOf(text, ACTOR_MENTION) },
      seat:  { concern:   SEAT_CONCERN.test(text),  quote: quoteOf(text, SEAT_CONCERN) },
      event: { mentioned: EVENT_MENTION.test(text), quote: quoteOf(text, EVENT_MENTION) }
    };
  }

  /* =========================================================
     1. 덕심 — 오늘 이 회차가 나에게 얼마나 특별한가 (PRD §5.1)

     예전에는 불리언 세 개(애배 출연·자첫·촬영허용)만 봤다. 그래서
     "애배는 나오는데 극이 불호"인 회차를 애배 하나로 밀어 올렸다.
     이제 작품 선호도가 덕심이 낼 수 있는 최대치를 정한다.
     ========================================================= */
  // 작품 선호도 — 가산치와 상한을 함께 준다.
  // 상한이 있어야 "애배도 나오고 사인회도 있는데 극은 불호"가 플러스로 새지 않는다.
  const AFF_DELTA = { LOVE:1, LIKE:0, MEH:-1, DISLIKE:-2 };
  const AFF_CAP   = { LOVE:2, LIKE:2, MEH: 1, DISLIKE: 0 };
  const AFF_LABEL = {
    LOVE:'인생작', LIKE:'좋아하는 작품', MEH:'무난한 작품', DISLIKE:'잘 안 맞는 작품'
  };

  function agentDeoksim(b, ft){
    const fav   = !!(b.casting && b.casting.has_favorite_actor);
    const first = !!b.first_watch;
    const evts  = b.events || [];

    // 촬영허용만 특별취급하던 것을 배우 매개 이벤트 전반으로 넓힌다.
    // 사귀회·무대인사·사인회는 애배가 나와야 값이 생기는 종류다 (PRD §5.4)
    const actorEvts = evts.filter(e => e.is_actor_mediated || e.photo_allowed);
    const otherEvts = evts.filter(e => !e.is_actor_mediated && !e.photo_allowed);
    const actorEvent = actorEvts.length > 0;

    // 선호도는 폼 응답이 우선. 자첫이면 폼에 질문이 뜨지 않으므로 기타란만 남는다.
    // 글만 보고 극단(DISLIKE)으로 가지는 않는다 — 직접 고른 답과 같은 무게로 두지 않는다.
    let aff = b.work_affinity || null;
    const affFromText = !aff && !!ft.work.sentiment;
    if(affFromText) aff = ft.work.sentiment === 'DISLIKE' ? 'MEH' : 'LIKE';

    let raw = 0;
    const drivers = [];
    if(fav){   raw += 2; drivers.push('FAVORITE_ACTOR'); }
    if(first){ raw += 1; drivers.push('FIRST_WATCH'); }
    if(fav && actorEvent){
      raw += 1;
      drivers.push(actorEvts.some(e => e.photo_allowed) ? 'PHOTO_ALLOWED' : 'ACTOR_EVENT');
    }
    if(aff){ raw += AFF_DELTA[aff]; drivers.push('WORK_AFFINITY'); }

    // 게이트 — 선호도가 상한을 건다. 애배가 나와도 불호작이면 0을 넘지 못한다.
    // 덕심이 마이너스를 내는 통로는 이 축에서 작품 불호 하나뿐이다 (애배 미출연은 0이다)
    const score = clamp(aff ? Math.min(raw, AFF_CAP[aff]) : raw, -2, 2);
    const affNeg = aff === 'DISLIKE' || aff === 'MEH';

    /* ---- 푯말 (16자 계약) ---- */
    let placard;
    if(score >= 2)                 placard = actorEvent ? '남길 것이 있는 날'
                                            : first     ? '애배와 자첫이 겹쳐요'
                                                        : '오늘 그 배우 나와요';
    else if(score === 1)           placard = fav ? '배우는 확실한 날'
                                            : first ? '이 작품 자첫이죠'
                                                    : '조금은 특별해요';
    else if(score === 0)           placard = (fav && affNeg) ? '배우는 좋은데 극이'
                                                             : '캐스팅은 평범해요';
    else if(score === -1)          placard = '오늘 극이 좀 그래요';
    else                           placard = '오늘 극이 안 맞아요';

    /* ---- 말풍선 (100~180자 계약) — 절을 조립하고 길이로 잘라낸다 ----
       브랜치가 늘어 손으로 쓴 문장 다섯 개로는 계약을 못 지킨다.
       필수 절로 뼈대를 만들고, 선택 절은 180자에 들어갈 때만 붙인다. */
    const len = s => Array.from(s).length;

    const castClause =
      fav && first ? '오늘 애배가 나오는데 이 작품 자첫이기도 합니다.'
      : fav        ? '애배가 오늘 캐스팅에 있습니다.'
      : first      ? '애배는 없지만 이 작품을 처음 보는 회차입니다.'
                   : '애배도 없고 자첫도 아닙니다.';

    const workClause =
      affFromText ? '기타란의 「' + ft.work.quote + '」를 작품에 대한 이야기로 읽고 반영했습니다.'
      : aff       ? '작품 자체에 대해서는 「' + AFF_LABEL[aff] + '」이라고 답해주셨습니다.'
      : first     ? '자첫이라 작품이 나와 맞는지는 아직 알 수 없어 판단하지 않았습니다.'
                  : '';

    const verdictClause =
      score >= 2   ? '덕심 축에서는 오늘 회차의 특별도를 가장 높은 쪽으로 봅니다. 놓치면 같은 장면을 다시 만들 방법이 없는 종류입니다.'
      : score === 1 ? '덕심 축에서는 오늘 회차를 플러스로 봅니다. 결정적이지는 않아도 다른 조건이 비슷하다면 여기서 차이가 납니다.'
      : score === 0 && fav && affNeg
                    ? '배우 쪽은 밀고 작품 쪽은 붙잡습니다. 덕심 축은 어느 쪽으로도 기울지 않았고, 오늘 결론은 나머지 축에 맡깁니다.'
      : score === 0 ? '덕심 축에서 오늘 이 회차를 특별하게 만들 요소는 잡히지 않았습니다. 마이너스라는 뜻이 아니라 할 말이 별로 없다는 뜻입니다.'
                    : '덕심 축은 오늘 회차를 붙잡는 쪽입니다. 배우로도 작품으로도 오늘을 밀어줄 이유가 잡히지 않습니다.';

    // 선택 절 — 자리가 남을 때만 붙는다
    const names = a => a.map(e => e.label).filter(Boolean).join('·');
    const optional = [];
    if(fav && actorEvent){
      optional.push('오늘 ' + (names(actorEvts) || '배우 이벤트') + '까지 열려 배우 쪽 무게가 한 번 더 실립니다.');
    } else if(actorEvent){
      optional.push('오늘 ' + (names(actorEvts) || '배우 이벤트') + '가 있지만 애배가 없어 덕심에는 싣지 않았습니다.');
    }
    if(otherEvts.length){
      optional.push('오늘 ' + (names(otherEvts) || '이벤트') + '도 있는데 배우와 무관한 종류라 이벤트 축이 따로 봅니다.');
    }
    // 페어는 사용자가 먼저 꺼냈을 때만 말한다. 관람 이력 데이터가 없어 점수는 못 낸다
    if(ft.pair.mentioned){
      optional.push('페어 이야기를 적어주셨는데, 관람 이력이 없어 점수에는 넣지 못했습니다.');
    }

    let detail = [castClause, workClause, verdictClause].filter(Boolean).join(' ');
    optional.forEach(c => { if(len(detail + ' ' + c) <= 180) detail += ' ' + c; });
    if(len(detail) < 100) detail += ' 이 축은 오늘 회차가 나에게 얼마나 특별한지만 봅니다.';

    // 확인 못 하는 것은 적지 않는다. 남은 애배 회차·페어 관람 이력은 수집 경로가 없다
    const missing = [];
    if(!aff && !first) missing.push('이 작품 선호도');

    return base('DEOKSIM', {
      axis_score: score,
      primary_drivers: drivers,
      confidence: b.work_affinity ? 0.7 : (affFromText ? 0.55 : (fav || first ? 0.6 : 0.5)),
      // 불호·무난작에서는 대체불가로 결론을 밀어붙이지 않는다 (aggregate STEP 판단층)
      irreplaceable: fav && actorEvent && !affNeg,
      placard: placard,
      detail: detail,
      missing_info: missing
    });
  }

  /* =========================================================
     2. 시야 — 이 자리가 오늘 나의 목적에 맞는가 (PRD §5.2)
     기준선은 연뮤덕 기준 v2.0: 가까운 쪽 선호를 기본 가정
     ========================================================= */
  const FELT_GRADES = ['B','A','S','R','R_HIGH'];   // feltRank 0~4 → 체감 등급

  function agentSiya(b, ft){
    const floor = b.seat.floor;
    const r = rowIndex(b.seat);
    const prefs = [b.seat_preference.first, b.seat_preference.second].filter(Boolean);
    const glass = !!b.opera_glass;
    const drivers = ['SEAT_QUALITY'];
    const missing = [];

    let score = 0, feltRank = 2;

    // ── 거리·각도 기본선
    if(floor === 1){
      if(r == null){ score = 0; feltRank = 2; missing.push('열 표기 해석 실패'); }
      else if(r <= 3){ score = 1; feltRank = 3; }        // 배우 관찰 명당
      else if(r <= 12){ score = 2; feltRank = 4; }       // 작품 감상 명당 (중앙 5~12열)
      else if(r <= 20){ score = 0; feltRank = 2; }
      else { score = -1; feltRank = 1; }
    } else if(floor === 2){
      score = -1; feltRank = 1;
    } else if(floor === 3){
      score = -2; feltRank = 0;
    } else {
      missing.push('층 정보');
    }

    // ── 오페라글라스: 거리는 보정하지만 각도는 보정하지 못한다
    let glassNote = '';
    if(glass){
      if(floor === 1 && r != null && r >= 13){
        score += 1;
        glassNote = ' 오글을 드신다니 거리는 상당 부분 메워집니다.';
      } else if(floor >= 2){
        glassNote = ' 오글은 거리를 당겨주지만 내려다보는 각도까지 바꾸지는 못합니다.';
      }
    }

    // ── 선호 좌석 부합 (1순위 ×1.0, 2순위 ×0.5)
    let fit = 0;
    prefs.forEach((key, i) => {
      const w = i === 0 ? 1 : 0.5;
      let f = 0;
      switch(key){
        case 'FRONT':
          if(floor === 1 && r != null){ f = r <= 6 ? 1 : (r >= 13 ? -1 : 0); }
          break;
        case 'CENTER': {
          // DB에서 확정된 zone 이 있으면 그것을 쓰고, 없으면 사용자가 적은 블럭명을 본다
          const z = b.seat.zone || b.seat.block;
          if(z == null){ missing.push('블럭 경계 (좌석배치도 미수집)'); }
          else if(/중|센터|C/i.test(z)) f = 1;
          else f = -0.5;
          break;
        }
        case 'WHOLE':
          if(floor >= 2) f = 1;
          else if(r != null) f = r >= 8 ? 1 : (r <= 3 ? -1 : 0);
          break;
        case 'ACTOR_PATH': {
          const side = b.seat_preference.actor_path_side;
          const blk = b.seat.block || '';
          if(!side || !blk){ missing.push('애배 동선과 블럭 대조'); }
          else if((side === 'LEFT' && /좌|왼|L/i.test(blk)) ||
                  (side === 'RIGHT' && /우|오|R/i.test(blk)) ||
                  (side === 'CENTER' && /중|센터|C/i.test(blk))) f = 1;
          break;
        }
        case 'AISLE':
          // 통로 인접 여부는 좌석배치도에서 확정된 것만 쓴다. 추측하지 않는다.
          if(b.seat.is_aisle === true){ f = 1; drivers.push('SEAT_QUALITY'); }
          else if(b.seat.is_aisle === false) f = -0.5;
          else missing.push('통로 인접 여부 (좌석배치도 미수집)');
          break;
        case 'VALUE':
          break;   // 아래에서 상대 위치 해석으로 처리
      }
      if(f !== 0) drivers.push('SEAT_PREFERENCE_FIT');
      fit += f * w;
    });

    score += Math.round(fit);

    // ── VALUE 포함 시 절대 좌표가 아니라 등급 내 상대 위치로 해석 (CASE 6)
    const valueMode = prefs.includes('VALUE');
    if(valueMode && score < 0) score += 1;

    score = clamp(score, -2, 2);

    // 비용에게 넘길 유일한 값 (PRD §5.2 출력 추가 필드)
    const feltGrade = FELT_GRADES[feltRank];
    const paidGrade = b.seat.grade || null;          // 좌석배치도에서 온 실제 등급
    const seat_value_grade = {
      paid_grade: paidGrade,
      felt_grade: feltGrade,
      felt_rank: feltRank,
      // "이 자리가 실제로 그 등급값을 하는가" — 등급을 알 때만 계산된다
      gap: paidGrade != null && GRADE_RANK[paidGrade] != null
             ? Math.round((GRADE_RANK[feltGrade] - GRADE_RANK[paidGrade]) * 10) / 10
             : null,
      source: (b.seat.sources && b.seat.sources[0]) || null
    };

    // DB가 못 채운 항목은 그대로 남긴다 (data.js 가 이미 목록으로 넘겨준다)
    (b.seat.unknown || []).forEach(u => missing.push(u));
    if(b.seat.notes && b.seat.notes.length) b.seat.notes.forEach(n => { glassNote += ' ' + n + '.'; });
    const uncertain = missing.length >= 2;

    // 방향(좌/우) 우열은 판정하지 않는다. 위치는 사실로만 서술한다 (PRD §5.2)
    const whereFull = (floor ? floor + '층 ' : '') + (b.seat.row ? b.seat.row + '열' : '') +
                      (b.seat.block ? ' ' + b.seat.block : '');
    const whereShort = (floor ? floor + '층 ' : '') + (b.seat.row ? b.seat.row + '열' : '');
    // 푯말 16자 계약을 지키려면 블럭 이름이 길 때 위치 표기를 줄인다 (PRD §7.3)
    const place = tail => {
      const full = (whereFull || '이 자리') + tail;
      if(Array.from(full).length <= 16) return full;
      const short = (whereShort || '이 자리') + tail;
      return Array.from(short).length <= 16 ? short : '이 자리' + tail;
    };
    const where = whereFull || '이 자리';

    let placard, detail;
    if(score >= 2){
      placard = place(', 좋아요');
      detail = where + ' 자리입니다. 연뮤덕 기준으로 보면 무대와의 거리도, 전체를 한 번에 담는 폭도 무리가 없는 구간입니다. 오늘 고르신 선호 좌석과도 크게 어긋나지 않습니다.' + glassNote + ' 통로 인접 여부와 등급 정보는 좌석배치도가 없어 확인하지 못했습니다.';
    } else if(score === 1){
      placard = place(', 무난해요');
      detail = where + ' 자리입니다. 오늘 목적에 크게 어긋나지 않는 위치이고, 아쉬운 부분이 있더라도 관람 자체를 방해할 정도는 아닙니다. 시야 축에서는 무난한 쪽으로 봅니다.' + glassNote + ' 좌석배치도 데이터가 없어 확실하지는 않습니다.';
    } else if(score === 0){
      placard = place('입니다');
      detail = where + ' 자리입니다. 시야 축에서 특별히 좋다고도 나쁘다고도 말하기 어려운 구간이라 중립으로 두었습니다. 좌우 어느 블럭이 유리한지는 오늘 연출에 달린 문제라 판단하지 않았습니다.' + glassNote + ' 통로·블럭 경계 데이터도 없습니다.';
    } else if(score === -1){
      placard = place(', 조금 멀어요');
      detail = where + ' 자리입니다. 무대와 거리가 있어 표정 단위의 관찰은 어려운 구간이고, 오늘 고르신 선호와도 조금 어긋납니다. 다만 어느 쪽 블럭이 유리한지는 오늘 연출을 모르므로 판단하지 않았습니다.' + glassNote;
    } else {
      placard = place(', 각도 아쉬워요');
      detail = where + ' 자리입니다. 거리보다 내려다보는 각도가 이 자리의 성격을 결정하는 구간입니다. 시야 축에서는 오늘 목적과 가장 멀다고 봅니다.' + glassNote + ' 이 자리가 오늘 연출과 어떻게 맞물리는지는 확인된 정보가 없습니다.';
    }

    // 기타란에 좌석 걱정을 적으셨으면 언급한다. 다만 점수는 좌석 데이터가 정한다 —
    // 사용자의 불안을 근거로 시야 점수를 흔들면 확인된 사실과 인상이 뒤섞인다
    if(ft.seat.concern && ft.seat.quote){
      // 앞 문장이 이미 '좌석배치도가 없어…'로 끝난다. 같은 말을 두 번 하지 않는다
      const note = ' 기타란의 「' + ft.seat.quote + '」 걱정은 좌석 사실이 아니라 점수에 넣지 않았습니다.';
      const dlen = t => Array.from(t).length;
      if(dlen(detail + note) <= 180){
        detail += note;
      } else {
        // 180자 계약이 우선이다. 자리가 없으면 끝 문장 하나를 이 노트로 바꾼다
        const swapped = detail.replace(/s[^.]*.s*$/, '') + note;
        if(dlen(swapped) >= 100 && dlen(swapped) <= 180) detail = swapped;
      }
      missing.push('기타란에 적으신 시야 우려');
    }

    return base('SIYA', {
      axis_score: score,
      primary_drivers: Array.from(new Set(drivers)),
      // 좌석배치도에서 확정된 사실이 많을수록 확신이 올라간다
      confidence: (ft.seat.concern ? 0.9 : 1) *
                  (0.4 + (b.seat.is_aisle !== null ? 0.15 : 0)
                      + (paidGrade != null ? 0.15 : 0)
                      + (b.seat.zone ? 0.1 : 0)),
      placard: placard,
      detail: detail,
      missing_info: Array.from(new Set(missing)),
      seat_value_grade: seat_value_grade,
      uncertain: uncertain            // 화면에 "확실하지 않음" 표기
    });
  }

  /* =========================================================
     3. 비용 — 이 돈이 합당한가, 안 가면 무엇을 잃는가 (PRD §5.3)
     ========================================================= */
  // 취소 수수료 자동 계산 (PRD §5.3 ③). 예매처별 차이는 seasons에서 받아야 한다.
  // 예매처·공연마다 규정이 다르므로 seasons.cancellation_policy 를 먼저 본다.
  // 수집 전이면 아래 기본 규정을 쓴다 (PRD §5.3 ③).
  const DEFAULT_CANCEL_POLICY = [
    { min_days:10, rate:0.10, cap:4000 },
    { min_days:7,  rate:0.10, cap:null },
    { min_days:3,  rate:0.20, cap:null },
    { min_days:0,  rate:0.30, cap:null }
  ];

  function cancellationFee(b){
    if(b.payment.acquisition === 'TRANSFER'){
      return { cancellable:false, fee:null, reason:'양도받은 표는 원 예매자만 취소할 수 있어요' };
    }
    if(!b.session.datetime) return { cancellable:false, fee:null, reason:'공연 일시 미상' };

    const show = new Date(b.session.datetime);
    const now = b.session.now ? new Date(b.session.now) : new Date();
    const paid = Number(b.payment.total_paid) || 0;

    const cutoff = new Date(show); cutoff.setDate(cutoff.getDate() - 1); cutoff.setHours(17,0,0,0);
    if(now >= cutoff) return { cancellable:false, fee:null, reason:'전날 17시가 지나 취소할 수 없어요' };

    const policy = (b.season && b.season.cancellation_policy) || DEFAULT_CANCEL_POLICY;
    const collected = !!(b.season && b.season.cancellation_policy);

    const d = Math.floor((show - now) / 86400000);
    const tier = policy.find(t => d >= t.min_days) || policy[policy.length - 1];
    let fee = paid * tier.rate;
    if(tier.cap != null) fee = Math.min(tier.cap, fee);

    return { cancellable:true, fee: Math.round(fee), days:d, reason:null, from_db: collected };
  }

  function agentCost(b, siya, ft){
    const paid = (Number(b.payment.total_paid)||0) + (Number(b.payment.surcharge)||0);
    const opts = b.disposal_options || [];
    const cancel = cancellationFee(b);
    const extra = ft.money;
    const drivers = [];
    const missing = [];

    /* ① 지불 대비 좌석 가치
       정가 테이블이 있으면 할인율로 판단하고, 없으면 판단하지 않는다.
       CASE 5의 51,000원을 S석 정가로 오판한 것이 바로 이 자리의 실패였다. */
    const svg = siya.seat_value_grade || {};
    const list = b.payment.list_price;
    const rate = b.payment.discount_rate;   // data.js 가 정가 대비로 산출
    let valueScore = 0, priceLine;

    if(list != null){
      if(rate >= 0.35)      valueScore = 2;
      else if(rate >= 0.15) valueScore = 1;
      else if(rate > 0)     valueScore = 0;
      else if(rate === 0)   valueScore = 0;
      else                  valueScore = -1;   // 정가보다 더 냈다 (수수료·플미)
      priceLine = (b.payment.list_price_grade ? b.payment.list_price_grade + '석 ' : '') +
                  '정가 ' + won(list) +
                  (rate > 0 ? '에서 ' + Math.round(rate*100) + '% 할인된 값입니다.'
                            : '과 같거나 그 이상을 내셨습니다.');
      if(b.payment.list_price_verified === false){
        missing.push('정가 확인 (추정값)');
        priceLine += ' 다만 이 정가는 확인된 값이 아니라 추정치입니다.';
      }
      drivers.push('PRICE_GAP');
    } else {
      // 정가를 모르면 가격의 적정성은 판단하지 않는다 (원칙 6)
      missing.push('등급별 정가 (예매처 미수집)');
      priceLine = '이 시즌의 정가 테이블이 아직 수집되지 않아 지불액이 자리에 비해 비싼지 싼지는 판단하지 않았습니다.';
    }

    // 낸 등급 대비 체감 등급 차이 — 시야가 준 유일한 값
    if(svg.gap != null){
      if(svg.gap <= -1)      valueScore -= 1;
      else if(svg.gap >= 1)  valueScore += 1;
      drivers.push('PRICE_GAP');
      priceLine += ' ' + svg.paid_grade + '석 값을 내셨는데 체감은 ' + svg.felt_grade + '급으로 잡힙니다.';
    } else if(svg.paid_grade == null){
      missing.push('좌석 등급 (좌석배치도 미수집)');
    }
    valueScore = clamp(valueScore, -2, 2);

    // ② 손실 — 사용자는 가능한 처분 경로 중 가장 손실이 작은 쪽을 택한다
    const candidates = [];
    if(opts.includes('TRANSFERABLE')) candidates.push({ loss:0, how:'양도' });
    if(opts.includes('NEEDS_PROOF'))  candidates.push({ loss:0, how:'증빙 도움을 주며 양도', friction:true });
    if(opts.includes('SELF_DISCOUNT')){
      candidates.push({ loss: Math.round(paid*0.30), how:'자할 양도' });   // ⚠ 자할 폭 30% 가정
      missing.push('자할 폭');
    }
    if(opts.includes('SHARING'))      candidates.push({ loss: paid, how:'나눔', keepsBenefit:true });
    if(opts.includes('NO_TRANSFER'))  candidates.push({ loss: paid, how:'그냥 안 감' });
    if(cancel.cancellable)            candidates.push({ loss: cancel.fee, how:'취소' });
    if(!candidates.length)            candidates.push({ loss: paid, how:'그냥 안 감' });

    candidates.sort((a,c) => a.loss - c.loss);
    const best = candidates[0];
    drivers.push('LOSS_RISK');
    if(cancel.cancellable) drivers.push('CANCELLATION_FEE');

    // ⚠ NO_TRANSFER를 무조건 관람 쪽으로 밀지 않는다 (CASE 6)
    //    손실 절대액이 작으면 오히려 포기해도 되는 근거가 된다
    let lossScore = 0;
    if(best.loss >= 100000)     lossScore = 1;
    else if(best.loss >= 40000) lossScore = 0.5;
    else                        lossScore = 0;
    if(best.friction) lossScore -= 0.5;

    let score = clamp(Math.round(valueScore + lossScore), -2, 2);

    // ③ 서술
    let placard;
    if(best.loss >= 100000)      placard = '안 가면 ' + Math.round(best.loss/10000) + '만원 손해';
    else if(list == null)        placard = '가격은 판단 보류';
    else if(score >= 2)          placard = '값은 충분히 했어요';
    else if(score === 1)         placard = '지불액은 무난해요';
    else if(score === 0)         placard = '가격은 평범해요';
    else if(score === -1)        placard = '자리에 비해 비싸요';
    else                         placard = '이 자리에 과지출이에요';

    let detail = '실지불액 ' + won(paid) + '입니다. ' + priceLine +
      ' 안 가기로 하면 ' + subj(best.how) + ' 가장 손실이 작아 ' + won(best.loss) + '을 잃습니다.';
    if(cancel.cancellable){
      detail += ' 지금 취소하면 수수료는 ' + won(cancel.fee) + '입니다';
      detail += cancel.from_db ? ' (이 공연 취소 규정 기준).' : ' (예매처 일반 규정 기준).';
    } else if(cancel.reason){
      detail += ' ' + cancel.reason + '.';
    }
    if(extra) detail += ' 기타란의 부대비용 ' + won(extra) + '도 함께 나갑니다.';

    // 정가·등급이 모두 DB에서 왔으면 확신을 올린다
    const solid = (list != null && b.payment.list_price_verified !== false) && svg.paid_grade != null;

    return base('COST', {
      axis_score: score,
      primary_drivers: Array.from(new Set(drivers)),
      confidence: solid ? 0.75 : (list != null ? 0.6 : 0.35),
      placard: placard,
      detail: detail,
      missing_info: Array.from(new Set(missing)),
      loss: best.loss,
      loss_how: best.how,
      cancellation: cancel,
      extra_cost: extra
    });
  }

  /* =========================================================
     4. 이벤트 — 사용자 응답을 축 신호로 변환 (PRD §5.4)
     ========================================================= */
  // 끌림도 × 희소성 교차표. 공식이 아니라 표다 (CASE 1·2 회귀)
  const EVENT_TABLE = {
    0:{ MANY:0, FEW:0, NONE:0 },
    1:{ MANY:0, FEW:0, NONE:0 },
    2:{ MANY:0, FEW:1, NONE:1 },
    3:{ MANY:1, FEW:1, NONE:2 },
    4:{ MANY:2, FEW:2, NONE:2 }
  };
  const APPEAL_LABEL = ['쓸모없음','별로','보통','끌림','가고싶음'];

  function agentEvent(b, ft){
    const evts = b.events || [];
    if(!evts.length){
      // 폼에는 "없음"인데 기타란에 이벤트를 적은 경우. 지금까지는 아무 말 없이 버려졌다
      return muted('EVENT', ft.event.mentioned ? '기타란 이벤트는 미반영' : '오늘은 이벤트가 없어요');
    }

    const appeal = evts[0].user_appeal;
    const scarcity = evts[0].user_scarcity;
    if(appeal == null || scarcity == null) return muted('EVENT', '이벤트 응답이 없어요');

    let score, missing = [];
    if(scarcity === 'UNKNOWN'){
      score = Math.round(EVENT_TABLE[appeal].FEW * 0.7);   // 승수 0.7 + confidence 하락
      missing.push('이벤트 희소성');
    } else {
      score = EVENT_TABLE[appeal][scarcity];
    }

    const drivers = ['EVENT_APPEAL'];
    if(scarcity === 'NONE' || scarcity === 'FEW') drivers.push('EVENT_SCARCITY');
    if(evts.some(e => e.photo_allowed)) drivers.push('PHOTO_ALLOWED');
    // 배우 매개형 이벤트는 덕심과 같은 원인에서 나온다 → 팀장이 중복 할인 (PRD §7.2)
    if(evts.some(e => e.is_actor_mediated) && b.casting.has_favorite_actor) drivers.push('FAVORITE_ACTOR');

    const fixed = evts.some(e => e.certainty_class === 'FIXED');
    const irreplaceable = appeal >= 3 && scarcity === 'NONE' && fixed;

    const names = evts.map(e => e.label).filter(Boolean).join('·');

    let placard;
    if(score >= 2)      placard = '오늘 아니면 못 받아요';
    else if(score === 1) placard = '챙길 만한 게 있어요';
    else                 placard = '크게 끌리진 않네요';

    let detail = '오늘은 ' + (names || '이벤트') + '이 있고, 얼마나 끌리는지는 「' + APPEAL_LABEL[appeal] + '」이라고 답해주셨습니다. ';
    if(score === 0 && appeal <= 1){
      detail += '다시 만날 기회가 없더라도 애초에 관심이 크지 않은 이벤트를 놓치는 것은 아무것도 잃는 것이 아닙니다. 그래서 희소성을 곱하지 않고 이 축은 0으로 둡니다. 이벤트가 오늘 회차를 밀어주지는 않는다는 뜻입니다.';
    } else if(irreplaceable){
      detail += '내용이 사전에 확정되는 유형인데다 다시 만날 기회가 없다고 하셨으니, 오늘 이 회차에서만 가능한 것으로 보고 있습니다. 이벤트 축에서 낼 수 있는 가장 강한 신호입니다.';
    } else if(scarcity === 'UNKNOWN'){
      detail += '다시 만날 기회가 있는지 모르겠다고 하셔서 값을 한 단계 낮춰 보수적으로 잡았습니다. 정보가 빈 자리라 이 축의 확신은 낮은 편이고, 팀장 쪽에도 그렇게 전달됩니다.';
    } else {
      detail += '여기에 다시 만날 기회까지 곱해서 보면, 오늘 회차를 이벤트 하나로 밀어줄 만큼은 아니지만 자리를 지킬 정도는 됩니다. 이벤트 축은 원래 목소리가 가장 작은 축입니다.';
    }

    return base('EVENT', {
      axis_score: clamp(score, -2, 2),
      primary_drivers: drivers,
      confidence: scarcity === 'UNKNOWN' ? 0.4 : 0.7,
      irreplaceable: irreplaceable,
      placard: placard,
      detail: detail,
      missing_info: missing
    });
  }

  /* =========================================================
     5. 컨디션 — 오늘 이 회차를 물리적으로 감당할 수 있는가 (PRD §5.5)
     기타란이 비면 호출하지 않는다
     ========================================================= */
  function agentCondition(b, ft){
    const text = b.free_text;
    // 기타란이 비어 있으면 호출 자체를 하지 않는다 (PRD §5.5 발동 조건)
    if(!text) return muted('CONDITION', '적어주신 내용이 없어요');

    // 정규식은 공용 파서가 이미 돌렸다. 역접 처리(CASE 5)도 그쪽에서 끝난다
    const burdenHits = ft.burden;
    if(!burdenHits.length && !ft.reliefAny.length){
      return muted('CONDITION', '특이사항 없음');
    }
    const reliefHits = ft.relief;

    const burden = burdenHits.length;
    const relief = reliefHits.length;
    const drivers = Array.from(new Set(burdenHits.map(h => h.driver)));

    // ── 거부권 (PRD §5.5)
    const noRideHome   = /막차.*(없|끊|애매|아슬|아리)|귀가.*(불가|어려|힘들)|택시.*(밖에|없)/.test(text);
    const mustSchedule = /(필수|반드시|꼭|무조건).*(일정|약속|시험|출근)|(일정|약속).*(못\s?미루|미룰\s?수\s?없)/.test(text);
    const healthIssue  = /많이\s?아프|몸살|병원|입원|열이\s?나|어지럽|앓/.test(text);
    const stacked      = burden >= 3 && relief === 0;

    if(noRideHome || mustSchedule || healthIssue || stacked){
      const why = noRideHome ? '돌아올 방법이 확실하지 않습니다'
                : healthIssue ? '몸 상태가 관람을 버틸 상태가 아닙니다'
                : mustSchedule ? '미룰 수 없는 일정과 겹칩니다'
                : '부담 요소가 여러 개 겹쳐 있습니다';
      return base('CONDITION', {
        axis_score: -2,
        primary_drivers: drivers.length ? drivers : ['FATIGUE'],
        confidence: 0.7,
        veto: true,
        placard: '오늘 몸이 못 버텨요',
        detail: '적어주신 내용에서 ' + why + '. 하나하나는 넘길 수 있는 것들이지만 컨디션은 누적으로 작동하는 축이라, 각각이 결정적이지 않다는 이유로 넘기지 않았습니다. 이 축은 오늘 관람을 감당하기 어렵다고 봅니다.',
        missing_info: []
      });
    }

    // ── defer: 부담은 있으나 감당 가능성을 시스템이 판단할 수 없는 경우 (PRD 원칙 5)
    const selfJudge = text.match(/자습|학원|과제|시험공부|알바|당직|수업/);
    if(selfJudge && burden >= 1){
      return base('CONDITION', {
        axis_score: 0,
        primary_drivers: drivers,
        confidence: 0.5,
        defer: true,
        placard: selfJudge[0] + ' 건은 직접',
        detail: '「' + selfJudge[0] + '」 이야기를 적어주셨는데, 그걸 빠지거나 미루는 게 감당할 만한지는 본인이 가장 잘 아실 부분입니다. 이 항목만 따로 한 번 더 생각해보시고 결정하세요. 점수에는 반영하지 않았습니다.',
        missing_info: [selfJudge[0] + ' 감당 가능성']
      });
    }

    const net = clamp(relief - burden, -2, 2);
    let placard, detail;
    if(net >= 2){
      placard = '오늘은 넉넉해요';
      detail = '적어주신 내용은 대체로 여유 쪽입니다. 이동도 일정도 무리가 없어 보이고, 컨디션 축에서는 오늘 회차를 감당하는 데 걸림돌이 보이지 않습니다. 이 축도 플러스를 낼 수 있습니다.';
    } else if(net === 1){
      placard = '다녀올 만해요';
      detail = '부담이 아주 없지는 않지만 완화 요소가 더 큽니다. 컨디션 축에서 오늘 회차는 무리 없이 소화할 수 있는 범위로 봅니다. 다만 적어주신 것 외의 일정은 알 수 없습니다.';
    } else if(net === 0){
      placard = '부담은 보통이에요';
      detail = '부담과 여유가 엇비슷합니다. 컨디션 축에서 오늘은 특별히 밀어줄 것도, 붙잡을 것도 없습니다. 적어주신 범위 밖의 일정은 판단하지 않았습니다.';
    } else if(net === -1){
      placard = '조금 빠듯해요';
      detail = '이동이나 일정에서 부담이 잡힙니다. 못 갈 정도는 아니지만 다녀오고 나면 여파가 남을 만한 조건입니다. 컨디션 축은 이 정도를 감안해 두시라는 신호를 냅니다.';
    } else {
      placard = '일정이 많이 겹쳐요';
      detail = '부담 요소가 여러 갈래로 겹쳐 있습니다. 컨디션은 누적으로 작동하는 축이라 개별로는 넘길 만해도 합치면 무겁습니다. 오늘 회차를 소화하는 데 무리가 있다고 봅니다.';
    }

    return base('CONDITION', {
      axis_score: net,
      primary_drivers: drivers,
      confidence: 0.55,
      placard: placard,
      detail: detail,
      missing_info: []
    });
  }

  /* =========================================================
     6. 팀장 — 하이브리드 (PRD §6.3)
     가드레일 STEP 1~8은 코드, 그 위의 종합·결론은 (원래 LLM 자리)
     ========================================================= */
  function aggregate(out, b){
    const guard = { veto:false, deferNote:null, dupDrivers:[], disqualified:[], alternative_candidate:null };
    const cond = out.CONDITION;

    // STEP 1. 거부권
    if(cond.veto) guard.veto = true;

    // STEP 2. defer — 해당 부담 요소를 점수에 반영하지 않는다
    if(cond.defer) guard.deferNote = cond.detail;

    // STEP 3. 드라이버 중복 감지 — 두 번째 축 이후의 기여를 할인
    const seen = new Set();
    const dupMul = {};
    AGENT_ORDER.forEach(a => {
      const o = out[a];
      dupMul[a] = 1;
      if(!o || o.is_muted) return;
      let dup = false;
      o.primary_drivers.forEach(d => {
        if(seen.has(d)){ dup = true; if(guard.dupDrivers.indexOf(d) < 0) guard.dupDrivers.push(d); }
        seen.add(d);
      });
      if(dup) dupMul[a] = 0.6;      // 같은 원인을 두 번 세지 않는다
    });

    // STEP 4. 결격 감지
    AGENT_ORDER.forEach(a => {
      const o = out[a];
      if(o && !o.is_muted && o.axis_score === -2) guard.disqualified.push(a);
    });

    // STEP 5. 손실 기반 가중치 조정
    const opts = b.disposal_options || [];
    let costMul = 1;
    if(opts.includes('TRANSFERABLE')){
      costMul = 0.5;                                        // 손실 0 → 비용 축은 스스로 물러난다
    } else if(opts.length === 1 && opts[0] === 'NO_TRANSFER'){
      costMul = (out.COST.loss >= 100000) ? 1.3 : 1;        // 손실 절대액이 작으면 올리지 않는다
    }

    // STEP 6. 나눔 검토 플래그
    const hasReturnBenefit = (b.events||[]).some(e => e.type === 'POINT' || /적립|재관람|할인권|쿠폰/.test(e.label||''));
    if(opts.includes('SHARING') && hasReturnBenefit) guard.alternative_candidate = 'SHARING';

    // STEP 7~8. 축 가중치 적용 후 정규화
    let total = 0, maxTotal = 0;
    const contrib = {};
    AGENT_ORDER.forEach(a => {
      const o = out[a];
      if(!o || o.is_muted) return;
      if(a === 'CONDITION' && o.defer) return;              // STEP 2
      const w = WEIGHTS[a] * dupMul[a] * (a === 'COST' ? costMul : 1);
      contrib[a] = o.axis_score * w;
      total += contrib[a];
      maxTotal += 2 * w;
    });
    const normalized = maxTotal ? total / maxTotal : 0;

    /* ---- 판단 층 (실제 서비스에서는 LLM이 맡는 부분) ---- */
    const irreplaceable = AGENT_ORDER.some(a => out[a] && !out[a].is_muted && out[a].irreplaceable);

    let verdict;
    if(guard.veto)                             verdict = 'NO_GO';
    else if(guard.disqualified.length >= 2)    verdict = 'NO_GO';
    else if(irreplaceable && !guard.disqualified.length && normalized > -0.15) verdict = 'GO';
    else                                       verdict = normalized > 0.08 ? 'GO' : 'NO_GO';

    // 나눔 우선 검토 — 적립·재관람 혜택이 걸린 회차에서 가지마라가 나오면 반드시 (CASE 6)
    let alternative = null;
    if(verdict === 'NO_GO'){
      if(guard.alternative_candidate === 'SHARING') alternative = 'SHARING';
      else if(out.COST.cancellation && out.COST.cancellation.cancellable) alternative = 'CANCEL';
    }

    // ---- 결론문
    const ranked = Object.keys(contrib)
      .sort((x,y) => Math.abs(contrib[y]) - Math.abs(contrib[x]))
      .slice(0,2);
    const say = a => subj(AGENT_LABEL[a]) + ' ' + (contrib[a] > 0 ? '밀고' : contrib[a] < 0 ? '붙잡고' : '중립이고');

    let reasoning;
    if(guard.veto){
      reasoning = '컨디션 쪽에서 오늘은 감당이 어렵다고 나왔습니다. 이 경우에는 다른 축이 아무리 좋아도 결론이 바뀌지 않습니다. 몸이 먼저입니다.';
    } else {
      reasoning = '오늘은 ' + ranked.map(say).join(' ') + ' 있습니다. ' +
        (verdict === 'GO'
          ? (irreplaceable ? '무엇보다 오늘이 아니면 대체할 수 없는 요소가 있어 관람 쪽으로 기울였습니다.'
                           : '축을 규칙대로 취합하면 오늘 회차는 가는 쪽이 낫습니다.')
          : '축을 취합하면 오늘 회차는 굳이 밀어붙일 이유가 약합니다.');
    }
    if(guard.dupDrivers.length){
      reasoning += ' 다만 ' + guard.dupDrivers.join(', ') + '는 여러 축이 같은 원인에서 낸 점수라 한 번만 셌습니다.';
    }
    if(guard.deferNote){
      reasoning += ' 그리고 컨디션 쪽에 직접 판단하셔야 할 항목이 하나 남아 있습니다.';
    }
    if(alternative === 'SHARING'){
      reasoning += ' 대신 나눔을 먼저 검토하세요. 그냥 안 가면 돈도 혜택도 잃지만, 나눔하면 재관람 혜택은 챙기고 자리만 넘기게 됩니다.';
    } else if(alternative === 'CANCEL'){
      reasoning += ' 지금이라면 취소 수수료가 ' + won(out.COST.cancellation.fee) + '이니 취소도 선택지입니다.';
    }

    const confs = AGENT_ORDER.map(a => out[a]).filter(o => o && !o.is_muted).map(o => o.confidence);
    const confidence = confs.length ? confs.reduce((s,c)=>s+c,0) / confs.length : 0;
    if(confidence < 0.5) reasoning += ' 참고로 좌석·정가 데이터가 없어 이번 판단은 정보가 부족한 편입니다.';

    return {
      verdict: verdict,
      verdict_label: verdict === 'GO' ? '가라' : '가지마라',
      alternative: alternative,
      reasoning: reasoning,
      normalized: normalized,
      contrib: contrib,
      guard: guard,
      confidence: confidence
    };
  }

  /* =========================================================
     계약 검증 — PRD §7.3 (개발 중 어긋나면 콘솔에 남긴다)
     ========================================================= */
  function validate(o){
    if(o.is_muted){
      if(o.detail) console.warn('[GON] 회색 푯말은 detail을 생략해야 합니다:', o.agent);
      return o;
    }
    const len = Array.from(o.placard).length;
    if(len > 16) console.warn('[GON] 푯말 16자 초과 (' + len + '자):', o.agent, o.placard);
    const dl = Array.from(o.detail).length;
    if(dl < 100 || dl > 180) console.warn('[GON] detail 100~180자 범위 밖 (' + dl + '자):', o.agent);
    if(/가지\s?마|가세요|가지\s?않|추천(하지|합니다)/.test(o.placard)) console.warn('[GON] 푯말이 자기 축의 언어가 아닙니다:', o.agent, o.placard);
    return o;
  }

  /* =========================================================
     runConsult — 화면이 보는 유일한 진입점

     ▶ 실제 API로 교체할 때: 아래 delay(...) 자리를 fetch로 바꾸면 된다.
       반환 모양(에이전트별 Promise + lead Promise)만 지키면 화면은 그대로다.
     ========================================================= */
  const rand = (lo,hi) => lo + Math.random() * (hi - lo);
  const delay = (ms, v) => new Promise(res => setTimeout(() => res(v), ms));

  function runConsult(bundle){
    const b = bundle;

    // 기타란은 여기서 한 번만 읽고 모든 축이 같은 해석을 나눠 쓴다
    const ft = parseFreeText(b.free_text);

    const deoksim = validate(agentDeoksim(b, ft));
    const siya    = validate(agentSiya(b, ft));
    const event   = validate(agentEvent(b, ft));
    const cond    = validate(agentCondition(b, ft));

    // 회색 푯말은 애초에 호출되지 않은 것이므로 즉시 확정된다 (design.md §6.1)
    const pDeoksim = delay(rand(1500, 2600), deoksim);
    const pSiya    = delay(rand(1800, 3000), siya);
    const pEvent   = event.is_muted ? Promise.resolve(event) : delay(rand(1400, 2400), event);
    const pCond    = cond.is_muted  ? Promise.resolve(cond)  : delay(rand(2000, 3200), cond);

    // 비용은 시야 출력을 받아야 시작한다 — 유일한 에이전트 간 의존 (PRD §6.2)
    const pCost = pSiya.then(s => delay(rand(1500, 2600), validate(agentCost(b, s, ft))));

    // 팀장 지연을 늘려 타임아웃 안내를 확인하려면 ?slowlead=1
    const slow = /[?&]slowlead=1/.test(location.search) ? 24000 : 0;
    const pLead = Promise.all([pDeoksim, pSiya, pCost, pEvent, pCond]).then(([d,s,c,e,n]) =>
      delay(rand(1800, 3000) + slow, aggregate({ DEOKSIM:d, SIYA:s, COST:c, EVENT:e, CONDITION:n }, b))
    );

    return {
      agents: { DEOKSIM:pDeoksim, SIYA:pSiya, COST:pCost, EVENT:pEvent, CONDITION:pCond },
      lead: pLead
    };
  }

  /* =========================================================
     DEMO_BUNDLE — test_cases.md CASE 1 (웨스턴 스토리)
     상담실을 단독으로 열었을 때의 폴백
     ========================================================= */
  const DEMO_BUNDLE = {
    schema_version: 1,
    demo: true,
    // season/seat/payment 의 DB 파생 필드는 data.js 가 채운 결과와 같은 값이다
    season: { id:'western-2026', work_title:'웨스턴 스토리', season_label:'2026',
              venue_id:'nol-uniplex-1', venue_name:'NOL 유니플렉스 1관',
              running_time:null, has_intermission:null, close_date:'2026-09-27',
              cancellation_policy:null },
    session: { date:'2026-07-15', datetime:'2026-07-15T19:30:00', matinee_or_evening:'EVENING',
               is_opening:null, is_closing:null, now:'2026-07-13T11:00:00' },
    seat: { floor:1, block:'중앙', row:'6', number:7,
            grade:null,                 // 좌석→등급 매핑 미수집
            is_aisle:true,              // 좌석배치도에서 확인됨 (CASE 1)
            is_restricted:null, zone:null, row_index:6, row_index_in_floor:6,
            notes:[], sources:['test_cases.md CASE 1'],
            unknown:['좌석 등급 (좌석배치도 미수집)', '시야제한석 명단 (미수집)'] },
    payment: { acquisition:'DIRECT', total_paid:52800, surcharge:0,
               list_price:88000, list_price_grade:'R', list_price_verified:false,
               discount_rate:0.4, cancellation_fee:null },
    coverage: { has_season:true, has_venue:true, has_price:true, price_verified:false,
                has_grade:false, has_aisle:true, seat_map_collected:false },
    disposal_options: ['NO_TRANSFER'],
    casting: { today_cast:null, has_favorite_actor:true, favorite_actors_today:null, remaining_favorite_sessions:null },
    first_watch: true,
    work_affinity: null,        // 자첫이라 작품 선호도를 물을 수 없다
    seat_preference: { first:'FRONT', second:'AISLE', actor_path_side:null },
    opera_glass: false,
    events: [{ type:'GIFT', label:'증정', item:'쿠폰팩', distribution:'ALL', point_multiplier:null,
               participating_actors:null, photo_allowed:false, is_actor_mediated:false,
               certainty_class:'FIXED', user_appeal:1, user_scarcity:'NONE' }],
    history: { this_work_count:null, this_pair_count:null, recent_30d_count:null },
    free_text: null
  };

  return {
    runConsult: runConsult,
    DEMO_BUNDLE: DEMO_BUNDLE,
    AGENT_ORDER: AGENT_ORDER,
    AGENT_LABEL: AGENT_LABEL,
    WEIGHTS: WEIGHTS
  };
})();
