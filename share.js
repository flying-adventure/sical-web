// 공유 링크 해독과 그리기. 서버 없이 링크의 # 뒤에 담긴 일정을 브라우저에서 푼다.
// 보안 규칙: 링크에서 온 값은 textContent / createElement로만 그린다(HTML 문자열을 끼워 넣는 API는 쓰지 않는다).

// [형식 메모: v1 규칙. Packages/MemocalCore/.../ShareLink.swift의 같은 메모와 함께 바꾼다]
// - 링크: #1.<base64url(raw DEFLATE(UTF-8 JSON))>
// - JSON: {"r":"d|w|m","a":앵커 dayKey,"e":[[dayKey,시작분|null,끝분|null,"제목"],…]}. 모르는 키는 무시한다.
// - 제목은 UTF-16 코드 단위로 최대 400(JS의 title.length). 쓰는 쪽이 NFC로 바꾸고 잘라서 보낸다.
// - 앵커: 하루 = 그 날, 주 = 그 주 일요일, 달 = 그 달 1일. 모든 일정의 dayKey는 범위 안
//   (하루: 앵커 하루, 주: 앵커…앵커+6, 달: 같은 연·월).
// - 일정은 (dayKey, 시간 없는 것 먼저, 시작 시각) 비내림차순. 일정은 500개 이하, 풀린 JSON은 200,000바이트 이하.
// - 분은 null 또는 정수. 시작은 0…1439, 끝은 1…1440(끝은 24:00일 수 있다). 둘 다 있으면 끝 > 시작.
// - 읽는 쪽은 위를 하나라도 어기면 링크 전체를 거부한다(엄격한 읽기). 링크 조각은 20,000자 이하.
// - 버전은 "#<숫자>." 꼴일 때만 알아본다. 모르는 버전은 VersionError, 그 밖의 모양은 모두 DecodeError.

const MAX_HASH = 20000;          // 링크 조각 최대 길이
const MAX_DECODED = 200000;      // 풀린 JSON 최대 크기(바이트)
const MAX_EVENTS = 500;
const MAX_TITLE = 400;           // UTF-16 코드 단위

/** 링크를 읽을 수 없다(형식·압축·값 오류, 크기 상한 초과). */
export class DecodeError extends Error {
  constructor(message, code = 'invalid') { super(message); this.name = 'DecodeError'; this.code = code; }
}
/** 모르는 버전의 링크(앱을 업데이트해야 한다). */
export class VersionError extends DecodeError {
  constructor() { super('unsupported version', 'version'); this.name = 'VersionError'; }
}
/** 이 브라우저에 DecompressionStream이 없다. */
export class UnsupportedBrowserError extends Error {
  constructor() { super('DecompressionStream unavailable'); this.name = 'UnsupportedBrowserError'; }
}
const fail = (code) => new DecodeError(code, code);

// ---------- 해독 ----------

/** "#1.<base64url>" → { range, anchor, events:[{dayKey,start,end,title}] }. 어긋나면 예외. */
export async function decode(hash) {
  if (typeof hash !== 'string') throw fail('format');
  if (hash.length > MAX_HASH) throw fail('too-long');
  const m = /^#?(\d+)\.(.*)$/s.exec(hash);
  if (!m) throw fail('format');
  if (m[1] !== '1') throw new VersionError();
  const body = m[2];
  if (!/^[A-Za-z0-9_-]+$/.test(body)) throw fail('format');
  if (typeof DecompressionStream === 'undefined') throw new UnsupportedBrowserError();

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(await inflateRaw(fromBase64Url(body)));
  } catch (e) {
    throw e instanceof DecodeError ? e : fail('inflate');
  }
  let obj;
  try { obj = JSON.parse(text); } catch { throw fail('json'); }
  return validate(obj);
}

