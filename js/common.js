'use strict';
/* FND Studio 공통 코드: 설계 · 검증 · 채점 탭이 함께 쓴다.
   · 유틸  · 7-세그먼트 표준 모양과 도형  · 만든 FND(DS)의 저장/불러오기/내보내기  · 테마 */

/* ════════════════════════════════════════════════════════════════
   0. 유틸
   ════════════════════════════════════════════════════════════════ */
const $  = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const bstr = (v, k) => v.toString(2).padStart(k, '0');
const hexStr = (v, bits) => '0x' + v.toString(16).toUpperCase().padStart(Math.ceil(bits / 4), '0');
const range = n => Array.from({length:n}, (_, i) => i);

/* 설정 기억 (막힌 환경이면 조용히 무시).
   같은 도메인의 다른 MySim 사이트(뷰어)와 섞이지 않도록 이 사이트 전용 접두어를 쓰고,
   이전에 만든 모양·테마만 처음 한 번 이어받는다 */
const store = {
  prefix:'fnd-studio-',
  inherit:['design', 'kmode', 'theme'],
  get(k){
    try {
      return localStorage.getItem(this.prefix + k) ?? (this.inherit.includes(k) ? localStorage.getItem('mysim-' + k) : null);
    } catch { return null; }
  },
  set(k, v){ try { localStorage.setItem(this.prefix + k, v); } catch { /* 저장소를 못 쓰는 환경 */ } },
};

// 파일을 끌어다 놓을 때 화면 전체에 띄우는 안내 (검증·채점 탭이 문구만 바꿔 같이 쓴다)
function showDropOverlay(text){ const el = $('#drop'); el.textContent = text; el.hidden = false; }

// 마우스로 컨트롤을 조작한 뒤에는 포커스를 놓아 방향키가 단계 이동에 쓰이게 한다.
// 키보드로 조작한 경우에는 포커스를 그대로 둔다 (키보드 사용자가 자리를 잃지 않도록)
let lastByPointer = false;
addEventListener('pointerdown', () => { lastByPointer = true; }, true);
addEventListener('keydown', () => { lastByPointer = false; }, true);
const blurAfter = fn => e => { fn(e); if (lastByPointer) e.target.blur(); };
// 비동기 핸들러의 오류를 알림으로 보여준다
const guard = fn => async (...args) => { try { return await fn(...args); } catch (e) { toast(e.message || String(e)); } };

let toastTimer;
function toast(msg){
  $$('.toast').forEach(e => e.remove());
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg; document.body.appendChild(t);
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.remove(), 3500);
}

function markOnly(selector, els){
  $$(selector + '.cur').forEach(e => e.classList.remove('cur'));
  els.forEach(e => e.classList.add('cur'));
}

/* ════════════════════════════════════════════════════════════════
   1. 7-세그먼트: 표준 패턴과 도형
   ════════════════════════════════════════════════════════════════ */
// a b c d e f g 순서. 관용적으로 모양이 갈리는 글자는 여러 모양을 모두 정답으로 본다
//   1: 오른쪽(b,c) / 왼쪽(e,f)   6: 위 획 유무   7: 왼쪽 위(f) 획 유무   9: 아래 획 유무
//   A: 대문자 / 소문자 a         C: 대문자 C / 소문자 c
const PAT = {
  0:['1111110'], 1:['0110000','0000110'], 2:['1101101'], 3:['1111001'], 4:['0110011'],
  5:['1011011'], 6:['1011111','0011111'], 7:['1110000','1110010'], 8:['1111111'],
  9:['1111011','1110011'], 10:['1110111','1111101'], 11:['0011111'], 12:['1001110','0001101'],
  13:['0111101'], 14:['1001111'], 15:['1000111'],
};
const DIGIT = ['0','1','2','3','4','5','6','7','8','9','A','b','C','d','E','F'];
const SEG_NAMES = 'ABCDEFG';

const SEG_POLY = [
  '10,6 14,2 46,2 50,6 46,10 14,10',     // a
  '52,8 56,12 56,44 52,48 48,44 48,12',  // b
  '52,52 56,56 56,88 52,92 48,88 48,56', // c
  '10,94 14,90 46,90 50,94 46,98 14,98', // d
  '8,52 12,56 12,88 8,92 4,88 4,56',     // e
  '8,8 12,12 12,44 8,48 4,44 4,12',      // f
  '10,50 14,46 46,46 50,50 46,54 14,54', // g
];
const SEG_LABEL_POS = [[30,6],[52,28],[52,72],[30,94],[8,72],[8,28],[30,50]];

/* ════════════════════════════════════════════════════════════════
   2. 디자이너에서 만든 FND (두 페이지가 localStorage로 공유)
      DS.seg[v] = 입력값 v일 때의 A~G 7자리 '0'(꺼짐) / '1'(켜짐) / 'X'(돈케어) 문자열
   ════════════════════════════════════════════════════════════════ */
const IN_NAMES = ['W', 'X', 'Y', 'Z'];          // W가 최상위 비트
const BLANK = '0000000', ALL_X = 'XXXXXXX';
const DS = {seg:Array(16).fill(BLANK)};
const hexDigit = v => v.toString(16).toUpperCase();
const isBlank = () => DS.seg.every(s => s === BLANK);

function loadDesign(){
  try {
    const a = JSON.parse(store.get('design'));
    if (Array.isArray(a) && a.length === 16 && a.every(s => /^[01X]{7}$/.test(s))) DS.seg = a;
  } catch { /* 저장된 값이 없거나 깨졌으면 빈 FND로 시작 */ }
}
const saveDesign = () => store.set('design', JSON.stringify(DS.seg));

// 뷰어가 그대로 읽는 MySim 결과 형식 (출력 A~G 다음에 입력 W X Y Z, 10 단위 시간)
function designOut(){
  const names = [...SEG_NAMES, ...IN_NAMES];
  return ['[MySim Result V3.5]', `MAX_TIME ${15 * 10};`, `VECTOR IN ${IN_NAMES.join(' ')};`,
    `WATCH ${names.join(' ')} IN;`, `TABLE_ORDER ${names.join(' ')};`, 'START',
    ...DS.seg.map((s, v) => `${v * 10} ${s}${bstr(v, 4)}`), 'END', ''].join('\n');
}

/* ════════════════════════════════════════════════════════════════
   3. 테마: 저장된 값 → 없으면 시스템 설정. 바뀌면 'themechange' 이벤트로 알린다 (뷰어는 파형을 다시 그림)
   ════════════════════════════════════════════════════════════════ */
function applyTheme(t){
  document.documentElement.dataset.theme = t;
  document.dispatchEvent(new CustomEvent('themechange'));
}
applyTheme(store.get('theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
$('#btnTheme').onclick = () => {
  const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(t); store.set('theme', t);
};
