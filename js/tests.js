'use strict';
/* FND Studio 자동 테스트. 주소 끝에 ?test를 붙여 열면(index.html?test, 또는 tests.html) 실행되어 결과가 화면 위쪽에 나온다.
   테스트는 사용자의 만든 FND·채점 설정을 건드리지 않도록 끝날 때마다 원래대로 되돌린다. */

const TESTS = [];
const test = (name, fn) => TESTS.push({name, fn});
const fail = msg => { throw new Error(msg); };
const eq = (got, want, what = '') => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) fail(`${what ? what + ': ' : ''}기대 ${b} / 실제 ${a}`);
};
const ok = (cond, what = '조건이 거짓') => { if (!cond) fail(what); };
const throws = (fn, what = '오류가 나야 함') => { try { fn(); } catch { return; } fail(what); };

/* ─ 테스트 파일 만들기 ─ */
const enc = text => new TextEncoder().encode(text).buffer;
// signals: 'A B C …',  rows: [[시간, '비트열'], …]
function mkOut(signals, rows, {vector = '', maxTime = 1000} = {}){
  return `[MySim Result V3.5]\nMAX_TIME ${maxTime};\n${vector ? `VECTOR ${vector};\n` : ''}WATCH ${signals};\nTABLE_ORDER ${signals};\nSTART\n` +
    rows.map(([t, b]) => `${t} ${b}`).join('\n') + '\nEND\n';
}
const BCD_SIGNALS = 'A B C D E F G W X Y Z';
const nib = v => v.toString(2).padStart(4, '0');
// BCD 0~9를 표준 모양(첫 변형)으로 낸 결과. tweak(v, segs) → 바꾼 세그먼트 문자열
function bcdRows(tweak = (v, s) => s){
  return range(10).map(v => [(v + 1) * 10, tweak(v, PAT[v][0]) + nib(v)]);
}
const bcdFile = (opts, tweak) => enc(mkOut(BCD_SIGNALS, bcdRows(tweak), opts));
const bcdSpec = () => range(16).map(v => v > 9 ? ALL_X : PAT[v][0]);

// 만든 FND·채점 설정을 바꿔 쓰고 끝나면 되돌린다
function withState(fn){
  const keep = {seg:DS.seg.slice(), policy:GR.policy, allow:GR.allowBlank, low:POL.low};
  try { return fn(); }
  finally { DS.seg = keep.seg; GR.policy = keep.policy; GR.allowBlank = keep.allow; POL.low = keep.low; }
}

/* ════════════════ CSV ════════════════ */
test('CSV: 수식 문자로 시작하는 문자열 앞에 \'를 붙인다', () => {
  eq(csvCell('=cmd|calc'), "'=cmd|calc"); eq(csvCell('+1'), "'+1"); eq(csvCell('-x.out'), "'-x.out"); eq(csvCell('@SUM(A1)'), "'@SUM(A1)");
  eq(csvCell('\tx'), "'\tx");
});
test('CSV: 평범한 값은 그대로, 쉼표·따옴표는 감싼다', () => {
  eq(csvCell('a.out'), 'a.out'); eq(csvCell(5), '5'); eq(csvCell(-1), '-1');
  eq(csvCell('a,b'), '"a,b"'); eq(csvCell('say "hi"'), '"say ""hi"""'); eq(csvCell('줄\n바꿈'), '"줄\n바꿈"');
});

