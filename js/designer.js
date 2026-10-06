'use strict';
/* FND Studio · 설계 탭: 입력 W X Y Z(16가지)마다 A~G 세그먼트를 직접 설계하고, 진리표 · 카르노 맵(묶음/간소화)으로 본다.
   만든 모양(DS)은 localStorage에 저장되며 검증·채점 탭의 기준("만든 FND")으로 쓰인다.      공통 코드: common.js */

/* ════════════════════════════════════════════════════════════════
   1. 설계 데이터와 FND 칸
   ════════════════════════════════════════════════════════════════ */
const NEXT = {'0':'1', '1':'X', 'X':'0'};       // 세그먼트를 누를 때마다: 꺼짐 → 켜짐 → X(돈케어) → 꺼짐
const STATE_NAME = {'0':'꺼짐', '1':'켜짐', 'X':'돈케어'};
const segClass = c => c === '1' ? ' on' : c === 'X' ? ' x' : '';
const ariaChecked = c => c === '1' ? 'true' : c === 'X' ? 'mixed' : 'false';
const segAria = (v, k, c) => `입력 ${hexDigit(v)} · ${SEG_NAMES[k]} 세그먼트 · ${STATE_NAME[c]}`;
const GRAY2 = [0, 1, 3, 2];                      // 2비트 그레이 코드 (카르노 맵 축 순서)
Object.assign(DS, {
  sel:null,                                      // 선택한 입력(0~15)
  mode:'sop',                                    // 'sop': 1을 묶음(곱의 합) / 'pos': 0을 묶음(합의 곱)
  pick:Array(7).fill(0), sig:Array(7).fill(''),  // 세그먼트별로 고른 해 번호와, 그 해가 어떤 입력에 대한 것인지 구분하는 서명
});

function digitHtml(v){
  const bits = DS.seg[v];
  let svg = `<svg viewBox="0 0 60 100" role="group" aria-label="입력 ${hexDigit(v)}의 FND">`;
  for (let k = 0; k < 7; k++) {
    const c = bits[k];
    svg += `<polygon class="s${segClass(c)}" data-k="${k}" points="${SEG_POLY[k]}" tabindex="-1" role="checkbox" aria-checked="${ariaChecked(c)}" aria-label="${segAria(v, k, c)}"/>` +
           `<text class="sl${segClass(c)}" x="${SEG_LABEL_POS[k][0]}" y="${SEG_LABEL_POS[k][1]}">${SEG_NAMES[k]}</text>`;
  }
  const allX = bits === ALL_X;
  return `<div class="dig" data-v="${v}"><div class="dh"><button type="button" class="dl" title="이 칸을 선택"><b>${hexDigit(v)}</b><span>${bstr(v, 4)}</span></button>` +
    `<button type="button" tabindex="-1" class="dx${allX ? ' on' : ''}" aria-pressed="${allX}" aria-label="입력 ${hexDigit(v)} 전체 돈케어" title="이 FND 전체를 X(돈케어)로 · 다시 누르면 비움">X</button></div>${svg}</svg></div>`;
}

function renderDTable(){
  const cell = (ch, extra = '') => `<td class="${ch === '1' ? 'b1' : ch === 'X' ? 'bx' : 'b0'}${extra}">${ch}</td>`;
  const head = IN_NAMES.map((n, i) => `<th class="in${i === 3 ? ' sep' : ''}">${n}</th>`).join('') +
    [...SEG_NAMES].map(n => `<th>${n}</th>`).join('') + '<th class="vv">입력값</th>';
  const body = DS.seg.map((s, v) =>
    `<tr data-v="${v}">${[...bstr(v, 4)].map((ch, i) => cell(ch, i === 3 ? ' sep' : '')).join('')}${[...s].map(ch => cell(ch)).join('')}` +
    `<td class="vv">${v}<span class="hx">${hexStr(v, 4)}</span></td></tr>`).join('');
  $('#dTbl').innerHTML = `<thead><tr>${head}</tr></thead><tbody>${body}</tbody>`;
}

