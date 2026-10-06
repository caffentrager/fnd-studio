'use strict';
/* FND Studio · 검증 탭: MySim 결과 파일(.out)을 열어 출력 검증 · 전체 출력 · 진리표 · 타이밍 파형으로 보여준다.
   .out 형식:  VECTOR / WATCH / TABLE_ORDER 머리말(';'로 끝남) → START → "시간 비트열" 행들 → END
   검증 기준:  BCD 0–9 · Hex 0–F · 만든 FND(설계 탭의 모양, 편집하면 바로 반영) · 끄기      공통 코드: common.js */

/* ════════════════════════════════════════════════════════════════
   0. 설정
   ════════════════════════════════════════════════════════════════ */
const CFG = {
  tableRows:      3000,   // 진리표에 그리는 최대 행
  galleryTiles:   96,     // 전체 출력에 그리는 최대 칸
  maxInputs:      8,      // 입력 신호 추정 대상의 최대 개수
  maxSignals:     24,     // 이보다 신호가 많으면 입력 추정을 건너뜀
  detectBudgetMs: 600,    // 입력 추정에 쓸 최대 시간
  watchMs:        1500,   // 파일 변경 확인 주기
  tickMinPx:      70,     // 파형 시간 눈금 최소 간격
  maxCanvasPx:    15000,  // 파형 캔버스 최대 폭
  markerGapRatio: 20,     // 이 배수보다 멀리 떨어진 마지막 행은 "MAX_TIME 마커"로 본다
};

const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const withAlpha = (hex, aa) => hex + aa;                    // '#rrggbb' + 2자리 16진 알파
const stampOf = f => f.lastModified + ':' + f.size;         // 파일이 바뀌었는지 비교용
let viewerEnabled = () => true;                             // 키보드·드롭에 반응할지 (studio.js가 검증 탭일 때만 true가 되게 바꾼다)

/* ════════════════════════════════════════════════════════════════
   1. 파서  (.out → D)
      D   = { maxTime, signals[], vectors[], rows[], seg, vec, warns[] }
      row = { i, t, bits, vs[], v }     bits: 신호별 '0'|'1'|'X' 문자열,
                                        vs: 벡터별 값(X 있으면 null), v: 판정용 입력값
   ════════════════════════════════════════════════════════════════ */
function decodeBuf(buf){
  try { return new TextDecoder('utf-8', {fatal:true}).decode(buf); }
  catch { return new TextDecoder('euc-kr').decode(buf); }      // MyLogic은 CP949로 저장
}

function parse(text){
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(l => l.trim().toUpperCase() === 'START');
  if (start < 0) throw new Error('START 줄을 찾을 수 없습니다. MySim 결과(.out) 파일이 맞는지 확인해 주세요.');

  const D = {maxTime:null, watch:[], order:[], vectors:[], rows:[], warns:[]};

  // 머리말: ';'로 끝나는 문장들 (WATCH 등은 여러 줄에 걸칠 수 있다)
  const hasTitle = /^\[.*\]/.test(lines[0] || '');
  const head = lines.slice(hasTitle ? 1 : 0, start).join(' ');
  for (const stmt of head.split(';').map(s => s.trim()).filter(Boolean)) {
    const [kw, ...rest] = stmt.split(/\s+/);
    switch (kw.toUpperCase()) {
      case 'MAX_TIME':    D.maxTime = Number.isFinite(Number(rest[0])) ? Number(rest[0]) : null; break;
      case 'WATCH':       D.watch = rest; break;
      case 'TABLE_ORDER': D.order = rest; break;
      case 'VECTOR':      D.vectors.push({name:rest[0], members:rest.slice(1)}); break;
    }
  }
  // 데이터 열 순서는 TABLE_ORDER. (WATCH 끝에는 VECTOR 이름이 섞여 있으므로 fallback 때 제외)
  const vecNames = new Set(D.vectors.map(v => v.name));
  D.signals = D.order.length ? D.order : D.watch.filter(n => !vecNames.has(n));

  for (const raw of lines.slice(start + 1)) {
    const l = raw.trim();
    if (!l) continue;
    if (l.toUpperCase() === 'END') break;
    const m = /^(\d+)\s*(.*)$/.exec(l);
    if (!m) continue;
    let bits = m[2].replace(/\s+/g, '').toUpperCase();
    if (bits.length !== D.signals.length) {
      if (D.warns.length < 3) D.warns.push(`시간 ${m[1]}: 값 개수(${bits.length})가 신호 개수(${D.signals.length})와 다릅니다.`);
      bits = bits.padEnd(D.signals.length, 'X').slice(0, D.signals.length);
    }
    D.rows.push({i:D.rows.length, t:Number(m[1]), bits:bits.replace(/[^01]/g, 'X')});
  }
  if (!D.rows.length) throw new Error('데이터 행이 없습니다.');

  // 벡터: 화면에는 파일에 적힌 이름 대신 "입력값"으로 표시한다
  for (const v of D.vectors) {
    v.idx = v.members.map(n => D.signals.indexOf(n));
    if (v.idx.includes(-1)) { D.warns.push('VECTOR 정의: 일부 신호를 찾지 못했습니다.'); v.idx = v.idx.filter(i => i >= 0); }
  }
  D.vectors = D.vectors.filter(v => v.idx.length);
  D.vectors.forEach((v, k) => { v.label = D.vectors.length > 1 ? `입력값${k + 1}` : '입력값'; });
  for (const r of D.rows) r.vs = D.vectors.map(v => {
    const s = v.idx.map(i => r.bits[i]).join('');
    return s.includes('X') ? null : parseInt(s, 2);
  });

  // 7-세그먼트: A~G 신호가 모두 있을 때. 판정에 쓸 입력 벡터는 A~G를 포함하지 않는 첫 벡터
  const up = D.signals.map(s => s.toUpperCase());
  const seg = [...'ABCDEFG'].map(c => up.indexOf(c));
  D.seg = seg.every(i => i >= 0) ? seg : null;
  const vk = D.vectors.findIndex(v => !D.seg || !v.idx.some(i => seg.includes(i)));
  D.vec = vk >= 0 ? D.vectors[vk] : null;
  for (const r of D.rows) r.v = D.vec ? r.vs[vk] : null;
  return D;
}