/* ════════════════ 파서 ════════════════ */
test('파서: VECTOR · TABLE_ORDER · 시간', () => {
  const D = parse(mkOut('A B W X', [[0, '0000'], [10, '1011']], {vector:'IN W X'}));
  eq(D.signals, ['A', 'B', 'W', 'X']); eq(D.maxTime, 1000);
  eq(D.vectors.length, 1); eq(D.vectors[0].idx, [2, 3]);
  eq(D.rows.map(r => r.t), [0, 10]); eq(D.rows[1].vs, [3]);
});
test('파서: START가 없으면 오류', () => throws(() => parse('hello\nworld')));
test('파서: 값 개수가 모자라면 경고하고 X로 채운다', () => {
  const D = parse(mkOut('A B C', [[0, '01']]));
  eq(D.rows[0].bits, '01X'); ok(D.warns.length === 1, '경고 1개');
});
test('파서: 0·1 말고는 X', () => eq(parse(mkOut('A B C', [[0, '0z1']])).rows[0].bits, '0X1'));
test('파서: A~G가 모두 있어야 7-세그먼트로 본다', () => {
  ok(parse(mkOut(BCD_SIGNALS, bcdRows())).seg, 'A~G 있음');
  eq(parse(mkOut('A B C D E F W X Y Z', [[0, '0000000000']])).seg, null);
});
test('파서: UTF-8이 아니면 CP949로 읽는다', () => {
  const bytes = new Uint8Array([0xc7, 0xd1, 0xb1, 0xdb]);              // "한글" (CP949)
  eq(decodeBuf(bytes.buffer), '한글');
});

/* ════════════════ 입력 추정 ════════════════ */
test('입력 추정: 0,1,2…로 세는 신호를 찾는다', () => {
  // 출력 3개 뒤에 입력 P Q R S (P가 MSB)
  const rows = range(16).map(v => [v * 10, `${v % 3 ? 1 : 0}${v % 5 ? 1 : 0}${v >= 10 ? 1 : 0}${nib(v)}`]);
  const D = parse(mkOut('F1 F2 F3 P Q R S', rows));
  eq(inputsFor(D).map(i => D.signals[i]), ['P', 'Q', 'R', 'S']);
});
test('입력 추정: 신호가 너무 적으면 빈 배열', () => eq(inputsFor(parse(mkOut('A', [[0, '0'], [1, '1']]))), []));

/* ════════════════ 파형 끝 표시 ════════════════ */
const fakeD = (maxTime, rows) => ({maxTime, rows:rows.map(([t, bits]) => ({t, bits}))});
test('파형: MAX_TIME의 값이 같은 마지막 행은 끝 표시로 뺀다', () =>
  eq(waveRows(fakeD(5000, [[0, '00'], [10, '01'], [20, '10'], [5000, '10']])).rows.length, 3));
test('파형: MAX_TIME에서 값이 바뀐 마지막 행은 남긴다', () =>
  eq(waveRows(fakeD(40, [[0, '00'], [10, '01'], [20, '10'], [40, '11']])).rows.length, 4));
test('파형: MAX_TIME가 아니면 멀리 떨어져도 남긴다', () =>
  eq(waveRows(fakeD(100000, [[0, '00'], [10, '01'], [20, '10'], [5000, '10']])).rows.length, 4));
test('파형: MAX_TIME를 모르면 아무것도 빼지 않는다', () =>
  eq(waveRows(fakeD(null, [[0, '00'], [10, '01'], [20, '10'], [5000, '10']])).rows.length, 4));