/* ─ 묶기: 소인수 항(Quine–McCluskey)을 구하고, 항 수 → 리터럴 수가 최소인 해를 모두 모은다 ─
   항 = {v, dc}: dc의 1비트는 "그 변수는 상관없음". ones는 반드시 덮고, 돈케어(dcs)는 덮어도 안 덮어도 된다 */
const covers = (p, m) => (m & ~p.dc) === p.v;
const literalCount = p => 4 - [...bstr(p.dc, 4)].filter(c => c === '1').length;

function primeImplicants(ones, dcs){
  let level = new Map([...ones, ...dcs].map(m => [`${m}/0`, {v:m, dc:0}]));
  const primes = [];
  while (level.size) {                          // 한 비트만 다른 항끼리 합쳐 가며, 더 못 합친 항이 소인수 항
    const terms = [...level.values()], merged = new Set(), next = new Map();
    terms.forEach((a, i) => terms.slice(i + 1).forEach(b => {
      const d = a.v ^ b.v;
      if (a.dc === b.dc && d && (d & (d - 1)) === 0) {
        const t = {v:a.v & ~d, dc:a.dc | d};
        next.set(`${t.v}/${t.dc}`, t); merged.add(a); merged.add(b);
      }
    }));
    primes.push(...terms.filter(t => !merged.has(t)));
    level = next;
  }
  return primes.filter(p => ones.some(m => covers(p, m)));    // 돈케어만 덮는 항은 쓸모없다
}

function bestCovers(ones, primes){
  if (!ones.length) return [[]];
  const cost = set => [set.length, set.reduce((s, p) => s + literalCount(p), 0)];
  const less = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
  let best = [Infinity, 0], sols = [], seen = new Set(), nodes = 0;
  (function search(chosen, left){
    if (++nodes > 20000) return;                // 4변수에서는 닿지 않는 안전장치
    const c = cost(chosen);
    if (less(best, c)) return;
    if (!left.length) {
      const key = chosen.map(p => `${p.v}/${p.dc}`).sort().join(',');
      if (less(c, best)) { best = c; sols = []; seen = new Set(); }
      if (!seen.has(key)) { seen.add(key); sols.push(chosen.slice()); }
      return;
    }
    let pick = null;                            // 덮을 수 있는 항이 가장 적은 최소항부터 분기
    for (const m of left) { const cs = primes.filter(p => covers(p, m)); if (!pick || cs.length < pick.length) pick = cs; }
    for (const p of pick) search([...chosen, p], left.filter(m => !covers(p, m)));
  })([], ones);
  return sols;
}

// 세그먼트 k의 해들: mode가 sop면 1을, pos면 0을 묶는다
function solveSeg(k, mode){
  const want = mode === 'sop' ? '1' : '0', ones = [], dcs = [];
  for (let m = 0; m < 16; m++) { const v = DS.seg[m][k]; if (v === want) ones.push(m); else if (v === 'X') dcs.push(m); }
  const first = p => Math.min(...ones.filter(m => covers(p, m)));
  const sols = bestCovers(ones, primeImplicants(ones, dcs))
    .map(s => s.slice().sort((a, b) => first(a) - first(b) || a.v - b.v));
  const key = s => s.map(p => `${String(p.v).padStart(2, '0')}/${p.dc}`).join(',');
  return {ones, dcs, sols:sols.sort((a, b) => key(a) < key(b) ? -1 : 1)};
}

/* ─ 식 ─ */
const lit = (name, neg) => `<span${neg ? ' class="ov"' : ''}>${esc(name)}</span>`;
function termHtml(p, mode, color){
  const vars = IN_NAMES.map((nm, i) => ({nm, bit:3 - i})).filter(x => !((p.dc >> x.bit) & 1));
  const val = x => (p.v >> x.bit) & 1;
  let body;
  if (mode === 'sop') body = vars.map(x => lit(x.nm, !val(x))).join('') || '1';             // 곱: 값 0인 변수는 보수
  else body = vars.length ? `(${vars.map(x => lit(x.nm, !!val(x))).join(' + ')})` : '0';    // 합: 값 1인 변수는 보수
  return `<span class="term"${color ? ` style="color:${color}"` : ''}>${body}</span>`;
}

