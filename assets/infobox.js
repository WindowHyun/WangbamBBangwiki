/*
 * 프로필 상자(인포박스) 저장 형식 변환.
 *
 *   :::infobox
 *   title: 홍길동
 *   image: https://example.com/photo.jpg
 *   caption: 2024년 사진
 *   # 기본 정보
 *   본명 | 홍길동
 *   소속 | [[왕밤빵 팀]]
 *   :::
 *
 * title / image / caption 은 맨 위에만, 그 아래는 한 줄에 한 항목이다.
 * "# 제목" 은 구분 제목 줄, "항목 | 내용" 은 일반 항목이다. 내용에는 위키 문법을 쓸 수 있다.
 */
(() => {
  'use strict';

  const KEY = /^(title|image|caption)\s*:\s*(.*)$/i;
  const clean = (s) => String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').trim();

  function parse(src) {
    const data = { title: '', image: '', caption: '', rows: [] };
    for (const raw of String(src).replace(/\r\n?/g, '\n').split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const key = KEY.exec(line);
      if (key && data.rows.length === 0) {
        data[key[1].toLowerCase()] = key[2].trim();
        continue;
      }
      if (line.startsWith('#')) {
        data.rows.push({ type: 'head', label: line.replace(/^#+\s*/, ''), value: '' });
        continue;
      }
      const i = line.indexOf('|');
      if (i > 0) data.rows.push({ type: 'row', label: line.slice(0, i).trim(), value: line.slice(i + 1).trim() });
    }
    return data;
  }

  function serialize(data) {
    const out = [];
    if (clean(data.title)) out.push(`title: ${clean(data.title)}`);
    if (clean(data.image)) out.push(`image: ${clean(data.image)}`);
    if (clean(data.caption)) out.push(`caption: ${clean(data.caption)}`);
    for (const r of data.rows || []) {
      const label = clean(r.label).replace(/\|/g, '/').replace(/^#+\s*/, '');
      if (r.type === 'head') {
        if (label) out.push(`# ${label}`);
      } else {
        const value = clean(r.value);
        if (label || value) out.push(`${label || '-'} | ${value}`);
      }
    }
    return out.join('\n');
  }

  // 새 상자를 만들 때 고를 수 있는 양식
  const PRESETS = {
    person: { name: '인물', rows: ['# 기본 정보', '본명', '출생', '직업', '소속'] },
    work: { name: '작품', rows: ['# 작품 정보', '장르', '제작', '발표', '플랫폼'] },
    group: { name: '단체', rows: ['# 단체 정보', '설립', '구성원', '활동'] },
    blank: { name: '빈 상자', rows: ['항목'] },
  };
  const presetRows = (key) =>
    (PRESETS[key] || PRESETS.person).rows.map((l) => (l.startsWith('#') ? { type: 'head', label: l.replace(/^#\s*/, ''), value: '' } : { type: 'row', label: l, value: '' }));

  const api = { parse, serialize, PRESETS, presetRows };
  if (typeof window !== 'undefined') window.WikiInfobox = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