/* ════════════════════════════════════════════════════════════════
   2. 상태
   ════════════════════════════════════════════════════════════════ */
const S = {
  trimEnd:true,           // 끝의 연속 X 행을 접기에서 제외할지 (직접 만든 FND는 false)
  D:null,
  cur:0,                  // 선택된 행 (D.rows 인덱스)
  steps:[],               // 단계로 다루는 행 인덱스들 (접기를 켜면 중복 제거)
  canFold:false, fold:true,
  mode:'bcd',             // 7-세그먼트 판정 기준
  evals:[],               // 행별 판정 결과
  auto:null,              // 자동 재생 타이머
  galleryAll:false,       // 전체 출력을 칸 수 제한 없이 그릴지
  inputs:[], cols:[],     // 추정한 입력 신호 / 진리표 열 순서(입력 → 출력)
  handle:null, stamp:'', watch:null,          // 파일 핸들(File System Access API)과 변경 감지
  wave:{lanes:[], rows:[], t0:0, tEnd:1, ppu:null},   // 파형: ppu = 시간 1당 픽셀 수
};

/* ════════════════════════════════════════════════════════════════
   3. 7-세그먼트: 판정 · SVG
   ════════════════════════════════════════════════════════════════ */
const segBits = (r, D = S.D) => D.seg && D.seg.map(i => r.bits[i]);

// 행의 입력값(0~15). VECTOR가 있으면 그 값이고, 없으면 추정한 입력 신호 4개(MSB→LSB)로 계산한다
function inputValueOf(r, inputs){
  if (r.v != null) return r.v;
  if (inputs.length !== 4) return null;
  const key = inputs.map(i => r.bits[i]).join('');
  return key.includes('X') ? null : parseInt(key, 2);
}
// 화면(검증 탭)에서 쓰는 입력값: "만든 FND" 기준일 때만 VECTOR 없는 파일도 추정 입력으로 계산한다
const inputValue = r => S.mode === 'custom' ? inputValueOf(r, S.inputs) : r.v;

// 만든 FND와 비교: 돈케어(X)로 둔 세그먼트는 어떤 값이 나와도 통과.  D는 비교할 결과 파일(화면 상태와 무관)
function compareCustom(D, r, v){
  if (v > 15) return {st:'na', why:'검증 범위 밖'};
  const want = DS.seg[v], got = segBits(r, D).join('');
  const diffs = [...want].flatMap((w, i) => w === 'X' || w === got[i] ? [] : [i]);
  const base = {custom:true, v, dc:[...want].filter(w => w === 'X').length};
  return diffs.length
    ? {...base, st:'bad', got, want, diffs, hasX:diffs.some(i => got[i] === 'X')}
    : {...base, st:'ok'};
}
const evalCustom = (r, v) => compareCustom(S.D, r, v);

// 행 하나의 판정: {st:'ok'|'bad'|'na', ...}
function evalRow(r){
  if (!S.D.seg || S.mode === 'off') return {st:'na'};
  const v = inputValue(r);
  if (v == null) return {st:'na'};
  if (S.mode === 'custom') return evalCustom(r, v);
  if (v > (S.mode === 'hex' ? 15 : 9)) return {st:'na', why:'검증 범위 밖'};
  const got = segBits(r).join('');
  if (PAT[v].includes(got)) return {st:'ok'};
  // 가장 가까운 표준 모양과 비교해 어느 세그먼트가 틀렸는지 알려준다 (X는 항상 다른 값으로 센다)
  const dist = p => [...p].filter((c, i) => c !== got[i]).length;
  const want = PAT[v].reduce((a, b) => dist(b) < dist(a) ? b : a);
  const diffs = [...want].flatMap((c, i) => c === got[i] ? [] : [i]);
  return {st:'bad', got, want, diffs, hasX:got.includes('X')};
}
const evalAll = () => { S.evals = S.D.rows.map(evalRow); };


// states: 세그먼트 7개의 '0'|'1'|'X'.  wrong: 틀린 세그먼트 번호들(점선 표시)
function segSvg(states, {labels = false, wrong = []} = {}){
  let h = '<svg viewBox="0 0 60 100" aria-hidden="true">';
  for (let i = 0; i < 7; i++) {
    const on = states[i] === '1', cls = on ? 'on' : states[i] === '0' ? '' : 'x';
    h += `<polygon class="s ${cls}${wrong.includes(i) ? ' d' : ''}" points="${SEG_POLY[i]}"/>`;
    if (labels) h += `<text class="sl${on ? ' on' : ''}" x="${SEG_LABEL_POS[i][0]}" y="${SEG_LABEL_POS[i][1]}">${SEG_NAMES[i]}</text>`;
  }
  return h + '</svg>';
}

// 세그먼트 7칸을 글자로 나열: 켜진 것은 그 글자(A~G), 꺼진 것은 ·, X는 X. wrong에 든 칸은 빨갛게
function segStrip(bits, wrong){
  return [...bits].map((b, i) => {
    const ch = b === '1' ? SEG_NAMES[i] : b === '0' ? '·' : b === 'X' ? 'X' : b;
    return `<span class="sg${wrong.includes(i) ? ' w' : ''}">${ch}</span>`;
  }).join('');
}