/* ─ 도형: 항이 덮는 영역을 사각형(가장자리를 넘으면 둘로 나눈 조각)으로 바꿔 둥근 선으로 그린다 ─
   KM의 값은 CSS .km의 고정 크기와 같아야 한다 */
const KM = {hw:26, hh:18, cw:38, ch:36, gap:2};
const KM_W = KM.hw + 4 * KM.cw + 4 * KM.gap, KM_H = KM.hh + 4 * KM.ch + 4 * KM.gap;
const kmLeft = c => KM.hw + KM.gap + c * (KM.cw + KM.gap);
const kmTop  = r => KM.hh + KM.gap + r * (KM.ch + KM.gap);
// 한 맵의 항은 최대 8개이므로(4변수 최적해) 항마다 서로 다른 색이 돌아간다. 테마별 색은 CSS 변수 --k0~--k7.
// 혹시 8개를 넘으면 황금각으로 색상을 벌려 겹치지 않게 한다
const kmColor = i => i < 8 ? `var(--k${i})` : `hsl(${Math.round((i * 137.508) % 360)} 65% 45%)`;

// 축 위의 위치(0~3, 그레이 순서) 중 항과 맞는 곳은 연속(순환) 구간이다. 시작 위치와 길이로 나타낸다
function axisSpan(ok){
  const pos = [0, 1, 2, 3].filter(ok);
  if (pos.length === 4) return {start:0, len:4};
  if (pos.length === 2 && pos[0] === 0 && pos[1] === 3) return {start:3, len:2};   // 끝과 처음이 이어짐
  return {start:pos[0], len:pos.length};
}
// 구간을 조각으로: 끝을 넘으면 [시작~3](뒤가 열림)과 [0~나머지](앞이 열림)로 나눈다
function axisPieces({start, len}){
  const end = start + len - 1;
  if (end <= 3) return [{a:start, b:end, lo:false, hi:false}];
  return [{a:start, b:3, lo:false, hi:true}, {a:0, b:end - 4, lo:true, hi:false}];
}
function loopPieces(p){
  const rowOk = r => (((GRAY2[r] << 2) ^ p.v) & ~p.dc & 12) === 0;     // 행 = 비트 3,2 (W X)
  const colOk = c => ((GRAY2[c] ^ p.v) & ~p.dc & 3) === 0;             // 열 = 비트 1,0 (Y Z)
  const rows = axisPieces(axisSpan(rowOk)), cols = axisPieces(axisSpan(colOk));
  return rows.flatMap(r => cols.map(c => ({r, c})));
}

/* 둥근 사각형 선. 열린 변(o.t/b/l/r)은 그리지 않고, 그 변에 닿는 두 변을 바깥으로 조금 더 내밀어
   "다음 칸으로 이어짐"을 나타낸다. 닫힌 모서리만 둥글게 한다 */
function loopPath(x1, y1, x2, y2, o){
  const S = 9, R = Math.min(11, (x2 - x1) / 2, (y2 - y1) / 2);
  const rTL = !o.t && !o.l ? R : 0, rTR = !o.t && !o.r ? R : 0, rBR = !o.b && !o.r ? R : 0, rBL = !o.b && !o.l ? R : 0;
  let d = '';
  const line = (xa, ya, xb, yb) => { d += `M${xa} ${ya}L${xb} ${yb}`; };
  if (!o.t) line(o.l ? x1 - S : x1 + rTL, y1, o.r ? x2 + S : x2 - rTR, y1);
  if (!o.b) line(o.l ? x1 - S : x1 + rBL, y2, o.r ? x2 + S : x2 - rBR, y2);
  if (!o.l) line(x1, o.t ? y1 - S : y1 + rTL, x1, o.b ? y2 + S : y2 - rBL);
  if (!o.r) line(x2, o.t ? y1 - S : y1 + rTR, x2, o.b ? y2 + S : y2 - rBR);
  if (rTL) d += `M${x1} ${y1 + rTL}A${rTL} ${rTL} 0 0 1 ${x1 + rTL} ${y1}`;
  if (rTR) d += `M${x2 - rTR} ${y1}A${rTR} ${rTR} 0 0 1 ${x2} ${y1 + rTR}`;
  if (rBR) d += `M${x2} ${y2 - rBR}A${rBR} ${rBR} 0 0 1 ${x2 - rBR} ${y2}`;
  if (rBL) d += `M${x1 + rBL} ${y2}A${rBL} ${rBL} 0 0 1 ${x1} ${y2 - rBL}`;
  return d;
}