/* ════════════════ 묶기 (Quine–McCluskey) ════════════════ */
const best = (ones, dcs = []) => bestCovers(ones, primeImplicants(ones, dcs));
test('묶기: 반이 1이면 항 하나 (W̄)', () => {
  const s = best(range(8));
  eq(s.length, 1); eq(s[0], [{v:0, dc:7}]);
});
test('묶기: 전부 1이면 항 하나(상수 1), 전부 0이면 빈 식', () => {
  eq(best(range(16))[0], [{v:0, dc:15}]);
  eq(best([]), [[]]);
});
test('묶기: 모서리 4칸은 하나로 이어진다 (X̄Z̄)', () => eq(best([0, 2, 8, 10])[0], [{v:0, dc:10}]));
test('묶기: 4변수 XOR(패리티)는 묶이지 않는다 — 8항', () => {
  const odd = range(16).filter(m => [...nib(m)].filter(c => c === '1').length % 2);
  const s = best(odd);
  eq(s.length, 1); eq(s[0].length, 8);
});
test('묶기: BCD의 A (돈케어 10~15) = 4항 6리터럴', () => {
  const sols = best([0, 2, 3, 5, 6, 7, 8, 9], range(6).map(i => i + 10));
  ok(sols.length >= 1, '해가 있어야 함');
  eq(sols[0].length, 4); eq(sols[0].reduce((s, p) => s + literalCount(p), 0), 6);
});
test('묶기: 무작위 40개 — 모든 해가 올바르고 항 수가 최소', () => {
  let seed = 12345;
  const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  for (let n = 0; n < 40; n++) {
    const kind = range(16).map(() => { const r = rnd(); return r < .4 ? 1 : r < .55 ? 'x' : 0; });
    const ones = range(16).filter(m => kind[m] === 1), dcs = range(16).filter(m => kind[m] === 'x');
    const primes = primeImplicants(ones, dcs), sols = bestCovers(ones, primes);
    ok(sols.length >= 1, `[${n}] 해가 없음`);
    for (const s of sols) {
      for (const m of ones) ok(s.some(p => covers(p, m)), `[${n}] 최소항 ${m}을 못 덮음`);
      for (const m of range(16)) if (kind[m] === 0) ok(!s.some(p => covers(p, m)), `[${n}] 0인 ${m}을 덮음`);
    }
    // 완전 탐색으로 구한 최소 항 수와 같은지
    let min = 0;
    if (ones.length) {
      for (min = 1; min <= primes.length; min++) {
        const pick = (start, left, chosen) => left === 0
          ? ones.every(m => chosen.some(p => covers(p, m)))
          : primes.slice(start).some((p, i) => pick(start + i + 1, left - 1, [...chosen, p]));
        if (pick(0, min, [])) break;
      }
    }
    eq(sols[0].length, min, `[${n}] 항 수`);
  }
});
test('도형: 모서리 묶음은 4조각으로 나뉘어 가장자리가 열린다', () => {
  const pieces = loopPieces({v:0, dc:10});
  eq(pieces.length, 4);
  ok(pieces.some(p => p.r.hi && p.c.hi) && pieces.some(p => p.r.lo && p.c.lo), '반대편 조각이 열려야 함');
});
test('도형: 한 칸짜리 묶음은 1조각', () => eq(loopPieces({v:5, dc:0}).length, 1));

/* ════════════════ 만든 FND와 비교 · 채점 ════════════════ */
test('비교: 돈케어(X)는 어떤 값이어도 통과, 다른 값은 불일치', () => withState(() => {
  DS.seg = Array(16).fill(BLANK); DS.seg[3] = '1X00000';
  const D = parse(mkOut(BCD_SIGNALS, [[0, '1100000' + nib(3)], [10, '0100000' + nib(3)]]));
  eq(compareCustom(D, D.rows[0], 3).st, 'ok');                 // B는 X
  const e = compareCustom(D, D.rows[1], 3);
  eq(e.st, 'bad'); eq(e.diffs, [0]);                           // A가 꺼져 있음
}));
test('채점: 정상 파일은 통과 (BCD, 10~15는 돈케어)', () => withState(() => {
  DS.seg = bcdSpec(); GR.policy = 'stable'; GR.allowBlank = false;
  const r = gradeBuffer('a.out', bcdFile());
  eq([r.status, r.ok, r.bad, r.miss], ['pass', 16, 0, 0]);
  eq(r.basis.kind, 'order'); eq(r.basis.names, 'W X Y Z');
}));
test('채점: 틀린 세그먼트와 위치를 알려 준다', () => withState(() => {
  DS.seg = bcdSpec();
  const r = gradeBuffer('a.out', bcdFile({}, (v, s) => v === 8 ? '1111110' : s));
  eq(r.status, 'fail'); eq(r.fails.length, 1);
  eq([r.fails[0].v, r.fails[0].segs, r.fails[0].t], [8, 'G', 90]);
}));
test('채점: 기준 FND가 비어 있으면 보류, 확인하면 채점', () => withState(() => {
  DS.seg = Array(16).fill(BLANK); GR.allowBlank = false;
  const allOff = enc(mkOut(BCD_SIGNALS, range(16).map(v => [v * 10, '0000000' + nib(v)])));
  eq(gradeBuffer('x.out', allOff).status, 'wait');
  GR.allowBlank = true;
  eq(gradeBuffer('x.out', allOff).status, 'pass');
}));
test('채점: 안정 상태 방식은 과도 상태 행을 봐주고, 엄격 방식은 잡는다', () => withState(() => {
  DS.seg = bcdSpec();
  const rows = [];
  range(10).forEach(v => { if (v === 5) rows.push([rows.length * 10 + 5, '0000000' + nib(v)]); rows.push([rows.length * 10 + 10, PAT[v][0] + nib(v)]); });
  const f = enc(mkOut(BCD_SIGNALS, rows));
  GR.policy = 'stable'; eq(gradeBuffer('g.out', f).status, 'pass');
  GR.policy = 'all';    eq(gradeBuffer('g.out', f).status, 'fail');
}));
test('채점: 한 번도 안 나온 입력은 누락 (전부 돈케어는 제외)', () => withState(() => {
  DS.seg = bcdSpec(); GR.policy = 'stable';
  const f = enc(mkOut(BCD_SIGNALS, bcdRows().filter(([, b]) => parseInt(b.slice(7), 2) !== 4)));
  const r = gradeBuffer('m.out', f);
  eq([r.status, r.miss, r.missing], ['fail', 1, [4]]);
}));
test('채점: VECTOR가 4비트가 아니면 오류', () => withState(() => {
  DS.seg = bcdSpec();
  const f = enc(mkOut('A B C D E F G W X Y Z Q', [[0, '111111000000']], {vector:'IN W X Y Z Q'}));
  const r = gradeBuffer('v.out', f);
  eq(r.status, 'error'); ok(/5비트/.test(r.note), r.note);
}));
test('채점: VECTOR가 있으면 그것을 입력으로 쓴다', () => withState(() => {
  DS.seg = bcdSpec();
  const r = gradeBuffer('v.out', bcdFile({vector:'IN W X Y Z'}));
  eq([r.status, r.basis.kind], ['pass', 'vector']);
}));
test('채점: A–G가 없으면 오류', () => withState(() => {
  DS.seg = bcdSpec();
  eq(gradeBuffer('n.out', enc(mkOut('P Q R S', [[0, '0000']]))).status, 'error');
}));

