'use strict';
/* FND Studio · 채점 탭: 여러 학생의 .out 파일(또는 폴더)을 한 번에 올려 "만든 FND"와 비교하고 결과를 표로 보여준다.
   파일은 브라우저 안에서만 읽는다(서버로 보내지 않는다).
   판정 로직(만든 FND와 비교)은 viewer.js, 만든 FND는 common.js의 DS, 내보내기 도구는 designer.js를 쓴다 */

/* ════════════════════════════════════════════════════════════════
   1. 채점
      입력값(0~15) 하나당: 채점 대상 행이 만든 FND와 모두 맞으면 일치, 하나라도 다르면 불일치,
      한 번도 안 나왔으면 누락(전부 돈케어인 입력은 안 나와도 일치로 본다)
      채점 대상 행(policy):
        stable  입력이 다음 값으로 바뀌기 직전의 마지막 행 = 출력이 안정된 상태 (기본)
        all     그 입력이 나온 모든 행. 입력이 바뀐 직후의 과도 상태도 틀린 것으로 센다
   ════════════════════════════════════════════════════════════════ */
const GR = {
  items:[],               // {name, buf, status:'pass'|'fail'|'error'|'wait', ok, bad, miss, fails[], missing[], basis, note}
  filter:'all', sort:'name',
  policy: store.get('gpolicy') === 'all' ? 'all' : 'stable',
  allowBlank:false,       // 만든 FND가 비어 있어도 채점하겠다고 확인했는지
  sig:'',                 // 채점할 때의 기준 (바뀌면 다시 채점)
};
let graderEnabled = () => true;                  // 드롭에 반응할지 (studio.js가 채점 탭일 때만 true가 되게 바꾼다)

const specSig = () => [DS.seg.join(''), GR.policy, GR.allowBlank].join('|');
const gradeBlocked = () => isBlank() && !GR.allowBlank;
const byName = new Intl.Collator('ko', {numeric:true, sensitivity:'base'});

/* 채점에 쓸 입력 신호(MSB→LSB)와 그 근거.
   vector  파일의 VECTOR (A–G를 뺀 첫 VECTOR). 학생이 적은 것이라 입력이 맞는지는 신호 이름으로 확인한다
   order   A–G를 뺀 신호가 정확히 4개일 때 그 신호들을 파일에 적힌 순서대로
   infer   그 밖에는 값이 0,1,2…로 세는 신호 조합을 찾는다 (가장 불확실) */
function gradeInputs(D){
  const names = idx => idx.map(i => D.signals[i]).join(' ');
  if (D.vec) {
    if (D.vec.idx.length !== 4) return {error:`VECTOR가 ${D.vec.idx.length}비트입니다 (입력 4비트가 아님): ${names(D.vec.idx)}`};
    return {kind:'vector', idx:D.vec.idx, names:names(D.vec.idx)};
  }
  const rest = range(D.signals.length).filter(i => !D.seg.includes(i));
  if (rest.length === 4) return {kind:'order', idx:rest, names:names(rest)};
  const idx = inputsFor(D, null);
  if (idx.length === 4 && !idx.some(i => D.seg.includes(i))) return {kind:'infer', idx, names:names(idx)};
  return {error:'입력 신호를 알 수 없습니다 (VECTOR 없음, 입력 추정 실패)'};
}

function gradeBuffer(name, buf){
  if (gradeBlocked()) return {status:'wait', note:'만든 FND가 비어 있어 채점을 보류했습니다'};
  let D;
  try { D = parse(decodeBuf(buf)); }
  catch (e) { return {status:'error', note:e.message}; }
  if (!D.seg) return {status:'error', note:'A–G 신호가 없습니다'};

  const inp = gradeInputs(D);
  if (inp.error) return {status:'error', note:inp.error};
  const vk = D.vectors.indexOf(D.vec);
  const valueOf = r => {
    if (inp.kind === 'vector') return r.vs[vk];
    const key = inp.idx.map(i => r.bits[i]).join('');
    return key.includes('X') ? null : parseInt(key, 2);
  };

  const seq = D.rows.map(r => ({r, v:valueOf(r)}));
  const picked = seq.filter((x, i) => x.v != null && (GR.policy === 'all' || seq[i + 1]?.v !== x.v));
  if (!picked.length) return {status:'error', note:'입력값이 모두 X여서 채점할 행이 없습니다'};

  const slots = range(16).map(() => ({rows:0, bad:null}));
  for (const {r, v} of picked) {
    if (v > 15) continue;
    const e = compareCustom(D, r, v), s = slots[v];
    s.rows++;
    if (e.st === 'bad' && !s.bad) s.bad = {...e, t:r.t};    // 같은 입력이 여러 번 틀리면 처음 것만 기록
  }

  const res = {ok:0, bad:0, miss:0, fails:[], missing:[], basis:{kind:inp.kind, names:inp.names}, note:''};
  slots.forEach((s, v) => {
    if (s.bad) { res.bad++; res.fails.push({v, t:s.bad.t, segs:s.bad.diffs.map(i => SEG_NAMES[i]).join(''), got:s.bad.got, want:s.bad.want}); }
    else if (s.rows || DS.seg[v] === ALL_X) res.ok++;
    else { res.miss++; res.missing.push(v); }
  });
  res.status = res.bad || res.miss ? 'fail' : 'pass';
  return res;
}

