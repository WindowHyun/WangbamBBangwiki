(() => {
  'use strict';

  const C = Object.assign(
    { name: '위키', home: '대문', repo: '', supabaseUrl: '', supabaseKey: '' },
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
  const store = {
    get(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  };

  const app = $('#app');
  let INDEX = { pages: [] };
  const BY_TITLE = new Map();

  /* ---------- Supabase (REST) ---------- */

  /* 접속 코드(친구 전용): 이 기기에 저장해 두고 모든 요청 헤더에 실어 보낸다 */
  const normCode = (c) => String(c || '').trim().toLowerCase().replace(/[\s\-_]+/g, '');
  const getCode = () => store.get('wiki-device') || store.get('wiki-code'); // 요청에 실어 보낼 열쇠 (기기 토큰 우선)

  const ERRORS = {
    locked: '접속 코드가 맞지 않거나 바뀌었어요. 코드를 다시 입력해 주세요.',
    conflict: '저장하는 사이에 다른 사람이 문서를 수정했습니다.',
    protected: '보호된 문서라 편집할 수 없습니다.',
    blocked: '편집이 차단된 IP입니다.',
    rate_limited: '짧은 시간에 너무 많이 저장했습니다. 잠시 뒤 다시 시도해 주세요.',
    no_change: '바뀐 내용이 없습니다.',
    invalid_title: '제목이 올바르지 않습니다. (1~100자, [ ] | # 와 줄바꿈 불가, / 로 시작하거나 끝날 수 없음)',
    invalid_content: '내용이 비어 있거나 너무 깁니다. (최대 10만 자)',
  };
  const errText = (err) =>
    ERRORS[err.code] || (err instanceof TypeError
      ? (navigator.onLine === false
        ? '인터넷에 연결되어 있지 않아요. 한 번 열어 본 문서만 오프라인에서 볼 수 있고, 저장·검색은 연결된 뒤에 할 수 있어요.'
        : '서버에 연결할 수 없습니다. 잠시 뒤 다시 시도해 주세요.')
      : err.message || String(err));

  /* 오프라인 안내 띠: 인터넷이 끊겼거나, 서비스 워커가 저장본으로 응답한 경우에 보인다 */
  let servedFromCache = false;
  function updateOffline() {
    const bar = $('#offline');
    if (bar) bar.hidden = !(servedFromCache || navigator.onLine === false);
  }

  async function sb(path, { method = 'GET', body } = {}) {
    const res = await fetch(`${C.supabaseUrl}/rest/v1/${path}`, {
      method,
      headers: { apikey: C.supabaseKey, 'Content-Type': 'application/json', ...(getCode() ? { 'x-wiki-code': getCode() } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (method === 'GET') {
      servedFromCache = res.headers.get('x-wiki-offline') === '1';
      updateOffline();
    }
    if (!res.ok) {
      let j = null;
      try { j = await res.json(); } catch (e) {}
      const err = new Error((j && j.message) || res.statusText);
      err.code = j && j.message;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  }

  const pgArr = (s) => `{"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"}`;

  const api = {
    list: () => sb('pages?select=title,categories,redirect_to,updated_at&order=title.asc&limit=5000'),
    get: async (title) =>
      (await sb(`pages?title=eq.${enc(title)}&select=title,content,rev,protected,updated_at,categories,redirect_to`))[0] || null,
    backlinks: (title) => sb(`pages?links=cs.${enc(pgArr(title))}&select=title&order=title.asc&limit=500`),
    history: (title) =>
      sb(`revisions?page_title=eq.${enc(title)}&select=rev,summary,author,ip_label,size,created_at&order=rev.desc&limit=200`),
    revision: async (title, rev) =>
      (await sb(`revisions?page_title=eq.${enc(title)}&rev=eq.${+rev}&select=rev,content,summary,author,ip_label,size,created_at`))[0] || null,
    recent: () =>
      sb('revisions?select=page_title,rev,summary,author,ip_label,size,created_at&order=created_at.desc&limit=100'),
    search: (q) => sb('rpc/search_pages', { method: 'POST', body: { q } }),
    edit: (p) => sb('rpc/edit_page', { method: 'POST', body: p }),
  };

  /* 코드가 맞는지 서버에 물어본다. 연결 문제 등은 코드 문제가 아니므로 통과시킨다. */
  async function checkAccess() {
    try {
      return (await sb('rpc/check_access', { method: 'POST', body: {} })) !== false;
    } catch (err) {
      return true;
    }
  }

  /* 코드가 맞지 않을 때 보여 주는 입장 화면 */
  function showGate(message) {
    document.body.classList.add('locked');
    setTitle('친구 전용');
    show(`
      <div class="gate">
        <div class="gate-icon" aria-hidden="true">🔒</div>
        <h1>친구 전용 위키</h1>
        <p>접속 코드를 입력하면 들어올 수 있어요.</p>
        <form id="gate-form" autocomplete="off">
          <input id="gate-code" type="text" inputmode="text" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="접속 코드" aria-label="접속 코드" value="" maxlength="80">
          <button class="btn" type="submit">입장</button>
        </form>
        <p class="gate-err" id="gate-err" role="alert" ${message ? '' : 'hidden'}>${esc(message || '')}</p>
        <p class="muted small">친구에게 받은 초대 링크를 열면 이 기기가 등록되어 다음부터는 바로 들어와요.<br>초대 링크는 한 번만 쓸 수 있어서, 폰·PC 기기마다 따로 받아야 해요.</p>
      </div>`);
    const form = $('#gate-form');
    $('#gate-code').focus();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = normCode($('#gate-code').value);
      const err = $('#gate-err');
      if (!code) { $('#gate-code').focus(); return; }
      form.querySelector('button').disabled = true;
      const res = await redeemOrCode(code);
      if (res.ok) {
        location.hash = '#/';
        location.reload();
      } else {
        form.querySelector('button').disabled = false;
        err.hidden = false;
        err.textContent = res.message;
        $('#gate-code').select();
      }
    });
  }

  /* 초대 토큰이면 이 기기를 등록하고, 아니면 공유 코드로 시도한다. 성공하면 열쇠를 이 기기에 저장한다. */
  async function redeemOrCode(input) {
    const token = normCode(input);
    const looksInvite = /^inv[0-9a-f]{40,}$/.test(token);
    if (looksInvite) {
      let dev = null;
      try { dev = await sb('rpc/redeem_invite', { method: 'POST', body: { p_token: token } }); } catch (err) {
        return { ok: false, message: errText(err) };
      }
      if (typeof dev === 'string' && dev) {
        store.set('wiki-device', dev);
        store.set('wiki-code', '');
        try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {} // 브라우저가 저장 값을 함부로 지우지 않도록 요청
        return { ok: true };
      }
      return { ok: false, message: '이미 사용됐거나 기간이 지난 초대 링크예요. 새 초대 링크를 받아 주세요.' };
    }
    const before = { device: store.get('wiki-device'), code: store.get('wiki-code') };
    store.set('wiki-device', '');
    store.set('wiki-code', token);
    if (await checkAccess()) return { ok: true };
    store.set('wiki-device', before.device);
    store.set('wiki-code', before.code);
    return { ok: false, message: '코드가 맞지 않아요. 다시 확인해 주세요.' };
  }

  /* 초대 링크(#/join/토큰)로 열었으면 토큰을 꺼내고 주소에서는 지운다 */
  function takeJoinToken() {
    const m = /^#\/join\/(.+)$/.exec(location.hash);
    if (!m) return null;
    history.replaceState(null, '', `${location.pathname}${location.search}#/`);
    return safeDecode(m[1]);
  }

  async function loadIndex() {
    const rows = await api.list();
    INDEX.pages = rows.map((r) => ({
      title: r.title,
      categories: r.categories || [],
      redirect: r.redirect_to,
      updated: r.updated_at,
    }));
    BY_TITLE.clear();
    for (const p of INDEX.pages) BY_TITLE.set(p.title, p);
  }

  /* ---------- markdown 확장 ([[링크]], [* 각주]) ---------- */

  let footnotes = [];
  let editRender = false; // true 면 편집기용 HTML(위키 링크·각주를 편집 가능한 표시로)을 만든다

  function renderWikiLink(target) {
    const sep = target.indexOf('|');
    const dest = (sep >= 0 ? target.slice(0, sep) : target).trim();
    const labelRaw = sep >= 0 ? target.slice(sep + 1).trim() : '';
    if (editRender) {
      return `<a class="wl" data-wiki="${esc(dest)}">${esc(labelRaw || dest)}</a>`;
    }
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

  /* 프로필 상자를 HTML 로 만든다. 편집기용(editRender)은 원문을 data-ib 에 담아 둔다. */
  function infoboxHtml(token, parser) {
    const d = token.data;
    const img = /^https?:\/\//i.test(d.image) ? d.image : '';
    const rows = d.rows.map((r, i) => {
      if (r.type === 'head') return `<tr class="ib-head"><th colspan="2">${esc(r.label)}</th></tr>`;
      return `<tr><th>${esc(r.label)}</th><td>${parser.parseInline(token.valueTokens[i])}</td></tr>`;
    });
    const attrs = editRender ? ` ib-edit" data-ib="${esc(token.body)}" title="클릭해서 프로필 상자 편집` : '';
    return `<aside class="infobox${attrs}">` +
      (d.title ? `<div class="ib-title">${esc(d.title)}</div>` : '') +
      (img ? `<figure class="ib-image"><img src="${esc(img)}" alt="${esc(d.caption || d.title)}" loading="lazy" referrerpolicy="no-referrer">${d.caption ? `<figcaption>${esc(d.caption)}</figcaption>` : ''}</figure>` : '') +
      (rows.length ? `<table class="ib-table"><tbody>${rows.join('')}</tbody></table>` : '') +
      '</aside>\n';
  }

  marked.use({
    gfm: true,
    breaks: true,
    renderer: {
      // ![설명](주소 "fold") → 접어 둔 사진. 편집기용(editRender)은 접기 여부만 data-fold 로 표시한다.
      image(href, title, text) {
        const fold = title === 'fold';
        if (editRender) return `<img src="${esc(href)}" alt="${esc(text)}"${fold ? ' data-fold="1"' : ''}>`;
        if (!fold) return false;
        return `<details class="img-fold"><summary>🖼 ${esc(text || '사진')}</summary><img src="${esc(href)}" alt="${esc(text)}" loading="lazy"></details>`;
      },
    },
    extensions: [
      {
        name: 'infobox',
        level: 'block',
        start: (src) => src.indexOf(':::infobox'),
        tokenizer(src) {
          const m = /^:::infobox[ \t]*\n([\s\S]*?)\n:::[ \t]*(?:\n|$)/.exec(src);
          if (!m) return;
          const data = WikiInfobox.parse(m[1]);
          return {
            type: 'infobox',
            raw: m[0],
            body: m[1],
            data,
            valueTokens: data.rows.map((r) => (r.type === 'row' ? this.lexer.inlineTokens(r.value) : null)),
          };
        },
        renderer(token) {
          return infoboxHtml(token, this.parser);
        },
      },
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
          if (editRender) return `<sup class="fnm" data-fn="${esc(token.text)}">&#8203;</sup>`;
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

  /* 편집기에 넣을 HTML. 위키 링크와 각주는 편집기가 다룰 수 있는 표시로 만든다. */
  function renderEditHtml(body) {
    editRender = true;
    try {
      const html = marked.parse(body);
      return DOMPurify.sanitize(html, { ADD_ATTR: ['data-wiki', 'data-fn', 'data-ib', 'referrerpolicy', 'loading'] });
    } finally {
      editRender = false;
    }
  }

  function renderMarkdown(body) {
    footnotes = [];
    const html = marked.parse(body);
    return { html: DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'referrerpolicy', 'loading'] }), footnotes: footnotes.slice() };
  }

  /* 본문(목차 + 내용 + 각주)을 container 에 그린다. 문서 보기와 미리보기가 같이 쓴다. */
  function renderBodyInto(container, content) {
    const { body } = parseDoc(content);
    const { html, footnotes: fns } = renderMarkdown(body);
    container.innerHTML = `
      <div class="toc-slot"></div>
      <div class="content">${html}</div>
      ${fns.length ? `<div class="footnotes"><ol>${fns.map((f, i) => `<li id="fn-${i + 1}"><a class="back" href="#" data-fnref="${i + 1}">[${i + 1}]</a>${f}</li>`).join('')}</ol></div>` : ''}`;
    const contentEl = $('.content', container);
    decorateContent(contentEl);
    buildToc(contentEl, $('.toc-slot', container));
    // 첫 프로필 상자는 목차보다 앞(문서 맨 위 오른쪽)에 둔다. 그래야 목차·본문이 상자 옆으로 흐른다.
    const box = contentEl.querySelector('.infobox');
    if (box) container.insertBefore(box, container.firstChild);
  }

  function decorateContent(root) {
    root.querySelectorAll('a.wikilink').forEach((a) => {
      if (!BY_TITLE.has(a.dataset.title)) a.classList.add('missing');
    });
    root.querySelectorAll('table:not(.ib-table)').forEach((t) => {
      const wrap = document.createElement('div');
      wrap.className = 'table-wrap';
      t.replaceWith(wrap);
      wrap.appendChild(t);
    });
    root.querySelectorAll('img').forEach((img) => { img.referrerPolicy = 'no-referrer'; });
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

  /* ---------- 공통 뷰 헬퍼 ---------- */

  let routeId = 0;
  const guard = () => {
    const id = routeId;
    return () => id === routeId;
  };

  function setTitle(t) {
    document.title = t ? `${t} - ${C.name}` : C.name;
  }

  function show(html) {
    app.innerHTML = html;
  }

  function loading() {
    show('<p class="loading">불러오는 중…</p>');
  }

  function tabsHtml(title, active) {
    const tab = (key, href, label) =>
      `<a href="${href}"${active === key ? ' class="active"' : ''}>${label}</a>`;
    return `<nav class="tabs">${[
      tab('backlink', `#/backlink/${enc(title)}`, '역링크'),
      tab('edit', `#/edit/${enc(title)}`, '편집'),
      tab('history', `#/history/${enc(title)}`, '역사'),
    ].join('')}</nav>`;
  }

  const who = (author, ip) => `${esc(author)} <span class="ip">(${esc(ip)})</span>`;

  /* ---------- 문서 보기 ---------- */

  async function viewDoc(title, params) {
    const ok = guard();
    loading();
    const row = await api.get(title);
    if (!ok()) return;
    setTitle(title);

    if (!row) {
      if (!(await checkAccess())) { if (ok()) showGate(getCode() ? '저장된 코드가 맞지 않아요. 새 코드를 입력해 주세요.' : ''); return; }
      if (!ok()) return;
      show(`
        <div class="doc-head"><h1>${esc(title)}</h1>${tabsHtml(title, '')}</div>
        <p>이 문서는 아직 존재하지 않습니다.</p>
        <p><a class="btn" href="#/edit/${enc(title)}">이 문서 만들기</a></p>
        <p><a href="#/search?q=${enc(title)}">‘${esc(title)}’(으)로 검색</a></p>`);
      window.scrollTo(0, 0);
      return;
    }

    if (row.redirect_to && row.redirect_to !== title && !params.get('noredirect')) {
      location.replace(`#/w/${enc(row.redirect_to)}?from=${enc(title)}`);
      return;
    }

    const from = params.get('from');
    const cats = row.categories || [];
    show(`
      <article class="doc">
        <div class="doc-head"><h1>${esc(title)}</h1>${tabsHtml(title, '')}</div>
        ${row.protected ? '<p class="notice">🔒 보호된 문서입니다. 편집할 수 없습니다.</p>' : ''}
        ${from ? `<p class="notice"><a href="#/w/${enc(from)}?noredirect=1">${esc(from)}</a> 에서 넘어왔습니다.</p>` : ''}
        ${cats.length ? `<div class="catbox"><span class="label">분류</span>${cats.map((c) => `<a href="#/category/${enc(c)}">${esc(c)}</a>`).join('')}</div>` : ''}
        <div id="body"></div>
        <div class="doc-foot">이 문서는 ${esc(fmtDate(row.updated_at))}에 마지막으로 수정되었습니다. (r${row.rev})</div>
      </article>`);
    renderBodyInto($('#body'), row.content);

    const section = params.get('s');
    if (section) scrollToHeading(section);
    else window.scrollTo(0, 0);
  }

  /* 특정 판 보기 */
  async function viewRev(title, rev) {
    const ok = guard();
    loading();
    const r = await api.revision(title, rev);
    if (!ok()) return;
    setTitle(`${title} (r${rev})`);
    if (!r) {
      show(`<h1 class="page-title">${esc(title)}</h1><p>r${esc(rev)} 판이 없습니다. <a href="#/history/${enc(title)}">역사로</a></p>`);
      return;
    }
    show(`
      <article class="doc">
        <div class="doc-head"><h1>${esc(title)}</h1>${tabsHtml(title, 'history')}</div>
        <p class="notice">이것은 <b>r${r.rev}</b> 판입니다 (${esc(fmtDate(r.created_at))}, ${who(r.author, r.ip_label)}).
          <a href="${docHref(title)}">최신 판 보기</a> · <a href="#/edit/${enc(title)}?r=${r.rev}">이 판으로 되돌리기</a> · <a href="#/history/${enc(title)}">역사</a></p>
        <div id="body"></div>
      </article>`);
    renderBodyInto($('#body'), r.content);
    window.scrollTo(0, 0);
  }

  /* ---------- 역사 / 비교 ---------- */

  async function viewHistory(title) {
    const ok = guard();
    loading();
    const rows = await api.history(title);
    if (!ok()) return;
    setTitle(`${title} 역사`);
    if (!rows.length) {
      show(`<h1 class="page-title">${esc(title)} 역사</h1><p>편집 기록이 없습니다. <a href="#/edit/${enc(title)}">문서 만들기</a></p>`);
      return;
    }
    const latest = rows[0].rev;
    show(`
      <div class="doc-head"><h1><a href="${docHref(title)}">${esc(title)}</a> <small>역사</small></h1>${tabsHtml(title, 'history')}</div>
      <table class="simple-table history">
        <thead><tr><th>판</th><th>시각</th><th>편집자</th><th>크기</th><th>요약</th><th></th></tr></thead>
        <tbody>${rows.map((r) => `
          <tr>
            <td><a href="#/rev/${enc(title)}/${r.rev}">r${r.rev}</a>${r.rev === latest ? ' <span class="tag">최신</span>' : ''}</td>
            <td class="when">${esc(fmtDate(r.created_at))}</td>
            <td>${who(r.author, r.ip_label)}</td>
            <td class="when">${r.size.toLocaleString('ko-KR')}</td>
            <td>${esc(r.summary)}</td>
            <td class="when">${[
              r.rev > 1 ? `<a href="#/diff/${enc(title)}/${r.rev}">비교</a>` : '',
              r.rev !== latest ? `<a href="#/edit/${enc(title)}?r=${r.rev}">되돌리기</a>` : '',
            ].filter(Boolean).join(' · ')}</td>
          </tr>`).join('')}</tbody>
      </table>`);
    window.scrollTo(0, 0);
  }

  function lineDiff(a, b) {
    const x = a.split('\n');
    const y = b.split('\n');
    const n = x.length;
    const m = y.length;
    if (n * m > 4000000) return null;
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const ops = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (x[i] === y[j]) { ops.push({ t: ' ', s: x[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ t: '-', s: x[i++] });
      else ops.push({ t: '+', s: y[j++] });
    }
    while (i < n) ops.push({ t: '-', s: x[i++] });
    while (j < m) ops.push({ t: '+', s: y[j++] });
    return ops;
  }

  function diffHtml(oldText, newText) {
    const ops = lineDiff(oldText, newText);
    if (!ops) return '<p class="muted">문서가 너무 커서 변경 내용을 표시할 수 없습니다.</p>';
    const CONTEXT = 3;
    const keep = new Array(ops.length).fill(false);
    ops.forEach((o, i) => {
      if (o.t === ' ') return;
      for (let k = Math.max(0, i - CONTEXT); k <= Math.min(ops.length - 1, i + CONTEXT); k++) keep[k] = true;
    });
    if (!keep.some(Boolean)) return '<p class="muted">차이가 없습니다.</p>';
    const rows = [];
    let skipped = false;
    ops.forEach((o, i) => {
      if (!keep[i]) { skipped = true; return; }
      if (skipped && rows.length) rows.push('<tr class="diff-gap"><td></td><td>⋯</td></tr>');
      skipped = false;
      rows.push(`<tr class="diff-${o.t === '+' ? 'add' : o.t === '-' ? 'del' : 'same'}"><td class="sign">${o.t === ' ' ? '' : o.t}</td><td><pre>${esc(o.s) || ' '}</pre></td></tr>`);
    });
    return `<table class="diff"><tbody>${rows.join('')}</tbody></table>`;
  }

  async function viewDiff(title, rev) {
    const ok = guard();
    loading();
    rev = +rev;
    const [cur, prev] = await Promise.all([api.revision(title, rev), api.revision(title, rev - 1)]);
    if (!ok()) return;
    setTitle(`${title} 비교`);
    if (!cur) {
      show(`<h1 class="page-title">${esc(title)}</h1><p>r${rev} 판이 없습니다. <a href="#/history/${enc(title)}">역사로</a></p>`);
      return;
    }
    show(`
      <div class="doc-head"><h1><a href="${docHref(title)}">${esc(title)}</a> <small>r${prev ? prev.rev : 0} → r${cur.rev} 비교</small></h1>${tabsHtml(title, 'history')}</div>
      <p class="muted">${esc(fmtDate(cur.created_at))} · ${who(cur.author, cur.ip_label)}${cur.summary ? ` · ${esc(cur.summary)}` : ''}</p>
      ${diffHtml(prev ? prev.content : '', cur.content)}
      <p><a href="#/history/${enc(title)}">← 역사로</a></p>`);
    window.scrollTo(0, 0);
  }

  /* ---------- 이미지 업로드 (Supabase Storage) ---------- */

  const IMG_BUCKET = 'wiki-images';
  const IMG_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
  const IMG_MAX_BYTES = 5 * 1024 * 1024; // 서버(버킷) 제한과 같은 값
  const IMG_MAX_SIDE = 1600; // 이보다 크면 긴 변을 이 크기로 줄여서 올린다
  const IMG_KEEP_BYTES = 1.5 * 1024 * 1024; // 크기가 이 이하이고 해상도도 작으면 원본 그대로 올린다

  const imgError = (msg) => Object.assign(new Error(msg), { code: 'upload' });

  /* 큰 사진은 올리기 전에 줄인다 (저장 공간과 로딩 시간 절약). GIF 는 움직임이 사라지므로 그대로 둔다. */
  async function prepareImage(file) {
    if (!IMG_EXT[file.type]) throw imgError('PNG, JPG, GIF, WEBP 이미지만 올릴 수 있어요.');
    let out = file;
    if (file.type !== 'image/gif' && typeof createImageBitmap === 'function') {
      try {
        const bmp = await createImageBitmap(file);
        const scale = Math.min(1, IMG_MAX_SIDE / Math.max(bmp.width, bmp.height));
        if (scale < 1 || file.size > IMG_KEEP_BYTES) {
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(bmp.width * scale));
          canvas.height = Math.max(1, Math.round(bmp.height * scale));
          canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
          const blob = await new Promise((res) => canvas.toBlob(res, file.type, 0.85));
          // 형식이 바뀌었거나(브라우저가 인코딩을 지원하지 않음) 오히려 커졌으면 원본을 쓴다
          if (blob && blob.type === file.type && (scale < 1 || blob.size < file.size)) out = blob;
        }
        if (bmp.close) bmp.close();
      } catch (e) { /* 읽을 수 없으면 원본 그대로 */ }
    }
    if (out.size > IMG_MAX_BYTES) throw imgError('이미지가 너무 커요. 5MB 이하로 올려 주세요.');
    return out;
  }

  const randomId = () => (crypto.randomUUID ? crypto.randomUUID() : ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));

  const uploadErrorText = (status, body) => {
    const code = body && (body.error || body.code);
    if (status === 413 || (body && body.statusCode == 413)) return '이미지가 너무 커요. 5MB 이하로 올려 주세요.';
    if (code === 'invalid_mime_type' || (body && body.statusCode == 415)) return 'PNG, JPG, GIF, WEBP 이미지만 올릴 수 있어요.';
    if (status === 403 || (body && (body.statusCode == 403 || /row-level security/i.test(body.message || '')))) return '지금은 올릴 수 없어요. 짧은 시간에 너무 많이 올렸거나 업로드가 제한된 상태예요. 잠시 뒤 다시 시도해 주세요.';
    return '업로드에 실패했어요. 잠시 뒤 다시 시도해 주세요.';
  };

  /* 파일을 Storage 에 올리고 공개 주소를 돌려준다. onProgress(0~1) 로 진행률을 알린다. */
  async function uploadImage(file, onProgress) {
    const blob = await prepareImage(file);
    const d = new Date();
    const path = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${randomId()}.${IMG_EXT[blob.type]}`;
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${C.supabaseUrl}/storage/v1/object/${IMG_BUCKET}/${path}`);
      xhr.setRequestHeader('apikey', C.supabaseKey);
      if (getCode()) xhr.setRequestHeader('x-wiki-code', getCode());
      xhr.setRequestHeader('Content-Type', blob.type);
      xhr.setRequestHeader('x-upsert', 'false');
      xhr.setRequestHeader('cache-control', 'max-age=31536000');
      if (onProgress) xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) return resolve();
        let body = null;
        try { body = JSON.parse(xhr.responseText); } catch (e) {}
        reject(imgError(uploadErrorText(xhr.status, body)));
      };
      xhr.onerror = () => reject(imgError('서버에 연결할 수 없어요. 잠시 뒤 다시 시도해 주세요.'));
      xhr.send(blob);
    });
    return { url: `${C.supabaseUrl}/storage/v1/object/public/${IMG_BUCKET}/${path}` };
  }

  /* ---------- 편집 ---------- */

  let wikiEditor = null;

  function destroyEditor() {
    if (!wikiEditor) return;
    try { wikiEditor.destroy(); } catch (e) {}
    wikiEditor = null;
  }

  /* 분류 태그 입력(칩) */
  function mountChips(box, initial, onChange) {
    let cats = [...initial];
    const input = $('input', box);
    const render = () => {
      box.querySelectorAll('.chip').forEach((c) => c.remove());
      cats.forEach((c, i) => {
        const el = document.createElement('span');
        el.className = 'chip';
        el.innerHTML = `${esc(c)}<button type="button" aria-label="${esc(c)} 삭제" data-i="${i}">×</button>`;
        box.insertBefore(el, input);
      });
    };
    const add = (raw) => {
      raw.split(',').map((s) => s.trim()).filter(Boolean).forEach((c) => {
        if (!cats.includes(c) && cats.length < 20) cats.push(c);
      });
      input.value = '';
      render();
      onChange();
    };
    box.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-i]');
      if (b) { cats.splice(+b.dataset.i, 1); render(); onChange(); }
      else input.focus();
    });
    input.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ',') && input.value.trim()) { e.preventDefault(); add(input.value); }
      else if (e.key === 'Backspace' && !input.value && cats.length) { cats.pop(); render(); onChange(); }
    });
    input.addEventListener('blur', () => { if (input.value.trim()) add(input.value); });
    render();
    return () => {
      if (input.value.trim()) add(input.value);
      return cats;
    };
  }

  async function viewEdit(title, params) {
    const ok = guard();
    loading();
    const row = await api.get(title);
    const revParam = params.get('r');
    const old = row && revParam ? await api.revision(title, revParam) : null;
    if (!ok()) return;
    if (!row && !(await checkAccess())) { if (ok()) showGate(getCode() ? '저장된 코드가 맞지 않아요. 새 코드를 입력해 주세요.' : ''); return; }
    if (!ok()) return;
    setTitle(`${title} 편집`);

    if (row && row.protected) {
      show(`<div class="doc-head"><h1>${esc(title)}</h1>${tabsHtml(title, 'edit')}</div><p class="notice">🔒 보호된 문서라 편집할 수 없습니다.</p>`);
      return;
    }

    const baseRev = row ? row.rev : 0;
    const source = old ? old.content : row ? row.content : '';
    const { meta, body } = parseDoc(source);
    const defaultSummary = old ? `r${old.rev}(으)로 되돌림` : '';
    const backHref = row ? docHref(title) : '#/';

    show(`
      <div class="edit-head">
        <div>
          <h1>${esc(title)}</h1>
          <span class="badge">${row ? `편집 중 · r${row.rev} 기준` : '새 문서'}</span>
        </div>
        <a class="back-link" href="${backHref}">← ${row ? '문서로 돌아가기' : '대문으로'}</a>
      </div>
      ${old ? `<p class="notice">r${old.rev} 판 내용을 불러왔습니다. 저장하면 이 내용으로 되돌립니다.</p>` : ''}
      <div class="cat-row">
        <span class="cat-label">분류</span>
        <div class="chips" id="chips"><input id="chip-input" placeholder="분류 입력 후 Enter" maxlength="30" aria-label="분류 추가"></div>
      </div>
      <div id="we-mount"></div>
      <details class="adv">
        <summary>고급 설정</summary>
        <label>넘겨주기 <small class="muted">(이 문서를 열면 다른 문서로 이동)</small>
          <input id="ed-redirect" maxlength="100" placeholder="이동할 문서 제목" value="${esc(meta.redirect || '')}">
        </label>
      </details>
      <div id="ed-error" class="error" hidden></div>
      <div class="submit-bar">
        <input id="ed-author" maxlength="20" placeholder="닉네임 (익명)" aria-label="닉네임">
        <input id="ed-summary" class="grow" maxlength="200" placeholder="수정 내용을 한 줄로 적어 주세요 (선택)" aria-label="편집 요약">
        <a class="btn secondary" href="${backHref}">취소</a>
        <button type="button" class="btn" id="ed-save">저장</button>
      </div>
      <p class="muted small submit-note">저장하면 편집 기록에 닉네임과 IP 일부(예: 1.2.*.*)가 남습니다.</p>`);

    let dirty = false;
    const markDirty = () => { dirty = true; };
    window.onbeforeunload = () => (dirty ? '저장하지 않은 내용이 있습니다.' : undefined);

    wikiEditor = WikiEditor.create($('#we-mount'), {
      renderHtml: renderEditHtml,
      titles: () => INDEX.pages.map((p) => p.title),
      isMissing: (dest) => {
        const t = String(dest || '').split('#')[0].trim();
        return !!t && !/^https?:\/\//i.test(t) && !/^분류:/.test(t) && !BY_TITLE.has(t);
      },
      uploadImage,
      onChange: markDirty,
    });
    wikiEditor.setMarkdown(body);
    dirty = false;
    const getCats = mountChips($('#chips'), meta.categories, markDirty);
    $('#ed-redirect').addEventListener('input', markDirty);
    $('#ed-author').value = store.get('wiki-nick');
    $('#ed-summary').value = defaultSummary;
    if (!row) wikiEditor.focus();

    const errBox = $('#ed-error');
    const saveBtn = $('#ed-save');
    saveBtn.addEventListener('click', async () => {
      errBox.hidden = true;
      if (wikiEditor.isBusy()) {
        errBox.hidden = false;
        errBox.textContent = '이미지를 올리는 중이에요. 올리기가 끝난 뒤에 저장해 주세요.';
        return;
      }
      saveBtn.disabled = true;
      saveBtn.textContent = '저장 중…';
      const author = $('#ed-author').value.trim();
      // 머리말(분류·넘겨주기)은 화면에 따로 두고, 저장할 때만 문서 맨 위에 붙인다.
      const front = [];
      const cats = getCats();
      const redirect = $('#ed-redirect').value.trim();
      if (cats.length) front.push(`categories: ${cats.join(', ')}`);
      if (redirect) front.push(`redirect: ${redirect}`);
      const content = (front.length ? `---\n${front.join('\n')}\n---\n\n` : '') + wikiEditor.getMarkdown();
      try {
        await api.edit({
          p_title: title,
          p_content: content,
          p_base_rev: baseRev,
          p_summary: $('#ed-summary').value,
          p_author: author,
        });
        store.set('wiki-nick', author);
        dirty = false;
        window.onbeforeunload = null;
        await loadIndex().catch(() => {});
        renderSide();
        location.hash = docHref(title);
      } catch (err) {
        errBox.hidden = false;
        errBox.innerHTML = esc(errText(err)) + (err.code === 'locked'
          ? ' 작성한 내용은 그대로 두고 <a href="#/gate" target="_blank" rel="noopener">새 탭에서 코드를 입력</a>한 뒤 다시 저장해 주세요.'
          : err.code === 'conflict'
          ? ` 작성한 내용을 복사해 둔 뒤 <a href="${docHref(title)}" target="_blank" rel="noopener">최신 문서</a>를 확인하고 다시 편집해 주세요.`
          : '');
        saveBtn.disabled = false;
        saveBtn.textContent = '저장';
        errBox.scrollIntoView({ block: 'nearest' });
      }
    });
    window.scrollTo(0, 0);
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

  const plainSnippet = (s) =>
    (s || '').replace(/:::\w*|(?:title|image|caption):\s*https?:\/\/\S+/gi, ' ').replace(/[#>*_`|~]|\[\[|\]\]|\[\*/g, ' ').replace(/\s+/g, ' ').trim();

  async function viewSearch(q) {
    const ok = guard();
    setTitle(q ? `검색: ${q}` : '검색');
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const form = `<form class="big-search" id="big-search"><input name="q" value="${esc(q)}" placeholder="검색어" autofocus><button class="btn" type="submit">검색</button></form>`;
    show(`<h1 class="page-title">검색</h1>${form}${q ? '<p class="loading">검색 중…</p>' : ''}`);
    bindBigSearch();
    if (!q) return;
    const results = await api.search(q);
    if (!ok()) return;
    const exact = BY_TITLE.get(q.trim());
    show(`
      <h1 class="page-title">검색</h1>${form}
      ${exact ? `<p class="notice"><a href="${docHref(exact.title)}">${esc(exact.title)}</a> 문서로 바로 가기</p>` : ''}
      <p class="muted">‘${esc(q)}’ 검색 결과 ${results.length}건</p>
      ${results.length ? `<ul class="result-list">${results.map((p) => `
        <li><div class="r-title"><a href="${docHref(p.title)}">${highlight(p.title, terms)}</a></div>
        <div class="r-snip">${highlight(plainSnippet(p.snippet), terms)}</div>
        ${p.categories && p.categories.length ? `<div class="r-meta">분류: ${p.categories.map(esc).join(', ')}</div>` : ''}</li>`).join('')}</ul>`
        : `<p>일치하는 문서가 없습니다.</p><p><a class="btn" href="#/edit/${enc(q.trim())}">‘${esc(q.trim())}’ 문서 만들기</a></p>`}`);
    bindBigSearch();
    window.scrollTo(0, 0);
  }

  function bindBigSearch() {
    const f = $('#big-search');
    if (!f) return;
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      location.hash = `#/search?q=${enc(new FormData(e.target).get('q'))}`;
    });
  }

  /* ---------- 목록 뷰 ---------- */

  async function viewRecent() {
    const ok = guard();
    loading();
    const rows = await api.recent();
    if (!ok()) return;
    setTitle('최근 변경');
    show(`
      <h1 class="page-title">최근 변경</h1>
      <table class="simple-table"><tbody>${rows.map((r) => `
        <tr>
          <td><a href="${docHref(r.page_title)}">${esc(r.page_title)}</a> <a class="muted" href="#/rev/${enc(r.page_title)}/${r.rev}">r${r.rev}</a></td>
          <td>${who(r.author, r.ip_label)}</td>
          <td class="summary">${esc(r.summary)}</td>
          <td class="when">${esc(fmtDate(r.created_at))}</td>
        </tr>`).join('')}</tbody></table>`);
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
    const pages = INDEX.pages.filter((p) => p.categories.includes(name)).sort((a, b) => a.title.localeCompare(b.title, 'ko'));
    show(`
      <h1 class="page-title">분류: ${esc(name)}</h1>
      ${pages.length ? `<ul class="alpha-list">${pages.map((p) => `<li><a href="${docHref(p.title)}">${esc(p.title)}</a></li>`).join('')}</ul>` : '<p>이 분류에 속한 문서가 없습니다.</p>'}`);
    window.scrollTo(0, 0);
  }

  async function viewBacklinks(title) {
    const ok = guard();
    loading();
    const pages = await api.backlinks(title);
    if (!ok()) return;
    setTitle(`${title} 역링크`);
    show(`
      <div class="doc-head"><h1><a href="${docHref(title)}">${esc(title)}</a> <small>역링크</small></h1>${tabsHtml(title, 'backlink')}</div>
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
    routeId++;
    window.onbeforeunload = null;
    destroyEditor();
    hideSuggest();
    const raw = location.hash.replace(/^#/, '') || '/';
    const qi = raw.indexOf('?');
    const pathPart = qi >= 0 ? raw.slice(0, qi) : raw;
    const params = new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : '');
    const [, kind = '', arg = '', arg2 = ''] = pathPart.split('/');
    const name = safeDecode(arg);

    try {
      switch (kind) {
        case '': return await viewDoc(C.home, params);
        case 'w': return await viewDoc(name, params);
        case 'edit': return await viewEdit(name, params);
        case 'history': return await viewHistory(name);
        case 'rev': return await viewRev(name, arg2);
        case 'diff': return await viewDiff(name, arg2);
        case 'gate': return showGate('');
        case 'search': return await viewSearch(params.get('q') || '');
        case 'recent': return await viewRecent();
        case 'all': return viewAll();
        case 'category': return viewCategory(name);
        case 'backlink': return await viewBacklinks(name);
        case 'random': return viewRandom();
        default: return viewNotFound();
      }
    } catch (err) {
      console.error(err);
      show(`<h1 class="page-title">오류</h1><p>${esc(errText(err))}</p>`);
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
      (C.repo ? ` · <a href="https://github.com/${esc(C.repo)}" target="_blank" rel="noopener">GitHub</a>` : '') +
      (installPrompt ? ' · <a href="#" id="install-app">앱으로 설치</a>' : '') +
      (getCode() ? ' · <a href="#" id="forget-code" title="이 기기의 등록을 풀고 저장된 문서를 지워요">이 기기 로그아웃</a>' : '');
    const forget = $('#forget-code');
    if (forget) {
      forget.addEventListener('click', async (e) => {
        e.preventDefault();
        if (!confirm('이 기기에 저장된 접속 정보와 저장된 문서를 지울까요? 이 기기는 등록이 풀려서, 다시 들어오려면 새 초대 링크가 필요해요.')) return;
        store.set('wiki-code', '');
        store.set('wiki-device', '');
        try { for (const k of await caches.keys()) if (k.startsWith('wiki-data-')) await caches.delete(k); } catch (err) {}
        location.hash = '#/';
        location.reload();
      });
    }
    const inst = $('#install-app');
    if (inst) {
      inst.addEventListener('click', async (e) => {
        e.preventDefault();
        installPrompt.prompt();
        await installPrompt.userChoice.catch(() => {});
        installPrompt = null;
        renderChrome();
      });
    }
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
    store.set('wiki-theme', next);
  });

  /* 문서 내 클릭 처리 (목차, 각주 이동) */
  function openLightbox(img) {
    const src = img.currentSrc || img.src;
    const box = document.createElement('div');
    box.className = 'lightbox';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', '사진 크게 보기');
    box.innerHTML = `<button type="button" class="lb-close" aria-label="닫기">✕</button>
      <img src="${esc(src)}" alt="${esc(img.alt)}">
      <div class="lb-cap">${img.alt ? `<span>${esc(img.alt)}</span>` : ''}<a href="${esc(src)}" target="_blank" rel="noopener noreferrer">원본 열기 ↗</a></div>`;
    const close = () => { box.remove(); document.removeEventListener('keydown', onKey, true); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    box.addEventListener('click', (e) => { if (!e.target.closest('.lb-cap a')) close(); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(box);
  }

  app.addEventListener('click', (e) => {
    const img = e.target.closest('img');
    if (img && img.closest('.content, .infobox') && !img.closest('a, .we-editor')) {
      openLightbox(img);
      return;
    }
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

  /* ---------- 앱 설치(PWA) ---------- */

  let installPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    renderChrome();
  });
  window.addEventListener('appinstalled', () => { installPrompt = null; renderChrome(); });

  function showUpdateToast(apply) {
    if ($('.pwa-toast')) return;
    const t = document.createElement('div');
    t.className = 'pwa-toast';
    t.setAttribute('role', 'status');
    t.innerHTML = '<span>새 버전이 있어요</span><button type="button">새로고침</button><button type="button" class="x" aria-label="닫기">✕</button>';
    t.querySelector('button').addEventListener('click', apply);
    t.querySelector('.x').addEventListener('click', () => t.remove());
    document.body.appendChild(t);
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    const secure = location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname);
    if (!secure) return;
    const hadController = !!navigator.serviceWorker.controller; // 처음 설치될 때는 새로고침하지 않는다
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return;
      reloading = true;
      location.reload();
    });
    navigator.serviceWorker.register('sw.js').then((reg) => {
      const offer = (worker) => showUpdateToast(() => worker.postMessage('SKIP_WAITING'));
      if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        if (!w) return;
        w.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w);
        });
      });
    }).catch(() => {});
  }

  window.addEventListener('online', () => {
    servedFromCache = false;
    updateOffline();
    loadIndex().then(() => { renderChrome(); renderSide(); }).catch(() => {});
  });
  window.addEventListener('offline', updateOffline);

  /* ---------- 시작 ---------- */

  async function init() {
    $('#brand').textContent = C.name;
    // 입장 화면이나 앱을 연 채로 새 초대 링크를 열어도 적용되도록 가장 먼저 연결한다
    window.addEventListener('hashchange', async () => {
      const tok = takeJoinToken();
      if (!tok) return;
      const res = await redeemOrCode(tok);
      if (res.ok) location.reload(); else showGate(res.message);
    });
    const joinToken = takeJoinToken();
    if (joinToken) {
      const res = await redeemOrCode(joinToken);
      if (!res.ok) { showGate(res.message); return; }
    }
    try {
      await loadIndex();
      // 문서가 하나도 안 보이면 코드가 없거나 틀린 것일 수 있다 (서버가 빈 목록을 돌려줌)
      if (!INDEX.pages.length && !(await checkAccess())) {
        showGate(getCode() ? '저장된 코드가 맞지 않거나 바뀌었어요. 새 코드를 입력해 주세요.' : '');
        return;
      }
    } catch (err) {
      show(`<h1 class="page-title">오류</h1><p>${esc(errText(err))}</p>
        <p class="muted"><code>assets/config.js</code> 의 Supabase 주소와 키, 그리고 <code>supabase/migrations</code> 적용 여부를 확인해 주세요.</p>`);
      return;
    }
    renderChrome();
    renderSide();
    window.addEventListener('hashchange', route);
    route();
    updateOffline();
    // 등록된 기기라면 마지막 접속 시각을 서버에 알린다 (세션당 한 번)
    try {
      if (store.get('wiki-device') && !sessionStorage.getItem('wiki-ping')) {
        sessionStorage.setItem('wiki-ping', '1');
        sb('rpc/check_access', { method: 'POST', body: {} }).catch(() => {});
      }
    } catch (e) {}
  }

  registerServiceWorker();
  init();
})();