function fromBase64Url(s) {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b + '='.repeat((4 - (b.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// raw DEFLATE를 풀되 200kB를 넘으면 읽기를 멈추고 예외를 던진다(압축 폭탄 방어).
async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_DECODED) {
        await reader.cancel();
        throw new DecodeError('too big', 'too-big');
      }
      chunks.push(value);
    }
  } catch (e) {
    throw e instanceof DecodeError ? e : fail('inflate');
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

function isDayKey(n) {
  if (!Number.isInteger(n)) return false;
  const y = Math.floor(n / 10000), mo = Math.floor(n / 100) % 100, d = n % 100;
  if (y < 1000 || y > 9999) return false;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}
const isStart = (v) => v === null || (Number.isInteger(v) && v >= 0 && v <= 1439);
const isEnd = (v) => v === null || (Number.isInteger(v) && v >= 1 && v <= 1440);   // 24:00까지

function validate(o) {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) throw fail('shape');
  if (o.r !== 'd' && o.r !== 'w' && o.r !== 'm') throw fail('range');
  if (!isDayKey(o.a)) throw fail('anchor');
  if (o.r === 'w' && toDate(o.a).getUTCDay() !== 0) throw fail('anchor');   // 주 앵커는 일요일
  if (o.r === 'm' && o.a % 100 !== 1) throw fail('anchor');                 // 달 앵커는 1일
  if (!Array.isArray(o.e) || o.e.length > MAX_EVENTS) throw fail('events');
  const weekEnd = o.r === 'w' ? addDays(o.a, 6) : 0;
  let prev = null;
  const events = o.e.map((row) => {
    if (!Array.isArray(row) || row.length !== 4) throw fail('event');
    const [dayKey, start, end, title] = row;
    if (!isDayKey(dayKey) || !isStart(start) || !isEnd(end)) throw fail('event');
    if (start !== null && end !== null && end <= start) throw fail('event');
    if (typeof title !== 'string' || title.length > MAX_TITLE) throw fail('event');
    // 일정은 선언한 범위 안에 있어야 한다
    if (o.r === 'd' && dayKey !== o.a) throw fail('range-event');
    if (o.r === 'w' && (dayKey < o.a || dayKey > weekEnd)) throw fail('range-event');
    if (o.r === 'm' && Math.floor(dayKey / 100) !== Math.floor(o.a / 100)) throw fail('range-event');
    // (dayKey, 시간 없는 것 먼저, 시작) 비내림차순
    const key = [dayKey, start === null ? -1 : start];
    if (prev && (key[0] < prev[0] || (key[0] === prev[0] && key[1] < prev[1]))) throw fail('order');
    prev = key;
    return { dayKey, start, end, title };
  });
  return { range: o.r, anchor: o.a, events };
}

// ---------- 문구 ----------

const STRINGS = {
  ko: {
    footer: '이 화면은 링크를 만든 시점의 일정입니다',
    empty: '이 기간에 일정이 없습니다',
    noEvents: '일정 없음',
    error: '링크를 읽을 수 없습니다',
    unsupported: '이 브라우저에서는 열 수 없습니다. 브라우저를 업데이트하거나 다른 브라우저로 열어 주세요.',
    update: '이 링크는 더 새로운 버전의 앱으로 만들었습니다. 앱을 최신으로 업데이트한 뒤 다시 공유해 달라고 부탁해 보세요.',
    intro: '시캘은 한 줄로 적는 흑백 일정 앱입니다.',
  },
  en: {
    footer: 'This page shows the schedule as of when the link was made.',
    empty: 'No events in this period',
    noEvents: 'No events',
    error: 'This link could not be read',
    unsupported: "This browser can't open the link. Update it or try another browser.",
    update: 'This link was made with a newer version of the app. Ask the sender to update the app and share again.',
    intro: 'Plaincal is a one-line, black-and-white calendar app.',
  },
};

export function pickLang(nav) {
  const l = (nav && nav.language) || 'ko';
  return String(l).toLowerCase().startsWith('ko') ? 'ko' : 'en';
}
const strings = (lang) => STRINGS[lang] || STRINGS.ko;

// ---------- 날짜·시간 ----------

function makeFormats(locale) {
  const make = (opts) => {
    try { return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', ...opts }); }
    catch { return new Intl.DateTimeFormat('ko', { timeZone: 'UTC', ...opts }); }
  };
  return {
    day: make({ month: 'long', day: 'numeric', weekday: 'short' }),
    month: make({ year: 'numeric', month: 'long' }),
    weekday: make({ weekday: 'short' }),
    time: make({ hour: 'numeric', minute: '2-digit' }),
    range: make({ month: 'long', day: 'numeric' }),
  };
}

const parts = (key) => ({ y: Math.floor(key / 10000), m: Math.floor(key / 100) % 100, d: key % 100 });
const toDate = (key) => { const p = parts(key); return new Date(Date.UTC(p.y, p.m - 1, p.d, 12)); };
const toKey = (date) => date.getUTCFullYear() * 10000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
const addDays = (key, n) => { const d = toDate(key); d.setUTCDate(d.getUTCDate() + n); return toKey(d); };
const timeDate = (min) => new Date(Date.UTC(2000, 0, 1, Math.floor(min / 60), min % 60));

function timeText(fmt, e) {
  if (e.start === null) return '';
  if (e.end === null) return fmt.time.format(timeDate(e.start));
  // 끝이 24:00이면 다음 날 0시라 formatRange가 날짜를 끼워 넣는다. 두 시각을 따로 적는다(앱 미리보기와 같은 " – ").
  if (e.end === 1440) return fmt.time.format(timeDate(e.start)) + ' – ' + fmt.time.format(timeDate(0));
  return fmt.time.formatRange(timeDate(e.start), timeDate(e.end));
}

// ---------- 그리기 ----------

function el(doc, tag, className, text) {
  const n = doc.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

function eventList(doc, fmt, events) {
  const ul = el(doc, 'ul', 'events');
  for (const e of events) {
    const li = el(doc, 'li', 'event');
    li.appendChild(el(doc, 'span', 'time', timeText(fmt, e)));
    li.appendChild(el(doc, 'span', 'title', e.title));
    ul.appendChild(li);
  }
  return ul;
}

function groupByDay(events) {
  const map = new Map();
  for (const e of events) {
    if (!map.has(e.dayKey)) map.set(e.dayKey, []);
    map.get(e.dayKey).push(e);
  }
  return map;
}

function daySection(doc, fmt, s, key, events) {
  const sec = el(doc, 'section', 'day-block');
  sec.appendChild(el(doc, 'h2', 'day-head', fmt.day.format(toDate(key))));
  sec.appendChild(events.length ? eventList(doc, fmt, events) : el(doc, 'p', 'none', s.noEvents));
  return sec;
}

function monthGrid(doc, fmt, anchor, byDay) {
  const { y, m } = parts(anchor);
  const lead = new Date(Date.UTC(y, m - 1, 1, 12)).getUTCDay();   // 일요일 = 0
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const grid = el(doc, 'div', 'grid');
  grid.setAttribute('aria-hidden', 'true');   // 아래 목록이 같은 내용을 읽어 준다
  // 요일 머리글: 2026-11-01이 일요일이라 그 주 7일을 쓰면 일 월 화 … 순서가 된다
  for (let i = 0; i < 7; i++) {
    grid.appendChild(el(doc, 'span', 'wd', fmt.weekday.format(new Date(Date.UTC(2026, 10, 1 + i, 12)))));
  }
  const total = Math.ceil((lead + count) / 7) * 7;
  for (let i = 0; i < total; i++) {
    const day = i - lead + 1;
    if (day < 1 || day > count) { grid.appendChild(el(doc, 'span', 'cell blank')); continue; }
    const cell = el(doc, 'span', 'cell');
    cell.appendChild(el(doc, 'span', 'num', String(day)));
    const n = (byDay.get(y * 10000 + m * 100 + day) || []).length;
    if (n) {
      const dots = el(doc, 'span', 'dots');
      for (let k = 0; k < Math.min(n, 3); k++) dots.appendChild(el(doc, 'span', 'dot'));
      cell.appendChild(dots);
    }
    grid.appendChild(cell);
  }
  return grid;
}

/** 해독한 값을 doc의 #app에 그린다. lang은 'ko' | 'en'. */
export function render(doc, data, lang = pickLang(globalThis.navigator)) {
  const s = strings(lang);
  const locale = (globalThis.navigator && globalThis.navigator.language) || 'ko';
  const fmt = makeFormats(locale);
  const root = doc.getElementById('app');
  root.textContent = '';
  const byDay = groupByDay(data.events);

  if (data.range === 'd') {
    root.appendChild(el(doc, 'h1', 'head', fmt.day.format(toDate(data.anchor))));
    root.appendChild(data.events.length ? eventList(doc, fmt, data.events) : el(doc, 'p', 'none', s.empty));
  } else if (data.range === 'w') {
    const last = addDays(data.anchor, 6);
    root.appendChild(el(doc, 'h1', 'head', fmt.range.formatRange(toDate(data.anchor), toDate(last))));
    for (let i = 0; i < 7; i++) {
      const key = addDays(data.anchor, i);
      root.appendChild(daySection(doc, fmt, s, key, byDay.get(key) || []));
    }
  } else {
    root.appendChild(el(doc, 'h1', 'head', fmt.month.format(toDate(data.anchor))));
    root.appendChild(monthGrid(doc, fmt, data.anchor, byDay));
    if (!data.events.length) root.appendChild(el(doc, 'p', 'none', s.empty));
    for (const key of [...byDay.keys()].sort((a, b) => a - b)) {
      root.appendChild(daySection(doc, fmt, s, key, byDay.get(key)));
    }
  }
  if (doc.documentElement) doc.documentElement.lang = lang;
}

// ---------- 시작 (브라우저에서만) ----------

// 한 번에 한 영역만 보인다. 일정 화면에는 맨 아래 안내 줄도 함께 보인다.
function show(doc, id) {
  for (const n of ['intro', 'error', 'update', 'unsupported', 'app', 'footer']) {
    const node = doc.getElementById(n);
    if (node) node.hidden = n !== id && !(id === 'app' && n === 'footer');
  }
}

async function boot(doc) {
  const lang = pickLang(globalThis.navigator);
  const s = strings(lang);
  doc.documentElement.lang = lang;
  doc.getElementById('footer').textContent = s.footer;
  doc.getElementById('intro-text').textContent = s.intro;
  doc.getElementById('error').textContent = s.error;
  doc.getElementById('update').textContent = s.update;
  doc.getElementById('unsupported').textContent = s.unsupported;
  const hash = globalThis.location.hash;
  if (!hash || hash === '#') return show(doc, 'intro');
  try {
    render(doc, await decode(hash), lang);
    show(doc, 'app');
  } catch (e) {
    show(doc, e instanceof VersionError ? 'update' : e instanceof UnsupportedBrowserError ? 'unsupported' : 'error');
  }
}

if (typeof document !== 'undefined' && document.getElementById && document.getElementById('app')) {
  boot(document);
  globalThis.addEventListener('hashchange', () => boot(document));
}