// 같은 칸을 지나는 묶음끼리 선이 겹치지 않도록 항마다 안쪽 여백을 조금씩 달리한다
function loopsSvg(terms){
  const paths = terms.map((p, i) => {
    const pad = 2.5 + (i % 3) * 2.5;
    return loopPieces(p).map(({r, c}) => {
      const d = loopPath(kmLeft(c.a) + pad, kmTop(r.a) + pad, kmLeft(c.b) + KM.cw - pad, kmTop(r.b) + KM.ch - pad,
        {t:r.lo, b:r.hi, l:c.lo, r:c.hi});
      return `<path d="${d}" style="stroke:${kmColor(i)}"/>`;
    }).join('');
  }).join('');
  return `<svg class="loops" width="${KM_W}" height="${KM_H}" viewBox="0 0 ${KM_W} ${KM_H}" aria-hidden="true">${paths}</svg>`;
}

/* ─ 카르노 맵 카드 ─ */
// 세그먼트마다 4변수 맵 하나. 행 = W X, 열 = Y Z (그레이 코드)
function kmapCardHtml(k){
  const mode = DS.mode, {ones, dcs, sols} = solveSeg(k, mode);
  const sig = mode + DS.seg.map(s => s[k]).join('');
  if (DS.sig[k] !== sig) { DS.sig[k] = sig; DS.pick[k] = 0; }          // 입력이 바뀌면 첫 번째 해로
  DS.pick[k] = Math.min(DS.pick[k], sols.length - 1);
  const terms = sols[DS.pick[k]];

  let cells = `<div class="cn">WX\\YZ</div>${GRAY2.map(c => `<div class="ch">${bstr(c, 2)}</div>`).join('')}`;
  for (const r of GRAY2) {
    cells += `<div class="rh">${bstr(r, 2)}</div>`;
    for (const c of GRAY2) {
      const m = (r << 2) | c, v = DS.seg[m][k];
      cells += `<div class="kc ${v === '1' ? 'v1' : v === 'X' ? 'vx' : 'v0'}" data-v="${m}"><span class="m">${m}</span>${v}</div>`;
    }
  }
  const eq = `<span class="eq">${SEG_NAMES[k]} =</span>`;
  const exprOf = (sol, colored) => !ones.length ? (mode === 'sop' ? '0' : '1')
    : sol.map((p, i) => termHtml(p, mode, colored ? kmColor(i) : null)).join(mode === 'sop' ? ' + ' : '');
  // 최적의 식이 여러 개면 모두 나열해 고르게 한다. 고른 식만 색을 입혀 도형과 대응시킨다
  const exprHtml = sols.length > 1
    ? `<div class="sols" role="radiogroup" aria-label="${SEG_NAMES[k]}의 식 선택">` + sols.map((s, i) => {
        const on = i === DS.pick[k];
        return `<label class="sol${on ? ' on' : ''}"><input type="radio" class="sol-radio" name="sol-${k}" data-k="${k}" value="${i}"${on ? ' checked' : ''}>` +
               `<span class="no">${i + 1}</span><span class="se">${eq} ${exprOf(s, on)}</span></label>`;
      }).join('') + '</div>'
    : `<div class="ex">${eq} ${exprOf(terms, true)}</div>`;
  const cnt = sols.length > 1 ? `<span class="cnt" title="항 수와 리터럴 수가 같은 최적의 식이 ${sols.length}개 있습니다">식 ${sols.length}개</span>` : '';
  return `<div class="kmw" data-k="${k}"><div class="kh"><span class="ttl">${SEG_NAMES[k]}<small>${mode === 'sop' ? '1' : '0'}이 ${ones.length}개${dcs.length ? ` · X ${dcs.length}개` : ''}</small></span>${cnt}</div>` +
    `<div class="km">${cells}${ones.length ? loopsSvg(terms) : ''}</div>${exprHtml}</div>`;
}

