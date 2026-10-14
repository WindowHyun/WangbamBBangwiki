(() => {
  'use strict';

  const C = Object.assign(
    { name: '위키', home: '대문', repo: '', branch: 'main', pagesDir: 'pages' },
    window.WIKI_CONFIG
  );

  const $ = (sel, root = document) => root.querySelector(sel);
  const enc = encodeURIComponent;
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeDecode = (s) => {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  };
  const docHref = (title, section) => `#/w/${enc(title)}` + (section ? `?s=${enc(section)}` : '');
  const fmtDate = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
  };
  const fmtDay = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
  };

  const app = $('#app');
  let INDEX = { pages: [] };
  const BY_TITLE = new Map();
  const rawCache = new Map();

  /* ---------- markdown 확장 ([[링크]], [* 각주]) ---------- */

  let footnotes = [];

  function renderWikiLink(target) {
    const sep = target.indexOf('|');
    const dest = (sep >= 0 ? target.slice(0, sep) : target).trim();
    const labelRaw = sep >= 0 ? target.slice(sep + 1).trim() : '';
    if (/^https?:\/\//i.test(dest)) {
      const label = labelRaw || dest;
      return `<a class="external" href="${esc(dest)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
    }
    const hash = dest.indexOf('#');
    const title = (hash >= 0 ? dest.slice(0, hash) : dest).trim();
    const section = hash >= 0 ? dest.slice(hash + 1).trim() : '';
    if (/^분류:/.test(title)) {
      const cat = title.replace(/^분류:\s*/, '');
      return `<a href="#/category/${enc(cat)}">${esc(labelRaw || title)}</a>`;
    }
    if (!title) {
      return `<a href="#" data-scroll-heading="${esc(section)}">${esc(labelRaw || section)}</a>`;
    }
    const label = labelRaw || (section ? `${title}#${section}` : title);
    return `<a class="wikilink" href="${docHref(title, section)}" data-title="${esc(title)}">${esc(label)}</a>`;
  }

  function findFootnoteEnd(src) {
    let depth = 0;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (ch === '\n' && src[i + 1] === '\n') return -1;
      if (ch === '[') depth++;
      else if (ch === ']' && --depth === 0) return i;
    }
    return -1;
  }

  marked.use({
    gfm: true,
    breaks: true,
    extensions: [
      {
        name: 'wikilink',
        level: 'inline',
        start: (src) => src.indexOf('[['),
        tokenizer(src) {
          const m = /^\[\[([^\[\]\n]+?)\]\]/.exec(src);
          if (m) return { type: 'wikilink', raw: m[0], target: m[1] };
        },
        renderer: (token) => renderWikiLink(token.target),
      },
      {
        name: 'footnote',
        level: 'inline',
        start: (src) => src.indexOf('[*'),
        tokenizer(src) {
          if (!src.startsWith('[*')) return;
          const end = findFootnoteEnd(src);
          if (end < 0) return;
          const inner = src.slice(2, end).trim();
          return { type: 'footnote', raw: src.slice(0, end + 1), text: inner, tokens: this.lexer.inlineTokens(inner) };
        },
        renderer(token) {
          const n = footnotes.length + 1;
          footnotes.push(this.parser.parseInline(token.tokens));
          return `<sup class="fn"><a href="#" id="fnref-${n}" data-fn="${n}" title="${esc(token.text)}">[${n}]</a></sup>`;
        },
      },
    ],
  });

  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' && node.getAttribute('target') === '_blank') {
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });

  function parseDoc(raw) {
    raw = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    const meta = {};
    const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
    if (m) {
      for (const line of m[1].split('\n')) {
        const i = line.indexOf(':');
        if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      raw = raw.slice(m[0].length);
    }
    meta.categories = (meta.categories || '').split(',').map((s) => s.trim()).filter(Boolean);
    return { meta, body: raw };
  }

  function renderMarkdown(body) {
    footnotes = [];
    const html = marked.parse(body);
    return { html: DOMPurify.sanitize(html, { ADD_ATTR: ['target'] }), footnotes: footnotes.slice() };
  }

  /* ---------- 데이터 로딩 ---------- */

  async function loadIndex() {
    const res = await fetch('data/index.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('data/index.json 을 불러오지 못했습니다.');
    INDEX = await res.json();
    BY_TITLE.clear();
    for (const p of INDEX.pages) BY_TITLE.set(p.title, p);
  }

  async function fetchDoc(title) {
    if (rawCache.has(title)) return rawCache.get(title);
    const path = `${C.pagesDir}/${title.split('/').map(enc).join('/')}.md`;
    const res = await fetch(path, { cache: 'no-cache' });
    const raw = res.ok ? await res.text() : null;
    rawCache.set(title, raw);
    return raw;
  }

  /* ---------- GitHub 링크 ---------- */

  const filePath = (title) => `${C.pagesDir}/${title.split('/').map(enc).join('/')}.md`;
  const ghEdit = (title) => `https://github.com/${C.repo}/edit/${C.branch}/${filePath(title)}`;
  const ghHistory = (title) => `https://github.com/${C.repo}/commits/${C.branch}/${filePath(title)}`;
  const ghNew = (title) =>
    `https://github.com/${C.repo}/new/${C.branch}?filename=${enc(`${C.pagesDir}/${title}.md`)}` +
    `&value=${enc(`---\ncategories: \n---\n\n## 개요\n\n`)}`;

  /* ---------- 뷰 ---------- */

  function setTitle(t) {
    document.title = t ? `${t} - ${C.name}` : C.name;
  }

  function show(html) {
    app.innerHTML = html;
  }

  function tabsHtml(title, exists) {
    const t = [`<a href="#/backlink/${enc(title)}">역링크</a>`];
    if (C.repo) {
      t.push(`<a href="${exists ? ghEdit(title) : ghNew(title)}" target="_blank" rel="noopener">${exists ? '편집' : '새 문서 만들기'}</a>`);
      if (exists) t.push(`<a href="${ghHistory(title)}" target="_blank" rel="noopener">역사</a>`);
    }
    return `<nav class="tabs">${t.join('')}</nav>`;
  }

  async function viewDoc(title, params) {
    const raw = await fetchDoc(title);
    setTitle(title);

    if (raw === null) {
      show(`
        <div class="doc-head"><h1>${esc(title)}</h1>${tabsHtml(title, false)}</div>
        <p>이 문서는 아직 존재하지 않습니다.</p>
        ${C.repo ? `<p><a class="btn" href="${ghNew(title)}" target="_blank" rel="noopener">이 문서 만들기</a></p>` : ''}
        <p class="muted">GitHub 저장소의 <code>${esc(C.pagesDir)}/${esc(title)}.md</code> 파일로 만들어집니다.</p>
        <p><a href="#/search?q=${enc(title)}">‘${esc(title)}’(으)로 검색</a></p>`);
      window.scrollTo(0, 0);
      return;
    }

    const { meta, body } = parseDoc(raw);
    if (meta.redirect && meta.redirect !== title && !params.get('noredirect')) {
      location.replace(`#/w/${enc(meta.redirect)}?from=${enc(title)}`);
      return;
    }

    const { html, footnotes: fns } = renderMarkdown(body);
    const entry = BY_TITLE.get(title);
    const from = params.get('from');

    show(`
      <article class="doc">
        <div class="doc-head"><h1>${esc(title)}</h1>${tabsHtml(title, true)}</div>
        ${from ? `<p class="notice"><a href="${docHref(from)}?noredirect=1">${esc(from)}</a> 에서 넘어왔습니다.</p>` : ''}
        ${meta.categories.length ? `<div class="catbox"><span class="label">분류</span>${meta.categories.map((c) => `<a href="#/category/${enc(c)}">${esc(c)}</a>`).join('')}</div>` : ''}
        <div id="toc-slot"></div>
        <div class="content">${html}</div>
        ${fns.length ? `<div class="footnotes"><ol>${fns.map((f, i) => `<li id="fn-${i + 1}"><a class="back" href="#" data-fnref="${i + 1}">[${i + 1}]</a>${f}</li>`).join('')}</ol></div>` : ''}
        <div class="doc-foot">${entry && entry.updated ? `이 문서는 ${esc(fmtDate(entry.updated))}에 마지막으로 수정되었습니다.` : ''}</div>
      </article>`);

    const content = $('.content');
    decorateContent(content);
    buildToc(content, $('#toc-slot'));

    const section = params.get('s');
    if (section) scrollToHeading(section);
    else window.scrollTo(0, 0);
  }

  function decorateContent(root) {
    root.querySelectorAll('a.wikilink').forEach((a) => {
      if (!BY_TITLE.has(a.dataset.title)) a.classList.add('missing');
    });
    root.querySelectorAll('table').forEach((t) => {
      const wrap = document.createElement('div');
      wrap.className = 'table-wrap';
      t.replaceWith(wrap);
      wrap.appendChild(t);
    });
    root.querySelectorAll('a[href]').forEach((a) => {
      if (/^https?:/i.test(a.getAttribute('href')) && !a.classList.contains('external')) {
        a.classList.add('external');
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      }
    });
  }

  function buildToc(root, slot) {
    const heads = [...root.querySelectorAll('h1,h2,h3,h4,h5,h6')];
    heads.forEach((h) => { h.dataset.title = h.textContent.trim(); });
    if (heads.length < 2) return;
    const counters = [0, 0, 0, 0, 0];
    const items = [];
    for (const h of heads) {
      const level = Math.max(2, +h.tagName[1]);
      const idx = level - 2;
      counters[idx]++;
      for (let i = idx + 1; i < counters.length; i++) counters[i] = 0;
      const num = counters.slice(0, idx + 1).join('.');
      const id = `h-${num.replace(/\./g, '-')}`;
      h.id = id;
      const text = h.textContent;
      h.innerHTML = `<a class="hnum" href="#" data-scroll="toc-top">${num}.</a>${h.innerHTML}`;
      items.push(`<li class="l${level}"><a href="#" data-scroll="${id}"><span class="num">${num}.</span>${esc(text)}</a></li>`);
    }
    slot.innerHTML = `<div class="toc" id="toc-top"><div class="toc-title">목차</div><ul>${items.join('')}</ul></div>`;
  }

  function scrollToHeading(text) {
    const h = [...document.querySelectorAll('.content h1,h2,h3,h4,h5,h6')].find(
      (el) => el.dataset.title === text.trim()
    );
    if (h) h.scrollIntoView();
    else window.scrollTo(0, 0);
  }

  function scrollToId(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView();
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1500);
  }

  /* ---------- 검색 ---------- */

  const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function highlight(text, terms) {
    if (!terms.length) return esc(text);
    const re = new RegExp(`(${terms.map(reEscape).join('|')})`, 'gi');
    return text
      .split(re)
      .map((part, i) => (i % 2 ? `<mark>${esc(part)}</mark>` : esc(part)))
      .join('');
  }

  function search(q) {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const out = [];
    for (const p of INDEX.pages) {
      const tl = p.title.toLowerCase();
      const text = (p.text || '').toLowerCase();
      const cats = (p.categories || []).join(' ').toLowerCase();
      let score = 0;
      let ok = true;
      for (const t of terms) {
        if (tl === t) score += 100;
        else if (tl.startsWith(t)) score += 60;
        else if (tl.includes(t)) score += 40;
        else if (cats.includes(t)) score += 20;
        else if (text.includes(t)) score += 5;
        else { ok = false; break; }
      }
      if (ok) out.push({ p, score });
    }
    out.sort((a, b) => b.score - a.score || a.p.title.localeCompare(b.p.title, 'ko'));
    return out.map((o) => o.p);
  }

  function snippet(p, terms) {
    const text = p.text || p.summary || '';
    const lower = text.toLowerCase();
    let pos = -1;
    for (const t of terms) {
      const i = lower.indexOf(t);
      if (i >= 0 && (pos < 0 || i < pos)) pos = i;
    }
    const start = Math.max(0, pos < 0 ? 0 : pos - 30);
    const part = text.slice(start, start + 140);
    return (start > 0 ? '…' : '') + highlight(part, terms) + (start + 140 < text.length ? '…' : '');
  }

  function viewSearch(q) {
    setTitle(q ? `검색: ${q}` : '검색');
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const results = search(q);
    const exact = BY_TITLE.get(q.trim());
    show(`
      <h1 class="page-title">검색</h1>
      <form class="big-search" id="big-search"><input name="q" value="${esc(q)}" placeholder="검색어" autofocus><button class="btn" type="submit">검색</button></form>
      ${q ? `${exact ? `<p class="notice"><a href="${docHref(exact.title)}">${esc(exact.title)}</a> 문서로 바로 가기</p>` : ''}
      <p class="muted">‘${esc(q)}’ 검색 결과 ${results.length}건</p>
      ${results.length ? `<ul class="result-list">${results.map((p) => `
        <li><div class="r-title"><a href="${docHref(p.title)}">${highlight(p.title, terms)}</a></div>
        <div class="r-snip">${snippet(p, terms)}</div>
        ${p.categories && p.categories.length ? `<div class="r-meta">분류: ${p.categories.map(esc).join(', ')}</div>` : ''}</li>`).join('')}</ul>`
        : `<p>일치하는 문서가 없습니다.</p>${C.repo ? `<p><a class="btn" href="${ghNew(q.trim())}" target="_blank" rel="noopener">‘${esc(q.trim())}’ 문서 만들기</a></p>` : ''}`}` : ''}`);
    $('#big-search').addEventListener('submit', (e) => {
      e.preventDefault();
      location.hash = `#/search?q=${enc(new FormData(e.target).get('q'))}`;
    });
    window.scrollTo(0, 0);
  }

  function viewRecent() {
    setTitle('최근 변경');
    const pages = [...INDEX.pages].filter((p) => !p.redirect).sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
    show(`
      <h1 class="page-title">최근 변경</h1>
      <table class="simple-table"><tbody>${pages.map((p) => `
        <tr><td><a href="${docHref(p.title)}">${esc(p.title)}</a></td><td class="when">${esc(fmtDate(p.updated))}</td></tr>`).join('')}</tbody></table>`);
    window.scrollTo(0, 0);
  }

  function viewAll() {
    setTitle('전체 문서');
    const pages = [...INDEX.pages].sort((a, b) => a.title.localeCompare(b.title, 'ko'));
    const groups = new Map();
    for (const p of pages) {
      const ch = p.title.charAt(0).toUpperCase();
      if (!groups.has(ch)) groups.set(ch, []);
      groups.get(ch).push(p);
    }
    show(`
      <h1 class="page-title">전체 문서 <small class="muted">(${pages.length})</small></h1>
      ${[...groups].map(([ch, list]) => `<div class="alpha-group">${esc(ch)}</div>
        <ul class="alpha-list">${list.map((p) => `<li><a href="${docHref(p.title)}">${esc(p.title)}</a></li>`).join('')}</ul>`).join('')}`);
    window.scrollTo(0, 0);
  }

  function viewCategory(name) {
    setTitle(`분류:${name}`);
    const pages = INDEX.pages.filter((p) => (p.categories || []).includes(name)).sort((a, b) => a.title.localeCompare(b.title, 'ko'));
    show(`
      <h1 class="page-title">분류: ${esc(name)}</h1>
      ${pages.length ? `<ul class="alpha-list">${pages.map((p) => `<li><a href="${docHref(p.title)}">${esc(p.title)}</a></li>`).join('')}</ul>` : '<p>이 분류에 속한 문서가 없습니다.</p>'}`);
    window.scrollTo(0, 0);
  }

  function viewBacklinks(title) {
    setTitle(`${title} 역링크`);
    const pages = INDEX.pages.filter((p) => (p.links || []).includes(title)).sort((a, b) => a.title.localeCompare(b.title, 'ko'));
    show(`
      <h1 class="page-title"><a href="${docHref(title)}">${esc(title)}</a> 역링크</h1>
      ${pages.length ? `<ul class="alpha-list">${pages.map((p) => `<li><a href="${docHref(p.title)}">${esc(p.title)}</a></li>`).join('')}</ul>` : '<p>이 문서를 가리키는 문서가 없습니다.</p>'}`);
    window.scrollTo(0, 0);
  }

  function viewRandom() {
    const pool = INDEX.pages.filter((p) => !p.redirect);
    if (!pool.length) return viewNotFound();
    const p = pool[Math.floor(Math.random() * pool.length)];
    location.replace(docHref(p.title));
  }

  function viewNotFound() {
    setTitle('찾을 수 없음');
    show('<h1 class="page-title">페이지를 찾을 수 없습니다</h1><p><a href="#/">대문으로 돌아가기</a></p>');
  }

  /* ---------- 라우터 ---------- */

  async function route() {
    hideSuggest();
    const raw = location.hash.replace(/^#/, '') || '/';
    const qi = raw.indexOf('?');
    const pathPart = qi >= 0 ? raw.slice(0, qi) : raw;
    const params = new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : '');
    const [, kind = '', arg = ''] = pathPart.split('/');
    const name = safeDecode(arg);

    try {
      switch (kind) {
        case '': return await viewDoc(C.home, params);
        case 'w': return await viewDoc(name, params);
        case 'search': return viewSearch(params.get('q') || '');
        case 'recent': return viewRecent();
        case 'all': return viewAll();
        case 'category': return viewCategory(name);
        case 'backlink': return viewBacklinks(name);
        case 'random': return viewRandom();
        default: return viewNotFound();
      }
    } catch (err) {
      console.error(err);
      show(`<h1 class="page-title">오류</h1><p>${esc(err.message || err)}</p>`);
    }
  }

  /* ---------- 사이드바 / 헤더 ---------- */

  function renderSide() {
    const recent = INDEX.pages
      .filter((p) => !p.redirect && p.updated)
      .sort((a, b) => b.updated.localeCompare(a.updated))
      .slice(0, 10);
    $('#side').innerHTML = `<h3>최근 변경</h3><ol>${recent.map((p) => `
      <li><a href="${docHref(p.title)}">${esc(p.title)}</a><span class="when">${esc(fmtDay(p.updated))}</span></li>`).join('')}</ol>
      <a class="more" href="#/recent">더 보기 →</a>`;
  }

  function renderChrome() {
    $('#brand').textContent = C.name;
    $('#footer').innerHTML = `${esc(C.name)} · 문서 ${INDEX.pages.length}개` +
      (C.repo ? ` · <a href="https://github.com/${esc(C.repo)}" target="_blank" rel="noopener">GitHub</a>` : '');
  }

  /* 검색창 자동완성 */
  const input = $('#search-input');
  const suggest = $('#suggest');
  let active = -1;

  function hideSuggest() {
    suggest.hidden = true;
    suggest.innerHTML = '';
    active = -1;
  }

  function updateSuggest() {
    const q = input.value.trim().toLowerCase();
    if (!q) return hideSuggest();
    const starts = [];
    const includes = [];
    for (const p of INDEX.pages) {
      const t = p.title.toLowerCase();
      if (t.startsWith(q)) starts.push(p);
      else if (t.includes(q)) includes.push(p);
    }
    const list = [...starts, ...includes].slice(0, 8);
    if (!list.length) return hideSuggest();
    suggest.innerHTML = list.map((p) => `<li><a href="${docHref(p.title)}">${esc(p.title)}</a></li>`).join('');
    suggest.hidden = false;
    active = -1;
  }

  input.addEventListener('input', updateSuggest);
  input.addEventListener('keydown', (e) => {
    const items = [...suggest.querySelectorAll('li')];
    if (!items.length || suggest.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items.forEach((li, i) => li.classList.toggle('active', i === active));
    } else if (e.key === 'Escape') {
      hideSuggest();
    }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#search-form')) hideSuggest();
  });

  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const activeLink = suggest.querySelector('li.active a');
    const q = input.value.trim();
    if (activeLink) { location.hash = activeLink.getAttribute('href'); }
    else if (BY_TITLE.has(q)) { location.hash = docHref(q); }
    else if (q) { location.hash = `#/search?q=${enc(q)}`; }
    input.blur();
    hideSuggest();
  });

  $('#theme-toggle').addEventListener('click', () => {
    const root = document.documentElement;
    const cur = root.getAttribute('data-theme') ||
      (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('wiki-theme', next); } catch (e) {}
  });

  /* 문서 내 클릭 처리 (목차, 각주 이동) */
  app.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    if (a.dataset.scroll) {
      e.preventDefault();
      scrollToId(a.dataset.scroll);
    } else if (a.dataset.fn) {
      e.preventDefault();
      scrollToId(`fn-${a.dataset.fn}`);
    } else if (a.dataset.fnref) {
      e.preventDefault();
      scrollToId(`fnref-${a.dataset.fnref}`);
    } else if (a.dataset.scrollHeading !== undefined) {
      e.preventDefault();
      scrollToHeading(a.dataset.scrollHeading);
    }
  });

  /* ---------- 시작 ---------- */

  async function init() {
    $('#brand').textContent = C.name;
    try {
      await loadIndex();
    } catch (err) {
      show(`<h1 class="page-title">오류</h1><p>${esc(err.message)}</p>
        <p class="muted">처음 설치했다면 <code>node scripts/build-index.mjs</code> 를 실행해 <code>data/index.json</code> 을 만들어 주세요.</p>`);
      return;
    }
    renderChrome();
    renderSide();
    window.addEventListener('hashchange', route);
    route();
  }

  init();
})();