// 판정 결과를 안내 문구로 바꾼다 → {cls, html}
function verdictView(r, e){
  // 무엇과 비교했는지: 표준 7-세그먼트의 글자 / 직접 만든 FND의 해당 칸
  const target = e.custom ? `만든 FND의 "${hexDigit(e.v)}" 칸` : `표준 7-세그먼트 "${DIGIT[r.v]}"`;
  if (e.st === 'ok') return {cls:'ok', html:`✓ 일치 — ${target}${e.dc ? ` <span class="dim">(돈케어 ${e.dc}개는 제외)</span>` : ''}`};
  if (e.st === 'bad') {
    const fixes = e.diffs.map(i => `<span class="nw">${SEG_NAMES[i]}는 ` +
      (e.got[i] === 'X' ? 'X(미정)' : e.want[i] === '1' ? '켜져야 함' : '꺼져야 함') + '</span>').join(', ');
    return {cls:'bad', html:
      `<div><div>✗ ${e.hasX ? 'X(미정) 값 포함' : '불일치'} — ${target.replace(/^표준 7-세그먼트 /, '')}</div>` +
      `<div class="cmp head"><span class="k"></span>${segStrip(SEG_NAMES, [])}</div>` +
      `<div class="cmp"><span class="k">기대</span>${segStrip(e.want, e.diffs)}</div>` +
      `<div class="cmp"><span class="k">실제</span>${segStrip(e.got, e.diffs)}</div>` +
      `<div class="fix">${fixes} <span class="dim">(점선 표시)</span></div></div>`};
  }
  const text = !S.D.seg ? '이 파일에는 A–G 세그먼트 신호가 없어 자동 판정을 하지 않습니다.'
    : S.mode === 'off' ? '자동 판정 꺼짐'
    : e.why || '입력값을 알 수 없어 판정하지 않습니다.';
  return {cls:'', html:esc(text)};
}

/* ════════════════════════════════════════════════════════════════
   4. 단계(steps): 반복 행 접기, 이동
   ════════════════════════════════════════════════════════════════ */
function computeSteps(){
  const rows = S.D.rows;
  // 끝에 연속된 X 행은 "시뮬레이션 끝" 표시이므로 접기 대상에서 제외 (직접 만든 FND처럼 X가 실제 값인 경우는 제외하지 않는다)
  let end = rows.length;
  if (S.trimEnd && rows.some(r => !r.bits.includes('X'))) while (end > 1 && rows[end - 1].bits.includes('X')) end--;
  const seen = new Set(), uniq = [];
  for (const r of rows.slice(0, end)) if (!seen.has(r.bits)) { seen.add(r.bits); uniq.push(r.i); }
  S.canFold = uniq.length < rows.length;
  $('#foldWrap').hidden = !S.canFold;
  S.steps = S.fold && S.canFold ? uniq : range(rows.length);
}

// 선택 행이 steps 안에서 몇 번째인지 (steps에 없으면 그 앞의 가장 가까운 단계)
function stepPos(){
  let k = 0;
  while (k + 1 < S.steps.length && S.steps[k + 1] <= S.cur) k++;
  return k;
}

function selectRow(i){
  S.cur = Math.max(0, Math.min(S.D.rows.length - 1, i));
  refreshSelection();
}
const goFirst = () => selectRow(S.steps[0]);
const goLast  = () => selectRow(S.steps[S.steps.length - 1]);
const goNext  = () => selectRow(S.steps[(stepPos() + 1) % S.steps.length]);
function goPrev(){
  const k = stepPos();
  selectRow(S.steps[S.steps[k] < S.cur ? k : Math.max(0, k - 1)]);
}
function setAuto(on){
  clearInterval(S.auto);
  S.auto = on ? setInterval(goNext, Number($('#speed').value)) : null;
  $('#auto').checked = on;
}

/* ════════════════════════════════════════════════════════════════
   5. 입력 신호 추정 (진리표에서 입력 열을 앞으로 모으는 데 사용)
   ════════════════════════════════════════════════════════════════ */
/* .out에는 입·출력 구분이 없으므로
   "행을 유일하게 결정하면서 시간순으로 0,1,2…로 세는" 신호 조합을 찾는다. */
function detectInputs(D){
  const N = D.signals.length;
  if (N < 2 || N > CFG.maxSignals) return null;

  const clean = D.rows.filter(r => !r.bits.includes('X'));
  const uniq = [...new Set(clean.map(r => r.bits))];
  if (uniq.length < 2) return null;

  const flips = new Array(N).fill(0);            // 신호별 값이 바뀐 횟수 (많이 바뀔수록 LSB)
  for (let i = 1; i < clean.length; i++) for (let j = 0; j < N; j++) if (clean[i - 1].bits[j] !== clean[i].bits[j]) flips[j]++;
  const isCounting = idx => {
    const lsbFirst = idx.slice().sort((a, b) => flips[b] - flips[a] || b - a);
    return uniq.every((bits, p) => lsbFirst.reduce((v, s, k) => v | (bits[s] === '1') << k, 0) === p);
  };
  const isKey = idx => new Set(uniq.map(b => idx.map(i => b[i]).join(''))).size === uniq.length;

  const t0 = performance.now();
  for (let n = Math.max(1, Math.ceil(Math.log2(uniq.length))); n <= Math.min(CFG.maxInputs, N - 1); n++) {
    let fallback = null;                          // 세기 패턴은 아니지만 행을 결정하는 첫 조합
    const idx = range(n);
    for (;;) {
      if (performance.now() - t0 > CFG.detectBudgetMs) return fallback;
      if (isKey(idx)) {
        if (isCounting(idx)) return idx.slice();
        fallback ??= idx.slice();
      }
      let p = n - 1;                              // 다음 조합
      while (p >= 0 && idx[p] === N - n + p) p--;
      if (p < 0) break;
      idx[p]++;
      for (let q = p + 1; q < n; q++) idx[q] = idx[q - 1] + 1;
    }
    if (fallback) return fallback;
  }
  return null;
}