function regradeAll(){
  if (!isBlank()) GR.allowBlank = false;           // 기준이 채워졌으면 "빈 FND로 채점" 확인은 끝
  GR.items = GR.items.map(it => ({name:it.name, buf:it.buf, ...gradeBuffer(it.name, it.buf)}));
  GR.sig = specSig();
}

/* ════════════════════════════════════════════════════════════════
   2. 파일 모으기 (파일 여러 개 · 폴더 선택 · 폴더 끌어다 놓기)
   ════════════════════════════════════════════════════════════════ */
const GRADE_MAX_FILES = 1000;

// 끌어다 놓은 항목에서 파일을 모은다. 폴더는 안쪽까지 펼치고 "폴더/파일" 경로를 이름으로 쓴다.
// webkitGetAsEntry는 이벤트 핸들러 안에서 바로(await 전에) 불러야 한다
async function filesFromDrop(dt){
  const entries = [...dt.items].map(it => it.webkitGetAsEntry?.()).filter(Boolean);
  const out = [], plain = [...dt.files];
  const walk = async (entry, path) => {
    if (entry.isFile) { const file = await new Promise((ok, no) => entry.file(ok, no)); out.push({file, path:path + file.name}); }
    else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (let batch; (batch = await new Promise((ok, no) => reader.readEntries(ok, no))).length;)
        for (const e of batch) await walk(e, path + entry.name + '/');
    }
  };
  if (entries.length) for (const e of entries) await walk(e, '');
  else plain.forEach(file => out.push({file, path:file.name}));
  return out;
}

async function addToGrade(list){                  // list: [{file, path}]
  const outs = list.filter(x => /\.out$/i.test(x.file.name));
  const skipped = list.length - outs.length;
  if (!outs.length) return toast('.out 파일을 찾지 못했습니다');
  const take = outs.slice(0, GRADE_MAX_FILES);
  if (outs.length > GRADE_MAX_FILES) toast(`.out이 ${outs.length}개라 처음 ${GRADE_MAX_FILES}개만 채점합니다`);
  const known = new Map(GR.items.map(it => [it.name, it]));
  for (let i = 0; i < take.length; i++) {
    const {file, path} = take[i], buf = await file.arrayBuffer();
    known.set(path, {name:path, buf, ...gradeBuffer(path, buf)});
    if (i % 5 === 4) { renderGrade(`채점 중… ${i + 1}/${take.length}`); await new Promise(r => setTimeout(r)); }   // 화면이 멈추지 않게 숨 돌리기
  }
  GR.items = [...known.values()]; GR.sig = specSig();
  renderGrade();
  toast(gradeBlocked() ? `${take.length}개 파일을 올렸습니다. 만든 FND를 채운 뒤 채점됩니다` : `${take.length}개 파일을 채점했습니다${skipped ? ` (.out이 아닌 ${skipped}개는 제외)` : ''}`);
}

/* ════════════════════════════════════════════════════════════════
   3. 화면
   ════════════════════════════════════════════════════════════════ */
const STATUS_LABEL = {pass:'통과', fail:'불일치', error:'오류', wait:'대기'};
const BASIS_LABEL = {vector:'VECTOR', order:'추정 · 파일 순서', infer:'추정 · 값 패턴'};
const POLICY_LABEL = {stable:'안정 상태', all:'모든 행'};
const failText = it => it.fails.map(f => `${hexDigit(f.v)}:${f.segs}`).join('  ');
const missText = it => it.missing.map(hexDigit).join(' ');
const isGuess = it => it.basis && it.basis.kind !== 'vector';
const letters = bits => [...bits].map((b, i) => b === '1' ? SEG_NAMES[i] : b === '0' ? '·' : 'X').join('');

