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

  const ERRORS = {
    conflict: '저장하는 사이에 다른 사람이 문서를 수정했습니다.',
    protected: '보호된 문서라 편집할 수 없습니다.',
    blocked: '편집이 차단된 IP입니다.',
    rate_limited: '짧은 시간에 너무 많이 저장했습니다. 잠시 뒤 다시 시도해 주세요.',
    no_change: '바뀐 내용이 없습니다.',
    invalid_title: '제목이 올바르지 않습니다. (1~100자, [ ] | # 와 줄바꿈 불가, / 로 시작하거나 끝날 수 없음)',
    invalid_content: '내용이 비어 있거나 너무 깁니다. (최대 10만 자)',
  };
  const errText = (err) =>
    ERRORS[err.code] || (err instanceof TypeError ? '서버에 연결할 수 없습니다. 잠시 뒤 다시 시도해 주세요.' : err.message || String(err));

  async function sb(path, { method = 'GET', body } = {}) {
    const res = await fetch(`${C.supabaseUrl}/rest/v1/${path}`, {
      method,
      headers: { apikey: C.supabaseKey, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
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

  /* ---------- 편집 ---------- */

  async function viewEdit(title, params) {
    const ok = guard();
    loading();
    const row = await api.get(title);
    const revParam = params.get('r');
    const old = row && revParam ? await api.revision(title, revParam) : null;
    if (!ok()) return;
    setTitle(`${title} 편집`);

    if (row && row.protected) {
      show(`<div class="doc-head"><h1>${esc(title)}</h1>${tabsHtml(title, 'edit')}</div><p class="notice">🔒 보호된 문서라 편집할 수 없습니다.</p>`);
      return;
    }

    const baseRev = row ? row.rev : 0;
    const initial = old ? old.content : row ? row.content : '---\ncategories: \n---\n\n## 개요\n\n';
    const defaultSummary = old ? `r${old.rev}(으)로 되돌림` : '';

    show(`
      <div class="doc-head"><h1>${esc(title)} <small>${row ? `편집 (r${row.rev} 기준)` : '새 문서'}</small></h1>${tabsHtml(title, 'edit')}</div>
      ${old ? `<p class="notice">r${old.rev} 판 내용을 불러왔습니다. 저장하면 이 내용으로 되돌립니다.</p>` : ''}
      <div class="editor">
        <div class="editor-tabs">
          <button type="button" class="active" data-pane="write">편집</button>
          <button type="button" data-pane="preview">미리보기</button>
          <a class="help" href="#/w/${enc('문법 도움말')}" target="_blank" rel="noopener">문법 도움말 ↗</a>
        </div>
        <textarea id="ed-text" spellcheck="false" aria-label="문서 내용"></textarea>
        <div id="ed-preview" class="preview" hidden></div>
        <div class="editor-fields">
          <label>닉네임 <input id="ed-author" maxlength="20" placeholder="익명"></label>
          <label class="grow">편집 요약 <input id="ed-summary" maxlength="200" placeholder="무엇을 고쳤는지 간단히"></label>
        </div>
        <p class="muted small">저장하면 편집 기록에 닉네임과 IP 일부(예: 1.2.*.*)가 남습니다.</p>
        <div id="ed-error" class="error" hidden></div>
        <div class="editor-actions">
          <button type="button" class="btn" id="ed-save">저장</button>
          <a class="btn secondary" href="${row ? docHref(title) : '#/'}">취소</a>
        </div>
      </div>`);

    const ta = $('#ed-text');
    ta.value = initial;
    $('#ed-author').value = store.get('wiki-nick');
    $('#ed-summary').value = defaultSummary;
    let dirty = false;
    ta.addEventListener('input', () => { dirty = true; });
    window.onbeforeunload = () => (dirty ? '저장하지 않은 내용이 있습니다.' : undefined);

    document.querySelectorAll('.editor-tabs button').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.editor-tabs button').forEach((b) => b.classList.toggle('active', b === btn));
        const preview = btn.dataset.pane === 'preview';
        ta.hidden = preview;
        $('#ed-preview').hidden = !preview;
        if (preview) renderBodyInto($('#ed-preview'), ta.value);
      });
    });

    const errBox = $('#ed-error');
    const saveBtn = $('#ed-save');
    saveBtn.addEventListener('click', async () => {
      errBox.hidden = true;
      saveBtn.disabled = true;
      saveBtn.textContent = '저장 중…';
      const author = $('#ed-author').value.trim();
      try {
        await api.edit({
          p_title: title,
          p_content: ta.value,
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
        errBox.innerHTML = esc(errText(err)) + (err.code === 'conflict'
          ? ` 작성한 내용을 복사해 둔 뒤 <a href="${docHref(title)}" target="_blank" rel="noopener">최신 문서</a>를 확인하고 다시 편집해 주세요.`
          : '');
        saveBtn.disabled = false;
        saveBtn.textContent = '저장';
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
    (s || '').replace(/[#>*_`|~]|\[\[|\]\]|\[\*/g, ' ').replace(/\s+/g, ' ').trim();

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
    store.set('wiki-theme', next);
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
      show(`<h1 class="page-title">오류</h1><p>${esc(errText(err))}</p>
        <p class="muted"><code>assets/config.js</code> 의 Supabase 주소와 키, 그리고 <code>supabase/migrations</code> 적용 여부를 확인해 주세요.</p>`);
      return;
    }
    renderChrome();
    renderSide();
    window.addEventListener('hashchange', route);
    route();
  }

  init();
})();