/* ════════════════ 출력 극성 (Active Low) ════════════════ */
const invertSegs = s => [...s].map(c => c === '1' ? '0' : c === '0' ? '1' : c).join('');
test('극성: Active Low 파일은 High로 읽으면 불일치, Low로 읽으면 통과', () => withState(() => {
  DS.seg = bcdSpec(); GR.policy = 'stable';
  const f = bcdFile({}, (v, s) => invertSegs(s));
  POL.low = false; eq(gradeBuffer('l.out', f).status, 'fail');
  POL.low = true;  eq(gradeBuffer('l.out', f).status, 'pass');
}));
test('극성: X는 반전해도 X', () => withState(() => {
  POL.low = true; eq(['0', '1', 'X'].map(litBit), ['1', '0', 'X']);
  POL.low = false; eq(['0', '1', 'X'].map(litBit), ['0', '1', 'X']);
}));
test('극성: 만든 FND를 .out으로 내보내면 극성을 따르고, 같은 극성으로 읽으면 일치', () => withState(() => {
  DS.seg = bcdSpec();
  for (const low of [false, true]) {
    POL.low = low;
    const D = parse(designOut());
    const bad = range(16).filter(v => compareCustom(D, D.rows[v], v).st !== 'ok');
    eq(bad, [], low ? 'Active Low' : 'Active High');
  }
  POL.low = true; ok(designOut().includes('\n0 0000001'), '0의 A~G가 반전돼 있어야 함');
}));
test('극성: 표준(BCD) 판정도 극성을 따른다', () => withState(() => {
  POL.low = true;
  const D = parse(mkOut(BCD_SIGNALS, [[0, invertSegs(PAT[8][0]) + nib(8)]], {vector:'IN W X Y Z'}));
  eq(segBits(D.rows[0], D).join(''), PAT[8][0]);
}));