function renderKmaps(){
  $('#dKmaps').classList.toggle('pos', DS.mode === 'pos');
  $('#dKmaps').innerHTML = range(7).map(kmapCardHtml).join('');
}

function setKmapMode(mode){
  DS.mode = mode; store.set('kmode', mode);
  $('#dSop').classList.toggle('on', mode === 'sop'); $('#dSop').setAttribute('aria-pressed', mode === 'sop');
  $('#dPos').classList.toggle('on', mode === 'pos'); $('#dPos').setAttribute('aria-pressed', mode === 'pos');
  renderKmaps(); markDesignSel();
}

// 식 선택은 그 카드만 다시 그린다. 방향키로 계속 고를 수 있도록 선택된 라디오로 포커스를 되돌린다
function pickSolution(k, i){
  DS.pick[k] = i;
  $(`#dKmaps .kmw[data-k="${k}"]`).outerHTML = kmapCardHtml(k);
  markDesignSel();
  $(`#dKmaps .kmw[data-k="${k}"] input.sol-radio:checked`)?.focus();
}

// 선택한 입력(0~15)을 FND·진리표·카르노 맵에서 함께 강조
function markDesignSel(){
  const v = DS.sel, find = sel => v == null ? [] : $$(`${sel}[data-v="${v}"]`);
  markOnly('.dig', find('.dig'));
  markOnly('#dTbl tr', find('#dTbl tr'));
  markOnly('#dKmaps .kc', find('#dKmaps .kc'));
}
function selectDigit(v){ DS.sel = v; markDesignSel(); }

function renderDesign(){
  $('#digits').innerHTML = range(16).map(digitHtml).join('');
  renderDTable(); renderKmaps(); markDesignSel();
}

function syncDigit(v){                          // 칸을 다시 그리지 않고 상태만 갱신 (키보드 포커스 유지)
  const el = $(`.dig[data-v="${v}"]`), bits = DS.seg[v];
  el.querySelectorAll('polygon').forEach(p => {
    const k = Number(p.dataset.k), c = bits[k];
    p.setAttribute('class', 's' + segClass(c));
    p.setAttribute('aria-checked', ariaChecked(c)); p.setAttribute('aria-label', segAria(v, k, c));
  });
  el.querySelectorAll('text').forEach((t, k) => t.setAttribute('class', 'sl' + segClass(bits[k])));
  const dx = el.querySelector('.dx'), allX = bits === ALL_X;
  dx.classList.toggle('on', allX); dx.setAttribute('aria-pressed', allX);
}

/* ─ 실행 취소 / 다시 실행: 만든 모양(DS.seg 전체)의 변경 이력. 한 번의 조작이 한 단계다 ─ */
const HIST = {cur:'', past:[], future:[], max:200};
const histSnap = () => DS.seg.join(',');
function syncUndoButtons(){
  $('#dUndo').disabled = !HIST.past.length;
  $('#dRedo').disabled = !HIST.future.length;
}
function recordHistory(){                        // 바뀐 게 있을 때만 한 단계로 남기고, 다시 실행 이력은 버린다
  const now = histSnap();
  if (now === HIST.cur) return;
  HIST.past.push(HIST.cur);
  if (HIST.past.length > HIST.max) HIST.past.shift();
  HIST.cur = now; HIST.future = [];
  syncUndoButtons();
}
function restoreHistory(){
  DS.seg = HIST.cur.split(',');
  saveDesign(); renderDesign(); syncUndoButtons();
}
function undo(){
  if (!HIST.past.length) return toast('더 이상 취소할 내용이 없습니다');
  HIST.future.push(HIST.cur); HIST.cur = HIST.past.pop(); restoreHistory();
}
function redo(){
  if (!HIST.future.length) return toast('다시 실행할 내용이 없습니다');
  HIST.past.push(HIST.cur); HIST.cur = HIST.future.pop(); restoreHistory();
}