// 표시 순서(MSB→LSB): VECTOR와 같은 집합이면 그 순서, 아니면 파일의 열 순서
function displayOrder(D, idxs){
  const same = D.vectors.find(v => v.idx.length === idxs.length && v.idx.every(i => idxs.includes(i)));
  return same ? same.idx.slice() : idxs.slice().sort((a, b) => a - b);
}
// 입력 신호(MSB→LSB). 찾지 못하면 빈 배열. 화면 상태와 무관해 채점에서도 쓴다
function inputsFor(D){
  const found = detectInputs(D);
  return found ? displayOrder(D, found) : [];
}

// 진리표 열 순서: 입력 신호(MSB→LSB) 다음에 나머지(출력)
function autoInputs(){
  S.inputs = inputsFor(S.D);
  S.cols = [...S.inputs, ...range(S.D.signals.length).filter(i => !S.inputs.includes(i))];
}

/* ════════════════════════════════════════════════════════════════
   6. 화면: 알림 · 갤러리 · 진리표 · 선택 영역
   ════════════════════════════════════════════════════════════════ */
function renderNotes(){
  const D = S.D, notes = [...D.warns];
  if (!D.signals.length) notes.push('신호가 없는 결과 파일입니다. 시뮬레이션에 WATCH 신호가 지정됐는지 확인해 주세요.');
  else if (D.seg && !D.vec && !(S.mode === 'custom' && S.inputs.length === 4)) notes.push('A–G 출력은 있지만 입력값을 묶은 VECTOR가 없어 자동 판정은 하지 않습니다. 눈으로 확인하거나 회로에 VECTOR를 추가해 주세요.');
  if (D.seg && S.mode === 'custom' && isBlank()) notes.push('검증 기준이 "만든 FND"인데 만든 모양이 비어 있어, 모든 출력이 꺼져 있어야 일치로 봅니다.');
  $('#notes').innerHTML = notes.map(t => `<div class="note">${esc(t)}</div>`).join('');
}

// 전체 출력 칸에 쓰는 이름: 입력값이 있으면 그 글자(0~F), 없으면 시간
const rowLabel = r => {
  const v = inputValue(r);
  if (v == null) return S.D.vec ? 'X' : `t${r.t}`;
  return S.mode === 'custom' ? hexDigit(v) : DIGIT[v] ?? v;       // 만든 FND 기준일 땐 입력값을 그대로(대문자 16진수)
};

// 틀린 세그먼트별로 묶어 요약 버튼으로 보여준다. 누르면 그 오류가 처음 나오는 입력으로 이동
function renderSegSummary(){
  const box = $('#segSummary'), byseg = new Map();
  for (const i of S.steps) for (const k of S.evals[i].diffs ?? []) byseg.set(k, [...byseg.get(k) ?? [], i]);
  box.hidden = !byseg.size;
  box.innerHTML = !byseg.size ? '' : '<span class="lbl">문제 세그먼트</span>' +
    [...byseg].sort((a, b) => a[0] - b[0]).map(([k, rows]) => {
      const shown = rows.slice(0, 6).map(i => rowLabel(S.D.rows[i])).join(', ') + (rows.length > 6 ? ' …' : '');
      return `<button data-i="${rows[0]}" title="처음 나오는 입력으로 이동"><b>${SEG_NAMES[k]}</b> ${rows.length}건 · 입력 ${esc(shown)}</button>`;
    }).join('');
}

function renderGallery(){
  const D = S.D;
  if (!D.seg) return;
  // 칸이 많으면 일부만 그리되, 나머지가 있다는 것과 그중 불일치 수를 알리고 펼칠 수 있게 한다
  const shown = S.galleryAll ? S.steps : S.steps.slice(0, CFG.galleryTiles), hidden = S.steps.length - shown.length;
  const hiddenBad = S.steps.slice(shown.length).filter(i => S.evals[i].st === 'bad').length;
  $('#gallery').innerHTML = shown.map(i => {
    const r = D.rows[i], {st, diffs} = S.evals[i];
    const tip = `시간 ${r.t}` + (diffs ? ` · 불일치: ${diffs.map(k => SEG_NAMES[k]).join(' ')}` : '');
    const wrong = diffs ? `<span class="wg">${diffs.map(k => SEG_NAMES[k]).join(' ')}</span>` : '';
    return `<button class="tile ${st}" data-i="${i}" title="${tip}"><span class="mk">${st === 'ok' ? '✓' : st === 'bad' ? '✗' : ''}</span>${segSvg(segBits(r))}<span class="lb">${esc(rowLabel(r))}</span>${wrong}</button>`;
  }).join('');
  $('#galleryMore').hidden = !hidden;
  $('#galleryMore').innerHTML = hidden
    ? `<span>${S.steps.length}칸 중 ${shown.length}칸만 표시했습니다${hiddenBad ? ` — <b class="bd">나머지에 불일치 ${hiddenBad}개</b>` : ''}</span> <button id="galleryAll">나머지 ${hidden}칸 모두 보기</button>` : '';
  renderSegSummary();

  const count = st => S.steps.filter(i => S.evals[i].st === st).length;
  const ok = count('ok'), bad = count('bad'), pill = $('#summary');
  [pill.textContent, pill.className] =
    ok + bad === 0 ? ['검증 안 함', 'pill'] :
    bad === 0      ? [`${ok}/${ok} 일치`, 'pill ok'] :
                     [`${bad}개 불일치 · ${ok}개 일치`, 'pill bad'];
}