/* ════════════════ 설계 실행 취소 / 다시 실행 ════════════════ */
function withHistory(fn){                        // 이력·만든 FND·저장값을 되돌린다
  const keep = {seg:DS.seg.slice(), sel:DS.sel, hist:JSON.parse(JSON.stringify(HIST))};
  try { return fn(); }
  finally { DS.seg = keep.seg; DS.sel = keep.sel; Object.assign(HIST, keep.hist); saveDesign(); renderDesign(); syncUndoButtons(); }
}
test('이력: 취소하면 이전 모양, 다시 실행하면 되돌아온다', () => withHistory(() => {
  replaceDesign(Array(16).fill(BLANK));
  const base = histSnap();
  toggleSeg(3, 0); toggleSeg(3, 0);
  eq(DS.seg[3], 'X000000');
  undo(); eq(DS.seg[3], '1000000');
  undo(); eq(histSnap(), base);
  redo(); eq(DS.seg[3], '1000000');
  redo(); eq(DS.seg[3], 'X000000');
}));
test('이력: 새 변경이 생기면 다시 실행 이력은 사라진다', () => withHistory(() => {
  replaceDesign(Array(16).fill(BLANK));
  toggleSeg(0, 0); undo();
  ok(HIST.future.length === 1, '다시 실행 가능');
  toggleSeg(1, 1);
  eq(HIST.future.length, 0);
  redo(); eq(DS.seg[1], '0100000');                // 아무 일도 일어나지 않음
}));
test('이력: 같은 모양으로 바꾸면 단계가 생기지 않는다', () => withHistory(() => {
  replaceDesign(Array(16).fill(BLANK));
  const n = HIST.past.length;
  replaceDesign(Array(16).fill(BLANK));
  eq(HIST.past.length, n);
}));
test('이력: 채우기·전체 지우기도 한 단계로 취소된다', () => withHistory(() => {
  replaceDesign(bcdSpec());
  replaceDesign(Array(16).fill(BLANK));
  undo(); eq(DS.seg, bcdSpec());
}));
test('이력: 최대 200단계', () => withHistory(() => {
  replaceDesign(Array(16).fill(BLANK));
  for (let i = 0; i < 250; i++) toggleSeg(i % 16, i % 7);
  ok(HIST.past.length <= HIST.max, `${HIST.past.length}단계`);
}));
test('이력: 취소 후에도 저장값(localStorage)과 모양이 같다', () => withHistory(() => {
  replaceDesign(Array(16).fill(BLANK)); toggleSeg(5, 2); undo();
  eq(JSON.parse(store.get('design')), DS.seg);
}));

test('설계: Tab으로 지나는 곳은 FND 칸 16개뿐 (세그먼트는 거치지 않는다)', () => {
  const stops = [...document.querySelectorAll('#digits button, #digits polygon')].filter(e => e.tabIndex >= 0);
  eq(stops.length, 16); ok(stops.every(e => e.classList.contains('dl')), '이름표 버튼만 Tab 대상');
});

/* ════════════════ 실행 · 표시 ════════════════ */
async function runTests(){
  const results = [];
  for (const t of TESTS) {
    try { await t.fn(); results.push({name:t.name, pass:true}); }
    catch (e) { results.push({name:t.name, pass:false, msg:e.message}); }
  }
  const failed = results.filter(r => !r.pass);
  const box = document.createElement('section');
  box.id = 'testPanel'; box.className = 'testpanel';
  box.innerHTML = `<h2>자동 테스트 — <span class="${failed.length ? 'tf' : 'tp'}">${failed.length ? `실패 ${failed.length}` : '모두 통과'}</span> (${results.length - failed.length}/${results.length})` +
    ` <button id="testClose" class="ghost">닫기</button></h2>` +
    `<ul>${[...failed, ...results.filter(r => r.pass)].map(r =>
      `<li class="${r.pass ? 'tp' : 'tf'}">${r.pass ? '✓' : '✗'} ${esc(r.name)}${r.pass ? '' : `<pre>${esc(r.msg)}</pre>`}</li>`).join('')}</ul>`;
  document.body.prepend(box);
  box.querySelector('#testClose').onclick = () => box.remove();
  console[failed.length ? 'error' : 'log'](`테스트 ${results.length - failed.length}/${results.length} 통과`, failed);
  window.TEST_RESULT = {total:results.length, failed:failed.map(r => ({name:r.name, msg:r.msg}))};
  return window.TEST_RESULT;
}
runTests();