// 한 칸이 바뀐 뒤 저장하고 진리표·카르노 맵·강조를 갱신
function commitDigit(v){
  DS.sel = v;
  saveDesign(); recordHistory(); syncDigit(v); renderDTable(); renderKmaps(); markDesignSel();
}
function toggleSeg(v, k){
  const bits = [...DS.seg[v]];
  bits[k] = NEXT[bits[k]];
  DS.seg[v] = bits.join('');
  commitDigit(v);
}
function toggleAllX(v){                         // FND 전체 돈케어(X) ↔ 비움
  DS.seg[v] = DS.seg[v] === ALL_X ? BLANK : ALL_X;
  commitDigit(v);
}

function replaceDesign(seg, sel = null){
  DS.seg = seg; DS.sel = sel;
  saveDesign(); recordHistory(); renderDesign();
}
const confirmOverwrite = msg => isBlank() || confirm(msg);

function fillStandard(kind){
  if (!confirmOverwrite('지금 만든 모양을 표준 모양으로 덮어씁니다. 계속할까요?')) return;
  replaceDesign(range(16).map(v => kind === 'bcd' && v > 9 ? ALL_X : PAT[v][0]));   // BCD의 10~15는 돈케어
}
function clearDesign(){
  if (!confirmOverwrite('모든 세그먼트를 지웁니다. 계속할까요?')) return;
  replaceDesign(Array(16).fill(BLANK));
}

/* ─ 글자 입력: 칸을 선택하고 0–9, A–Z를 누르면 그 글자 모양으로 바뀐다 ─
   a b c d e f g 순서. 0~F는 표준 모양(PAT)을 그대로 쓰고, 나머지 글자는 7-세그먼트에서 흔히 쓰는 모양이다.
   표현할 수 없는 글자(K, M, V, W)는 알려 주고, X는 돈케어, Backspace/Delete는 지우기로 쓴다 */
const GLYPH = {
  g:'1011110', h:'0110111', i:'0000110', j:'0111000', l:'0001110', n:'0010101', o:'0011101',
  p:'1100111', q:'1110011', r:'0000101', s:'1011011', t:'0001111', u:'0111110', y:'0111011', z:'1101101',
  '-':'0000001', '_':'0001000',
};
range(16).forEach(v => { GLYPH[hexDigit(v).toLowerCase()] = PAT[v][0]; });

// 키보드는 e.key가 아니라 물리 키(e.code)로 읽는다. 한글 입력 상태에서도 같은 글자로 인식된다
function keyChar(e){
  const c = e.code;
  if (/^Digit\d$/.test(c)) return c.slice(5);
  if (/^Numpad\d$/.test(c)) return c.slice(6);
  if (/^Key[A-Z]$/.test(c)) return c.slice(3).toLowerCase();
  if (c === 'Minus' || c === 'NumpadSubtract') return e.shiftKey ? '_' : '-';
  return null;
}