function renderTable(){
  const D = S.D, nIn = S.inputs.length;
  const sep = k => nIn && k === nIn - 1 ? ' sep' : '';         // 입력 | 출력 구분선
  const head = S.cols.map((si, k) => {
    const cls = S.inputs.includes(si) ? 'in' : D.seg && D.seg.includes(si) ? 'seg' : '';
    return `<th class="${cls}${sep(k)}">${esc(D.signals[si])}</th>`;
  }).join('');
  const vecHead = D.vectors.map(v => `<th class="vv">${esc(v.label)}</th>`).join('');

  const body = S.steps.slice(0, CFG.tableRows).map(i => {
    const r = D.rows[i], wrong = S.evals[i].diffs;               // 판정에서 틀린 세그먼트 번호들
    const cells = S.cols.map((si, k) => {
      const ch = r.bits[si], bad = wrong && wrong.includes(D.seg.indexOf(si));
      return `<td class="${ch === '1' ? 'b1' : ch === '0' ? 'b0' : 'bx'}${sep(k)}${bad ? ' wr' : ''}">${ch}</td>`;
    }).join('');
    const vecs = r.vs.map((v, k) => `<td class="vv">${v == null ? 'X' : `${v}<span class="hx">${hexStr(v, D.vectors[k].idx.length)}</span>`}</td>`).join('');
    return `<tr data-i="${i}"><td class="tm">${r.t}</td>${cells}${vecs}</tr>`;
  }).join('');

  $('#tbl').innerHTML = `<thead><tr><th class="tm">시간</th>${head}${vecHead}</tr></thead><tbody>${body}</tbody>`;
  $('#tableWrap .more')?.remove();
  if (S.steps.length > CFG.tableRows) $('#tbl').insertAdjacentHTML('afterend', `<div class="more">처음 ${CFG.tableRows}행만 표시합니다 (전체 ${S.steps.length}행)</div>`);
}

/* ─ 선택 행에 따라 바뀌는 부분 ─ */
function renderVerify(r, e){
  const D = S.D;
  if (D.seg) $('#big').innerHTML = segSvg(segBits(r), {labels:true, wrong:e.diffs});

  $('#vinfo').innerHTML = `시간 <b>${r.t}</b>` + D.vectors.map((v, k) => {
    const bin = v.idx.map(i => r.bits[i]).join(''), val = r.vs[k];
    return ` · ${esc(v.label)} = <b>${bin}</b>${val != null ? ` (${val} · ${hexStr(val, v.idx.length)})` : ''}`;
  }).join('');

  const {cls, html} = verdictView(r, e), vd = $('#verdict');
  vd.className = 'verdict ' + cls; vd.innerHTML = html;

  const k = stepPos(), slider = $('#slider');
  slider.max = Math.max(0, S.steps.length - 1); slider.value = k;
  $('#stepText').textContent = `${k + 1} / ${S.steps.length}`;

  $('#chips').innerHTML = D.signals.map((n, i) => {
    const ch = r.bits[i];
    return `<span class="chip ${ch === '1' ? 'v1' : ch === 'X' ? 'vx' : ''}"><i>${esc(n)}</i>${ch}</span>`;
  }).join('');
}

function markTableRow(follow){
  const tr = $(`#tbl tr[data-i="${S.cur}"]`);
  markOnly('#tbl tr', tr ? [tr] : []);
  if (!tr || !follow) return;
  const wrap = $('#tableWrap'), headH = $('#tbl thead').offsetHeight;
  if (tr.offsetTop - headH < wrap.scrollTop) wrap.scrollTop = tr.offsetTop - headH;
  else if (tr.offsetTop + tr.offsetHeight > wrap.scrollTop + wrap.clientHeight) wrap.scrollTop = tr.offsetTop + tr.offsetHeight - wrap.clientHeight;
}

// 검증 기준이나 기준 데이터(만든 FND)가 바뀌었을 때 다시 판정하고 화면을 갱신
function reverify(){
  evalAll(); renderNotes(); renderGallery(); renderTable(); refreshSelection(false);
}

// 선택이 바뀔 때마다 부르는 단일 진입점. follow: 표·파형을 선택 위치로 스크롤할지
function refreshSelection(follow = true){
  const r = S.D.rows[S.cur];
  renderVerify(r, S.evals[S.cur]);
  markOnly('.tile', $$(`.tile[data-i="${S.cur}"]`));
  markTableRow(follow);
  drawWave(follow);
}

/* ════════════════════════════════════════════════════════════════
   7. 타이밍 파형 (canvas)
   ════════════════════════════════════════════════════════════════ */
const LANE_H = 28, HEAD_H = 26, WAVE_PAD = 8;

