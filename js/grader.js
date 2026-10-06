'use strict';
/* FND Studio · 채점 탭: 여러 학생의 .out 파일(또는 폴더)을 한 번에 올려 "만든 FND"와 비교하고 결과를 표로 보여준다.
   파일은 브라우저 안에서만 읽는다(서버로 보내지 않는다).
   판정 로직(입력 추정 · 만든 FND와 비교)은 viewer.js, 만든 FND는 common.js의 DS, 내보내기 도구는 designer.js를 쓴다 */

/* ════════════════════════════════════════════════════════════════
   1. 채점
      입력값(0~15) 하나당: 그 입력이 나온 모든 행이 만든 FND와 맞으면 일치, 하나라도 다르면 불일치,
      한 번도 안 나왔으면 누락(전부 돈케어인 입력은 안 나와도 일치로 본다)
   ════════════════════════════════════════════════════════════════ */
const GR = {
  items:[],               // {name, buf, status:'pass'|'fail'|'error', ok, bad, miss, fails[], missing[], note}
  filter:'all', sort:'name',
  sig:'',                 // 채점할 때의 만든 FND (바뀌면 다시 채점)
};
let graderEnabled = () => true;                  // 드롭에 반응할지 (studio.js가 채점 탭일 때만 true가 되게 바꾼다)

const specSig = () => DS.seg.join('');
const byName = new Intl.Collator('ko', {numeric:true, sensitivity:'base'});

function gradeBuffer(name, buf){
  let D;
  try { D = parse(decodeBuf(buf)); }
  catch (e) { return {status:'error', note:e.message}; }
  if (!D.seg) return {status:'error', note:'A–G 신호가 없습니다'};

  const inputs = inputsFor(D, null);              // VECTOR가 없으면 추정한 입력 신호로 입력값을 계산
  const slots = range(16).map(() => ({rows:0, bad:null}));
  let used = 0;
  for (const r of D.rows) {
    const v = inputValueOf(r, inputs);
    if (v == null || v > 15) continue;
    used++;
    const e = compareCustom(D, r, v), s = slots[v];
    s.rows++;
    if (e.st === 'bad' && !s.bad) s.bad = e;      // 같은 입력이 여러 번 나오면 처음 틀린 것을 기록
  }
  if (!used) return {status:'error', note:'입력값을 알 수 없습니다 (VECTOR 없음, 입력 추정 실패)'};

  const res = {ok:0, bad:0, miss:0, fails:[], missing:[], note:''};
  slots.forEach((s, v) => {
    if (s.bad) { res.bad++; res.fails.push({v, segs:s.bad.diffs.map(i => SEG_NAMES[i]).join(''), got:s.bad.got, want:s.bad.want}); }
    else if (s.rows || DS.seg[v] === ALL_X) res.ok++;
    else { res.miss++; res.missing.push(v); }
  });
  res.status = res.bad || res.miss ? 'fail' : 'pass';
  return res;
}

function regradeAll(){
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
  toast(`${take.length}개 파일을 채점했습니다${skipped ? ` (.out이 아닌 ${skipped}개는 제외)` : ''}`);
}

/* ════════════════════════════════════════════════════════════════
   3. 화면
   ════════════════════════════════════════════════════════════════ */
const STATUS_LABEL = {pass:'통과', fail:'불일치', error:'오류'};
const failText = it => it.fails.map(f => `${hexDigit(f.v)}:${f.segs}`).join('  ');
const missText = it => it.missing.map(hexDigit).join(' ');

function gradeView(){                             // 필터와 정렬을 적용한 목록
  let list = GR.items.map((it, i) => ({...it, i}));
  if (GR.filter !== 'all') list = list.filter(it => it.status === GR.filter);
  const rank = {fail:0, error:1, pass:2};
  list.sort(GR.sort === 'bad'
    ? (a, b) => rank[a.status] - rank[b.status] || (b.bad + b.miss || 0) - (a.bad + a.miss || 0) || byName.compare(a.name, b.name)
    : (a, b) => byName.compare(a.name, b.name));
  return list;
}

function renderGrade(progress = ''){
  const items = GR.items, n = items.length;
  const count = st => items.filter(it => it.status === st).length;
  const dcCells = DS.seg.reduce((s, row) => s + [...row].filter(c => c === 'X').length, 0);

  $('#gDrop').hidden = n > 0;
  $('#gBody').hidden = n === 0;
  $('#gSpec').innerHTML = isBlank()
    ? '<span class="gwarn">만든 FND가 비어 있어, 모든 출력이 꺼져 있어야 일치로 봅니다. 설계 탭에서 먼저 만들어 주세요.</span>'
    : `기준: 만든 FND · 돈케어 <b>${dcCells}</b>칸(어떤 값이어도 통과)`;
  if (!n) return;

  $('#gSummary').innerHTML = progress ? esc(progress) :
    `<b>${n}</b>개 파일 · <span class="gp pass">통과 ${count('pass')}</span> <span class="gp fail">불일치 ${count('fail')}</span> <span class="gp error">오류 ${count('error')}</span>`;
  $$('#gChips button').forEach(b => {
    const f = b.dataset.f, c = f === 'all' ? n : count(f);
    b.classList.toggle('on', f === GR.filter); b.setAttribute('aria-pressed', f === GR.filter);
    b.querySelector('i').textContent = c;
  });
  $('#gSort').value = GR.sort;

  const rows = gradeView().map(it => {
    const detail = it.status === 'error' ? esc(it.note) : esc(failText(it));
    const tip = it.status === 'fail' ? it.fails.map(f => `${hexDigit(f.v)}: 기대 ${f.want} / 실제 ${f.got}`).join('\n') : '';
    return `<tr>` +
      `<td class="gname" title="${esc(it.name)}">${esc(it.name)}</td>` +
      `<td><span class="gp ${it.status}">${STATUS_LABEL[it.status]}</span></td>` +
      `<td class="gnum">${it.status === 'error' ? '–' : `${it.ok}<small>/16</small>`}</td>` +
      `<td class="gdetail" title="${esc(tip)}">${detail}</td>` +
      `<td class="gdetail">${it.status === 'error' ? '' : esc(missText(it))}</td>` +
      `<td><button class="gopen" data-i="${it.i}" ${it.status === 'error' ? 'disabled' : ''}>검증 탭에서 열기</button></td></tr>`;
  }).join('');
  $('#gTbl').innerHTML = `<thead><tr><th>파일</th><th>판정</th><th>일치</th><th>불일치 입력:세그먼트</th><th>누락 입력</th><th></th></tr></thead><tbody>${rows}</tbody>`;
}

/* ─ CSV ─ */
const csvCell = s => /[",\n]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s);
function gradeCsv(){
  const head = ['파일', '판정', '일치', '불일치', '누락', '불일치 입력', '누락 입력', '비고'];
  const rows = [...GR.items].sort((a, b) => byName.compare(a.name, b.name)).map(it => [
    it.name, STATUS_LABEL[it.status], it.ok ?? '', it.bad ?? '', it.miss ?? '',
    it.fails ? failText(it) : '', it.missing ? missText(it) : '', it.note || '']);
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
$('#gClear').onclick = () => { GR.items = []; GR.filter = 'all'; renderGrade(); };
$('#gChips').onclick = e => { const b = e.target.closest('button[data-f]'); if (b) { GR.filter = b.dataset.f; renderGrade(); } };
$('#gSort').onchange = blurAfter(e => { GR.sort = e.target.value; renderGrade(); });
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