function failDetail(it){                          // 틀린 입력마다 시간 · 기대 · 실제
  const lines = it.fails.map(f => `${hexDigit(f.v)} (t=${f.t})  기대 ${letters(f.want)} / 실제 ${letters(f.got)}`);
  return `<details><summary>${esc(failText(it))}</summary><pre>${esc(lines.join('\n'))}</pre></details>`;
}

function gradeView(){                             // 필터와 정렬을 적용한 목록
  let list = GR.items.map((it, i) => ({...it, i}));
  if (GR.filter === 'guess') list = list.filter(isGuess);
  else if (GR.filter !== 'all') list = list.filter(it => it.status === GR.filter);
  const rank = {fail:0, error:1, wait:1, pass:2};
  list.sort(GR.sort === 'bad'
    ? (a, b) => rank[a.status] - rank[b.status] || (b.bad + b.miss || 0) - (a.bad + a.miss || 0) || byName.compare(a.name, b.name)
    : (a, b) => byName.compare(a.name, b.name));
  return list;
}

function renderGrade(progress = ''){
  const items = GR.items, n = items.length;
  const count = st => items.filter(it => it.status === st).length;
  const guess = items.filter(isGuess).length;
  const dcCells = DS.seg.reduce((s, row) => s + [...row].filter(c => c === 'X').length, 0);

  $('#gDrop').hidden = n > 0;
  $('#gBody').hidden = n === 0;
  $('#gSpec').innerHTML = gradeBlocked()
    ? '<span class="gwarn">만든 FND가 비어 있어 채점을 보류했습니다. 설계 탭에서 먼저 만들어 주세요.</span> ' +
      '<button id="gGoDesign">설계 탭으로</button> <button id="gForce" title="모든 세그먼트가 꺼져 있어야 일치로 봅니다">빈 FND로 그래도 채점</button>'
    : isBlank()
      ? '<span class="gwarn">만든 FND가 비어 있어, 모든 출력이 꺼져 있어야 일치로 봅니다.</span>'
      : `기준: 만든 FND · 돈케어 <b>${dcCells}</b>칸(어떤 값이어도 통과)`;
  if (!n) return;

  const wait = count('wait');
  $('#gSummary').innerHTML = progress ? esc(progress) :
    `<b>${n}</b>개 파일 · <span class="gp pass">통과 ${count('pass')}</span> <span class="gp fail">불일치 ${count('fail')}</span> <span class="gp error">오류 ${count('error')}</span>` +
    (wait ? ` <span class="gp wait">대기 ${wait}</span>` : '') +
    (guess ? ` <span class="gp guess" title="입력 신호를 VECTOR로 알 수 없어 추정했습니다. 표의 '입력 신호'가 맞는지 확인하세요">입력 추정 ${guess}</span>` : '');
  $$('#gChips button').forEach(b => {
    const f = b.dataset.f, c = f === 'all' ? n : f === 'guess' ? guess : count(f);
    b.classList.toggle('on', f === GR.filter); b.setAttribute('aria-pressed', f === GR.filter);
    b.querySelector('i').textContent = c;
    b.hidden = (f === 'wait' || f === 'guess') && !c && f !== GR.filter;
  });
  $('#gSort').value = GR.sort;
  $('#gPolicy').value = GR.policy;

  const rows = gradeView().map(it => {
    const err = it.status === 'error' || it.status === 'wait';
    const detail = err ? esc(it.note) : it.fails.length ? failDetail(it) : '';
    const basis = !it.basis ? '' :
      `<span class="gb ${isGuess(it) ? 'guess' : ''}">${BASIS_LABEL[it.basis.kind]}</span> <span class="gsig">${esc(it.basis.names)}</span>`;
    return `<tr>` +
      `<td class="gname" title="${esc(it.name)}">${esc(it.name)}</td>` +
      `<td><span class="gp ${it.status}">${STATUS_LABEL[it.status]}</span></td>` +
      `<td class="gnum">${err ? '–' : `${it.ok}<small>/16</small>`}</td>` +
      `<td class="gdetail">${detail}</td>` +
      `<td class="gdetail">${err ? '' : esc(missText(it))}</td>` +
      `<td class="gbasis">${basis}</td>` +
      `<td><button class="gopen" data-i="${it.i}" ${it.status === 'error' || it.status === 'wait' ? 'disabled' : ''}>검증 탭에서 열기</button></td></tr>`;
  }).join('');
  $('#gTbl').innerHTML = `<thead><tr><th>파일</th><th>판정</th><th>일치</th><th>불일치 입력:세그먼트</th><th>누락 입력</th><th>입력 신호</th><th></th></tr></thead><tbody>${rows}</tbody>`;
}