function buildWave(){
  const D = S.D, w = S.wave;
  // 마지막 행이 MAX_TIME 마커처럼 멀리 떨어져 있고 값이 같으면 파형에서는 제외
  w.rows = D.rows.slice();
  const gaps = w.rows.slice(1).map((r, i) => r.t - w.rows[i].t).sort((a, b) => a - b);
  const median = gaps.length ? gaps[gaps.length >> 1] || 1 : 1;
  const [a, b] = [w.rows.at(-1), w.rows.at(-2)];
  if (w.rows.length > 2 && a.t - b.t > CFG.markerGapRatio * median && a.bits === b.bits) w.rows.pop();
  w.t0 = w.rows[0].t;
  w.tEnd = w.rows.at(-1).t + (w.rows.length > 1 ? median : 1);

  w.lanes = [
    ...D.vectors.map((v, k) => ({name:v.label, bus:true,  get:r => r.vs[k] == null ? 'X' : String(r.vs[k])})),
    ...D.signals.map((n, i)  => ({name:n,       bus:false, get:r => r.bits[i]})),
  ];
  for (const lane of w.lanes) {                   // 같은 값이 이어지는 구간을 하나로 합친다
    lane.segs = [];
    w.rows.forEach((r, i) => {
      const v = lane.get(r), t1 = w.rows[i + 1]?.t ?? w.tEnd, last = lane.segs.at(-1);
      if (last && last.v === v) last.t1 = t1; else lane.segs.push({t0:r.t, t1, v});
    });
  }
  $('#lanes').innerHTML = w.lanes.map(l => `<div class="lane ${l.bus ? 'bus' : ''}" title="${esc(l.name)}">${esc(l.name)}</div>`).join('');
}

const waveColors = () => ({ink:cssVar('--ink'), muted:cssVar('--muted'), line:cssVar('--line'), acc:cssVar('--accent'), bx:cssVar('--bx'), b1:cssVar('--b1')});

// 시간 눈금: 1·2·5 × 10^k 중 간격이 tickMinPx 이상인 첫 값
function tickStep(ppu){
  for (let e = 0; e < 9; e++) for (const m of [1, 2, 5]) if (m * 10 ** e * ppu >= CFG.tickMinPx) return m * 10 ** e;
  return 10 ** 9;
}

function drawAxis(ctx, g, c){
  const w = S.wave, step = tickStep(w.ppu);
  ctx.strokeStyle = c.line; ctx.fillStyle = c.muted; ctx.lineWidth = 1; ctx.textAlign = 'left';
  for (let t = Math.ceil(w.t0 / step) * step; t <= w.tEnd; t += step) {
    const x = Math.round(g.X(t)) + .5;
    ctx.beginPath(); ctx.moveTo(x, HEAD_H - 6); ctx.lineTo(x, g.H); ctx.stroke();
    ctx.fillText(String(t), x + 3, 10);
  }
}

// 버스: 육각형 안에 10진 값
function drawBusLane(ctx, lane, g, c, y0){
  const yHi = y0 + 7, yLo = y0 + LANE_H - 8, yMid = (yHi + yLo) / 2;
  ctx.textAlign = 'center';
  for (const sg of lane.segs) {
    const x1 = g.X(sg.t0), x2 = g.X(sg.t1), isX = sg.v === 'X', s = Math.min(4, (x2 - x1) / 3);
    ctx.beginPath();
    ctx.moveTo(x1 + s, yHi); ctx.lineTo(x2 - s, yHi); ctx.lineTo(x2, yMid);
    ctx.lineTo(x2 - s, yLo); ctx.lineTo(x1 + s, yLo); ctx.lineTo(x1, yMid); ctx.closePath();
    ctx.fillStyle = isX ? withAlpha(c.bx, '40') : withAlpha(c.acc, '22'); ctx.fill();
    ctx.strokeStyle = isX ? c.bx : c.acc; ctx.lineWidth = 1.2; ctx.stroke();
    if (x2 - x1 > ctx.measureText(sg.v).width + 12) { ctx.fillStyle = c.ink; ctx.fillText(sg.v, (x1 + x2) / 2, yMid + 1); }
  }
}

// 1비트 신호: 하이/로우 선, X는 색 띠
function drawBitLane(ctx, lane, g, c, y0){
  const yHi = y0 + 7, yLo = y0 + LANE_H - 8;
  let prevY = null;
  for (const sg of lane.segs) {
    const x1 = g.X(sg.t0), x2 = g.X(sg.t1);
    if (sg.v === 'X') {
      ctx.fillStyle = withAlpha(c.bx, '40'); ctx.fillRect(x1, yHi, x2 - x1, yLo - yHi);
      ctx.strokeStyle = c.bx; ctx.lineWidth = 1; ctx.strokeRect(x1 + .5, yHi + .5, x2 - x1, yLo - yHi);
      prevY = null; continue;
    }
    const y = sg.v === '1' ? yHi : yLo;
    ctx.strokeStyle = sg.v === '1' ? c.b1 : c.muted; ctx.lineWidth = 1.6;
    ctx.beginPath();
    if (prevY != null && prevY !== y) { ctx.moveTo(x1, prevY); ctx.lineTo(x1, y); } else ctx.moveTo(x1, y);
    ctx.lineTo(x2, y); ctx.stroke(); prevY = y;
  }
}

// 현재 위치 표시. 파형에서 제외된 마커 행을 골랐어도 끝 안쪽에 그린다. 반환: 커서 구간의 x 범위
function drawCursor(ctx, g, c){
  const w = S.wave, r = S.D.rows[S.cur], ri = w.rows.indexOf(r);
  const xc = g.X(Math.min(r.t, w.tEnd)), xn = g.X(ri >= 0 ? w.rows[ri + 1]?.t ?? w.tEnd : w.tEnd);
  ctx.fillStyle = withAlpha(c.acc, '1f'); ctx.fillRect(xc, 0, Math.max(2, xn - xc), g.H);
  ctx.strokeStyle = c.acc; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(xc, 0); ctx.lineTo(xc, g.H); ctx.stroke();
  return {xc, xn};
}