let designEnabled = () => true;                  // 키 입력에 반응할지 (studio.js가 설계 탭일 때만 true가 되게 바꾼다)
function designKey(e){
  if (!designEnabled() || e.altKey) return;
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;     // 식 선택 등 입력 컨트롤은 그대로 둔다
  if (e.ctrlKey || e.metaKey) {                                              // Ctrl+Z 취소, Ctrl+Y / Ctrl+Shift+Z 다시 실행
    if (e.code !== 'KeyZ' && e.code !== 'KeyY') return;
    e.preventDefault();
    if (e.code === 'KeyY' || e.shiftKey) redo(); else undo();
    return;
  }
  const v = DS.sel;
  if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {                  // ←/→: 선택한 칸 옮기기
    e.preventDefault();
    const next = v == null ? 0 : (v + (e.code === 'ArrowRight' ? 1 : 15)) % 16;
    selectDigit(next);
    if (e.target.closest('#digits')) $(`.dig[data-v="${next}"] .dl`).focus();     // 칸 안에 있던 포커스도 같이 옮긴다
    return;
  }
  if (v == null) return;
  let bits;
  if (e.code === 'Backspace' || e.code === 'Delete') bits = BLANK;
  else if (e.code === 'KeyX') bits = ALL_X;
  else {
    const ch = keyChar(e);
    if (ch == null) return;
    bits = GLYPH[ch];
    if (!bits) { e.preventDefault(); toast(`"${ch.toUpperCase()}"는 7-세그먼트로 표현할 수 없는 글자입니다`); return; }
  }
  e.preventDefault();
  DS.seg[v] = bits; commitDigit(v);
}

/* ─ 내보내기 ─ */
const designCsv = () => [[...IN_NAMES, ...SEG_NAMES].join(','),
  ...DS.seg.map((s, v) => [...bstr(v, 4), ...s].join(','))].join('\n');

async function copyText(text){
  try { await navigator.clipboard.writeText(text); }
  catch {                                       // 클립보드 API를 못 쓰는 환경
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
    document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
}

function downloadOut(){
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([designOut()], {type:'text/plain'}));
  a.download = 'custom-fnd.out';
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ════════════════════════════════════════════════════════════════
   2. 이벤트 연결
   ════════════════════════════════════════════════════════════════ */
$('#digits').onclick = e => {
  const seg = e.target.closest('polygon[data-k]'), dig = e.target.closest('.dig');
  if (!dig) return;
  const v = Number(dig.dataset.v);
  if (seg) toggleSeg(v, Number(seg.dataset.k));
  else if (e.target.closest('.dx')) toggleAllX(v);
  else selectDigit(v);
};
$('#digits').onkeydown = e => {                  // Tab으로 세그먼트를 옮겨 Space/Enter로 토글
  const seg = e.key === 'Enter' || e.key === ' ' ? e.target.closest('polygon[data-k]') : null;
  if (!seg) return;
  e.preventDefault(); toggleSeg(Number(seg.closest('.dig').dataset.v), Number(seg.dataset.k));
};
// Tab / Shift+Tab은 칸의 이름표 버튼(.dl)만 지나므로 "다음/이전 FND"로 넘어간다. 포커스를 받은 칸이 선택된다
$('#digits').addEventListener('focusin', e => {
  const dl = e.target.closest('.dl');
  if (dl) selectDigit(Number(dl.closest('.dig').dataset.v));
});
$('#dTbl').onclick = e => { const tr = e.target.closest('tr[data-v]'); if (tr) selectDigit(Number(tr.dataset.v)); };
$('#dKmaps').onclick = e => { const c = e.target.closest('.kc'); if (c) selectDigit(Number(c.dataset.v)); };
$('#dKmaps').onchange = e => { const r = e.target.closest('input.sol-radio'); if (r) pickSolution(Number(r.dataset.k), Number(r.value)); };
$('#dSop').onclick = () => setKmapMode('sop');
$('#dPos').onclick = () => setKmapMode('pos');
$('#dBcd').onclick = () => fillStandard('bcd');
$('#dHex').onclick = () => fillStandard('hex');
$('#dClear').onclick = clearDesign;
$('#dUndo').onclick = undo;
$('#dRedo').onclick = redo;
$('#dCopy').onclick = guard(async () => { await copyText(designCsv()); toast('진리표를 CSV로 복사했습니다 (16행)'); });
$('#dSave').onclick = downloadOut;
addEventListener('keydown', designKey);

/* ════════════════════════════════════════════════════════════════
   3. 시작
   ════════════════════════════════════════════════════════════════ */
loadDesign(); HIST.cur = histSnap(); syncUndoButtons(); renderDesign();
setKmapMode(store.get('kmode') === 'pos' ? 'pos' : 'sop');