/* ─ CSV ─ */
const csvCell = s => /[",\n]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s);
function gradeCsv(){
  const head = ['파일', '판정', '일치', '불일치', '누락', '불일치 입력', '불일치 상세', '누락 입력', '입력 기준', '입력 신호', '채점 방식', '비고'];
  const rows = [...GR.items].sort((a, b) => byName.compare(a.name, b.name)).map(it => [
    it.name, STATUS_LABEL[it.status], it.ok ?? '', it.bad ?? '', it.miss ?? '',
    it.fails ? failText(it) : '',
    it.fails ? it.fails.map(f => `${hexDigit(f.v)}@${f.t} 기대 ${letters(f.want)} 실제 ${letters(f.got)}`).join(' / ') : '',
    it.missing ? missText(it) : '',
    it.basis ? BASIS_LABEL[it.basis.kind] : '', it.basis ? it.basis.names : '',
    it.basis ? POLICY_LABEL[GR.policy] : '', it.note || '']);
  return [head, ...rows].map(r => r.map(csvCell).join(',')).join('\n');
}
function saveGradeCsv(){
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + gradeCsv()], {type:'text/csv;charset=utf-8'}));   // BOM: 엑셀에서 한글이 깨지지 않게
  a.download = 'mysim-grade.csv';
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ════════════════════════════════════════════════════════════════
   4. 이벤트 연결
   ════════════════════════════════════════════════════════════════ */
$('#gPick').onclick = $('#gPick2').onclick = () => $('#gFileIn').click();
$('#gFolder').onclick = $('#gFolder2').onclick = () => $('#gDirIn').click();
$('#gFileIn').onchange = guard(async e => { const fs = [...e.target.files]; e.target.value = ''; await addToGrade(fs.map(file => ({file, path:file.name}))); });
$('#gDirIn').onchange = guard(async e => {       // 폴더 선택: webkitRelativePath가 "폴더/…/파일"
  const fs = [...e.target.files]; e.target.value = '';
  await addToGrade(fs.map(file => ({file, path:file.webkitRelativePath || file.name})));
});
$('#gClear').onclick = () => { GR.items = []; GR.filter = 'all'; GR.allowBlank = false; renderGrade(); };
$('#gChips').onclick = e => { const b = e.target.closest('button[data-f]'); if (b) { GR.filter = b.dataset.f; renderGrade(); } };
$('#gSort').onchange = blurAfter(e => { GR.sort = e.target.value; renderGrade(); });
$('#gPolicy').onchange = blurAfter(e => {
  GR.policy = e.target.value === 'all' ? 'all' : 'stable'; store.set('gpolicy', GR.policy);
  regradeAll(); renderGrade();
});
$('#gSpec').onclick = e => {
  if (e.target.closest('#gGoDesign')) showTab('design', {focus:true});
  else if (e.target.closest('#gForce')) { GR.allowBlank = true; regradeAll(); renderGrade(); }
};
$('#gTbl').onclick = e => { const b = e.target.closest('button.gopen'); if (b && !b.disabled) openGradedInVerify(Number(b.dataset.i)); };
$('#gCopy').onclick = guard(async () => { await copyText(gradeCsv()); toast(`채점 결과를 CSV로 복사했습니다 (${GR.items.length}행)`); });
$('#gSave').onclick = saveGradeCsv;

let gradeDrag = 0;
addEventListener('dragenter', e => { if (!graderEnabled()) return; e.preventDefault(); gradeDrag++; showDropOverlay('놓아서 채점하기 (.out 파일 또는 폴더)'); });
addEventListener('dragleave', () => { if (graderEnabled() && --gradeDrag <= 0) { gradeDrag = 0; $('#drop').hidden = true; } });
addEventListener('dragover', e => { if (graderEnabled()) e.preventDefault(); });
addEventListener('drop', guard(async e => {
  if (!graderEnabled()) return;
  e.preventDefault(); gradeDrag = 0; $('#drop').hidden = true;
  await addToGrade(await filesFromDrop(e.dataTransfer));
}));

renderGrade();