function drawWave(follow){
  const D = S.D, w = S.wave;
  if (!D || $('#content').hidden || !$('#waveWrap').clientWidth) return;   // 숨겨진 탭에서는 폭을 못 재므로 그리지 않는다
  const cv = $('#wave'), wrap = $('#waveWrap'), lanesW = $('#lanes').offsetWidth;

  const span = Math.max(1, w.tEnd - w.t0);
  w.ppu ??= Math.max(240, wrap.clientWidth - lanesW - 24) / span;    // 처음엔 화면 폭에 맞춤
  w.ppu = Math.min(w.ppu, CFG.maxCanvasPx / span);
  const g = {
    X: t => WAVE_PAD + (t - w.t0) * w.ppu,
    W: Math.ceil(span * w.ppu) + 2 * WAVE_PAD,
    H: HEAD_H + w.lanes.length * LANE_H + 4,
  };
  const dpr = window.devicePixelRatio || 1, ctx = cv.getContext('2d');
  cv.width = g.W * dpr; cv.height = g.H * dpr; cv.style.width = g.W + 'px'; cv.style.height = g.H + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = '11px Consolas, monospace'; ctx.textBaseline = 'middle';

  const c = waveColors();
  drawAxis(ctx, g, c);
  w.lanes.forEach((lane, li) => {
    const y0 = HEAD_H + li * LANE_H;
    ctx.strokeStyle = c.line; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, y0 + LANE_H - .5); ctx.lineTo(g.W, y0 + LANE_H - .5); ctx.stroke();
    (lane.bus ? drawBusLane : drawBitLane)(ctx, lane, g, c, y0);
  });
  const {xc, xn} = drawCursor(ctx, g, c);

  if (follow) {                                   // 커서가 보이는 영역 밖이면 스크롤
    const viewW = wrap.clientWidth - lanesW;
    if (xc < wrap.scrollLeft + 20 || xn > wrap.scrollLeft + viewW - 20) wrap.scrollLeft = Math.max(0, xc - viewW / 3);
  }
}

function zoomWave(factor, anchorPx){
  const w = S.wave, wrap = $('#waveWrap'), lanesW = $('#lanes').offsetWidth;
  const ax = anchorPx ?? wrap.clientWidth / 2;                       // 확대 기준점(화면 x)
  const tAt = w.t0 + (wrap.scrollLeft + ax - lanesW - WAVE_PAD) / w.ppu;
  w.ppu = Math.max(0.0005, w.ppu * factor);
  drawWave(false);
  wrap.scrollLeft = Math.max(0, (tAt - w.t0) * w.ppu + WAVE_PAD + lanesW - ax);
}


/* ════════════════════════════════════════════════════════════════
   8. 파일 열기
   ════════════════════════════════════════════════════════════════ */
/* 새 파일을 화면에 올린다.  keep: 같은 파일을 다시 읽는 경우(선택 위치·확대 유지)
   handle/stamp: 새로 열 때 함께 기억할 파일 핸들
   trimEnd: 끝에 연속된 X 행을 "시뮬레이션 끝 표시"로 보고 접기에서 뺄지 */
function loadBuffer(buf, name, {keep = false, handle = null, stamp = '', trimEnd = true} = {}){
  let D;
  try { D = parse(decodeBuf(buf)); }
  catch (e) { toast(e.message); return false; }

  S.D = D;
  if (keep) S.stamp = stamp;
  else { S.cur = 0; S.wave.ppu = null; S.trimEnd = trimEnd; S.galleryAll = false; setSource(handle, stamp); }
  autoInputs();                                   // 입력 추정이 판정(만든 FND 기준)보다 먼저 필요하다
  computeSteps(); evalAll();
  if (!keep) S.cur = S.steps[0];
  S.cur = Math.min(S.cur, D.rows.length - 1);

  $('#empty').hidden = true; $('#content').hidden = false;
  document.body.classList.toggle('noseg', !D.seg);
  $('#fileInfo').innerHTML = `<b>${esc(name)}</b> · ` +
    [`행 ${D.rows.length}`, `신호 ${D.signals.length}`, D.maxTime != null && `MAX_TIME ${D.maxTime}`].filter(Boolean).join(' · ');

  buildWave(); renderNotes(); renderGallery(); renderTable();
  refreshSelection();
  return true;
}

// 파일 핸들이 있으면 "다시 읽기/변경 감지"를 켠다
function setSource(handle, stamp){
  S.handle = handle; S.stamp = stamp;
  clearInterval(S.watch); S.watch = null; $('#watch').checked = false;
  $('#btnReload').hidden = $('#watchWrap').hidden = !handle;
}

async function loadHandle(handle){
  const f = await handle.getFile();
  loadBuffer(await f.arrayBuffer(), f.name, {handle, stamp:stampOf(f)});
}

// 여러 파일이 오면 첫 .out(없으면 첫 파일)을 연다
async function loadFiles(files){
  files = [...files];
  const f = files.find(f => /\.out$/i.test(f.name)) ?? files[0];
  loadBuffer(await f.arrayBuffer(), f.name);
}

async function openPicker(){
  if (!window.showOpenFilePicker) return $('#fileIn').click();
  let handle;
  try { [handle] = await window.showOpenFilePicker({types:[{description:'MySim 결과', accept:{'text/plain':['.out', '.txt']}}]}); }
  catch (e) { if (e.name !== 'AbortError') $('#fileIn').click(); return; }
  await loadHandle(handle);
}

async function reload(){
  if (!S.handle) return;
  const f = await S.handle.getFile();
  loadBuffer(await f.arrayBuffer(), f.name, {keep:true, stamp:stampOf(f)});
}

function toggleWatch(on){
  clearInterval(S.watch); S.watch = null;
  if (!on) return;
  S.watch = setInterval(async () => {
    try {
      if (stampOf(await S.handle.getFile()) === S.stamp) return;
      await reload(); toast('파일이 바뀌어 다시 읽었습니다');
    } catch { /* 저장 중이거나 잠긴 파일 — 다음 주기에 다시 시도 */ }
  }, CFG.watchMs);
}

