'use strict';
/* FND Studio: 탭(설계 · 검증 · 채점) 전환과 탭 사이의 연결.
   설계(designer.js)에서 만든 FND(DS)를 검증(viewer.js)과 채점(grader.js)이 그대로 기준으로 쓴다. */

const TAB = {cur:'design'};
const TABS = ['design', 'verify', 'grade'];

// 키보드·드롭은 지금 보이는 탭만 처리한다
viewerEnabled = () => TAB.cur === 'verify';
designEnabled = () => TAB.cur === 'design';
graderEnabled = () => TAB.cur === 'grade';

function showTab(name, {focus = false} = {}){
  if (!TABS.includes(name)) name = 'design';
  TAB.cur = name;
  $('#panelDesign').hidden = name !== 'design';
  $('#panelVerify').hidden = name !== 'verify';
  $('#panelGrade').hidden  = name !== 'grade';
  $$('.tab').forEach(b => {
    const on = b.dataset.tab === name;
    b.classList.toggle('on', on); b.setAttribute('aria-selected', on); b.tabIndex = on ? 0 : -1;
    if (on && focus) b.focus();
  });
  const hash = '#' + name;
  if (location.hash !== hash) history.replaceState(null, '', location.href.split('#')[0] + hash);

  // 다른 탭에서 바뀐 것을 반영한다
  if (name === 'verify' && S.D) {
    if (S.mode === 'custom') reverify();          // 설계가 바뀌었을 수 있으니 다시 판정
    refreshSelection(true);                        // 숨겨져 있는 동안 못 그린 파형을 그린다
  }
  if (name === 'grade') {
    if (GR.items.length && GR.sig !== specSig()) { regradeAll(); toast('만든 FND가 바뀌어 다시 채점했습니다'); }
    renderGrade();
  }
}

/* ─ 검증 기준 바꾸기 (선택 상자와 상태, 저장을 함께) ─ */
function setVerifyMode(mode){
  S.mode = mode; $('#mode').value = mode; store.set('mode', mode);
}

/* ─ 출력 극성 (검증·채점 탭의 선택 상자와 상태, 저장을 함께) ─ */
function setPolarity(low){
  POL.low = !!low; store.set('polarity', POL.low ? 'low' : 'high');
  $('#polarity').value = $('#gPolarity').value = POL.low ? 'low' : 'high';
  if (S.D) reverify();
  if (GR.items.length) regradeAll();
  renderGrade();
}
$('#polarity').onchange = $('#gPolarity').onchange = blurAfter(e => setPolarity(e.target.value === 'low'));
$('#polarity').value = $('#gPolarity').value = POL.low ? 'low' : 'high';

/* ─ 설계 → 검증: 지금 만든 FND 자체를 검증 탭에서 본다 (파형·표·판정) ─ */
function openDesignInVerify(){
  setVerifyMode('custom');
  loadBuffer(new TextEncoder().encode(designOut()).buffer, '설계 중인 FND', {trimEnd:false});
  showTab('verify');
}

/* ─ 채점 → 검증: 채점한 학생 파일 하나를 검증 탭에서 자세히 본다 ─ */
function openGradedInVerify(i){
  const it = GR.items[i];
  if (!it) return;
  setVerifyMode('custom');
  if (loadBuffer(it.buf, it.name)) showTab('verify');
}

/* ─ 이벤트 · 시작 ─ */
$$('.tab').forEach(b => { b.onclick = () => showTab(b.dataset.tab); });
$('.tabs').onkeydown = e => {                      // 탭 목록에서 ←/→로 이동
  const k = {ArrowLeft:-1, ArrowRight:1}[e.key];
  if (!k) return;
  e.preventDefault(); showTab(TABS[(TABS.indexOf(TAB.cur) + k + TABS.length) % TABS.length], {focus:true});
};
$('#dOpen').onclick = openDesignInVerify;
addEventListener('hashchange', () => showTab(location.hash.slice(1)));

// 검증 탭의 기본 검증 기준은 "만든 FND" (저장된 선택이 있으면 그것)
if (!store.get('mode')) setVerifyMode('custom');
showTab(location.hash.slice(1) || 'design');

// 주소에 ?test가 있으면 자동 테스트를 실행한다 (tests.html이 이 주소로 보내 준다)
if (/[?&]test\b/.test(location.search)) {
  const s = document.createElement('script');
  s.src = 'js/tests.js?t=' + Date.now();
  document.body.append(s);
}