function loadDemo(){
  let text = '[MySim Result V3.5]\nMAX_TIME 1000;\nVECTOR IN W X Y Z;\nWATCH A B C D E F G W X Y Z IN;\nTABLE_ORDER A B C D E F G W X Y Z;\nSTART\n';
  for (let n = 0; n < 32; n++) {
    const v = n % 16;
    text += `${n * 10} ${v <= 9 ? PAT[v][0] : '0000000'}${bstr(v, 4)}\n`;
  }
  text += '1000 XXXXXXXXXXX\nEND\n';
  loadBuffer(new TextEncoder().encode(text).buffer, '데모 (BCD → 7-세그먼트)');
}

/* ════════════════════════════════════════════════════════════════
   9. 이벤트 연결
   ════════════════════════════════════════════════════════════════ */
// 상단 · 파일
$('#btnOpen').onclick = $('#btnOpen2').onclick = guard(openPicker);
$('#btnDemo').onclick = $('#btnDemo2').onclick = loadDemo;
$('#btnReload').onclick = guard(reload);
$('#watch').onchange = blurAfter(e => toggleWatch(e.target.checked));
$('#fileIn').onchange = guard(async e => { const files = [...e.target.files]; e.target.value = ''; if (files.length) await loadFiles(files); });

// 출력 검증
$('#bFirst').onclick = goFirst;
$('#bPrev').onclick = goPrev;
$('#bNext').onclick = goNext;
$('#slider').oninput = e => selectRow(S.steps[Number(e.target.value)]);
$('#auto').onchange = blurAfter(e => setAuto(e.target.checked));
$('#speed').onchange = blurAfter(e => { store.set('speed', e.target.value); if ($('#auto').checked) setAuto(true); });
$('#mode').onchange = blurAfter(e => {
  S.mode = e.target.value; store.set('mode', S.mode);
  if (S.D) reverify();
});
$('#fold').onchange = blurAfter(e => { S.fold = e.target.checked; computeSteps(); renderGallery(); renderTable(); refreshSelection(false); });
$('#gallery').onclick = e => { const t = e.target.closest('.tile'); if (t) selectRow(Number(t.dataset.i)); };
$('#segSummary').onclick = e => {
  const b = e.target.closest('button[data-i]');
  if (!b) return;
  const i = Number(b.dataset.i);
  if (!S.galleryAll && S.steps.indexOf(i) >= CFG.galleryTiles) { S.galleryAll = true; renderGallery(); }   // 아직 안 그린 칸이면 펼쳐서 보여준다
  selectRow(i);
};
$('#galleryMore').onclick = e => { if (e.target.closest('#galleryAll')) { S.galleryAll = true; renderGallery(); refreshSelection(false); } };
$('#tbl').onclick = e => { const t = e.target.closest('tr[data-i]'); if (t) selectRow(Number(t.dataset.i)); };

// 파형
$('#zIn').onclick = () => zoomWave(1.5);
$('#zOut').onclick = () => zoomWave(1 / 1.5);
$('#zFit').onclick = () => { S.wave.ppu = null; drawWave(false); $('#waveWrap').scrollLeft = 0; };
$('#wave').onclick = e => {
  const w = S.wave, t = w.t0 + (e.clientX - e.currentTarget.getBoundingClientRect().left - WAVE_PAD) / w.ppu;
  selectRow((w.rows.findLast(r => r.t <= t) ?? w.rows[0]).i);
};
$('#waveWrap').addEventListener('wheel', e => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  zoomWave(e.deltaY < 0 ? 1.25 : 0.8, e.clientX - $('#waveWrap').getBoundingClientRect().left);
}, {passive:false});

// 키보드: 입력 컨트롤(슬라이더·체크박스·선택 상자)은 자체 키 처리를 존중한다
addEventListener('keydown', e => {
  if (!viewerEnabled() || !S.D || e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (tag === 'BUTTON' && e.key === ' ') return;
  const action = {ArrowRight:goNext, ' ':goNext, ArrowLeft:goPrev, Home:goFirst, End:goLast}[e.key];
  if (action) { e.preventDefault(); action(); }
});

// 드래그 앤 드롭 (한 파일이면 핸들을 받아 "다시 읽기"까지 지원)
let dragDepth = 0;
addEventListener('dragenter', e => { if (!viewerEnabled()) return; e.preventDefault(); dragDepth++; showDropOverlay('놓아서 열기'); });
addEventListener('dragleave', () => { if (viewerEnabled() && --dragDepth <= 0) { dragDepth = 0; $('#drop').hidden = true; } });
addEventListener('dragover', e => { if (viewerEnabled()) e.preventDefault(); });
addEventListener('drop', guard(async e => {
  if (!viewerEnabled()) return;
  e.preventDefault(); dragDepth = 0; $('#drop').hidden = true;
  const {files, items} = e.dataTransfer;
  if (files.length === 1 && items[0]?.getAsFileSystemHandle) {
    try { const h = await items[0].getAsFileSystemHandle(); if (h?.kind === 'file') return await loadHandle(h); } catch { /* 일반 파일로 처리 */ }
  }
  if (files.length) await loadFiles(files);
}));

addEventListener('resize', () => S.D && drawWave(false));

document.addEventListener('themechange', () => S.D && drawWave(false));

/* ════════════════════════════════════════════════════════════════
   10. 시작: 저장된 설정 복원
   ════════════════════════════════════════════════════════════════ */
for (const id of ['mode', 'speed']) {
  const el = $('#' + id), saved = store.get(id);
  if ([...el.options].some(o => o.value === saved)) el.value = saved;
}
S.mode = $('#mode').value;
loadDesign();                                     // 만든 FND (검증 기준 "만든 FND"에 쓴다)
