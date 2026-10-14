/*
 * 위키 편집기 — 적용된 모습 그대로 편집하는 WYSIWYG (contenteditable) 편집기.
 * 저장 형식은 마크다운이며, [[문서 링크]] 와 [* 각주] 같은 위키 문법도 그대로 왕복 변환된다.
 * 의존: Turndown(+gfm 플러그인). 렌더링(마크다운 → 편집용 HTML)은 옵션 renderHtml 로 받는다.
 */
(() => {
  'use strict';

  const svg = (body) =>
    `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const ICON = {
    bold: svg('<path d="M7 5h6a3.5 3.5 0 010 7H7zM7 12h7.5a3.5 3.5 0 010 7H7z"/>'),
    italic: svg('<path d="M10 5h8M6 19h8M14.5 5l-5 14"/>'),
    strike: svg('<path d="M4 12h16M16.5 7C16 5.7 14.5 5 12.2 5 9.7 5 8 6.1 8 8c0 1.4.9 2.2 4 3M8 17c.6 1.2 2.2 2 4.4 2 2.5 0 4-1.1 4-3"/>'),
    code: svg('<path d="M8 8l-4 4 4 4M16 8l4 4-4 4"/>'),
    ul: svg('<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1" fill="currentColor"/><circle cx="4.5" cy="12" r="1" fill="currentColor"/><circle cx="4.5" cy="18" r="1" fill="currentColor"/>'),
    ol: svg('<path d="M10 6h10M10 12h10M10 18h10M4 4.5l1.5-1v5M3.5 13.5c0-1.2 2.5-1.2 2.5 0 0 1-2.5 1.7-2.5 2.7h2.7"/>'),
    quote: svg('<path d="M4 17v-4a5 5 0 015-5M13 17v-4a5 5 0 015-5"/><path d="M4 17h4v-4H4zM13 17h4v-4h-4z" fill="currentColor"/>'),
    link: svg('<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3A4 4 0 0011 18.7l1-1"/>'),
    note: svg('<path d="M5 19l6-9M11 19L5 10"/><path d="M15 8l2-1.5V13"/>'),
    image: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="M20 16l-5-5-8 8"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    table: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 10h17M3.5 15h17M9.5 4.5v15M15 4.5v15"/>'),
    hr: svg('<path d="M4 12h16"/>'),
    codeblock: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M9.5 10l-2 2 2 2M14.5 10l2 2-2 2"/>'),
    undo: svg('<path d="M9 8L4.5 12.5 9 17M5 12.5h9.5a5 5 0 010 10H12" transform="translate(0 -3)"/>'),
    redo: svg('<path d="M15 8l4.5 4.5L15 17M19 12.5H9.5a5 5 0 000 10H12" transform="translate(0 -3)"/>'),
    card: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2"/><path d="M5.5 16.5c.5-1.6 2-2.3 3.5-2.3s3 .7 3.5 2.3M14.5 10h3.5M14.5 13.5H17"/>'),
    chevron: svg('<path d="M6 9l6 6 6-6"/>'),
  };

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
  const MOD = IS_MAC ? '⌘' : 'Ctrl+';

  const PIPE = ''; // 표 칸 안의 | 를 잠시 바꿔 두는 글자

  /* ---------- 마크다운 변환 (HTML → 마크다운) ---------- */

  function makeTurndown() {
    const td = new TurndownService({
      headingStyle: 'atx',
      hr: '---',
      bulletListMarker: '-',
      codeBlockStyle: 'fenced',
      fence: '```',
      emDelimiter: '*',
      strongDelimiter: '**',
      br: '',
    });
    td.use(turndownPluginGfm.gfm);

    // 목록은 "- 항목" 형태로 (기본값은 "-   항목")
    td.addRule('wikiListItem', {
      filter: 'li',
      replacement(content, node, options) {
        let prefix = `${options.bulletListMarker} `;
        const parent = node.parentNode;
        if (parent && parent.nodeName === 'OL') {
          const start = parent.getAttribute('start');
          const idx = Array.prototype.indexOf.call(parent.children, node);
          prefix = `${start ? Number(start) + idx : idx + 1}. `;
        }
        content = content.replace(/^\n+/, '').replace(/\n+$/, '\n').replace(/\n/gm, `\n${' '.repeat(prefix.length)}`);
        return prefix + content + (node.nextSibling && !/\n$/.test(content) ? '\n' : '');
      },
    });

    td.addRule('wikiLink', {
      filter: (node) => node.nodeName === 'A' && node.classList.contains('wl'),
      replacement(content, node) {
        const dest = (node.getAttribute('data-wiki') || '').trim();
        // 표 칸 안에서는 | 를 \| 로 써야 하므로 자리 표시 글자(PIPE)로 대신 적어 둔다.
        const sep = node.closest('td, th') ? PIPE : '|';
        const label = node.textContent.replace(/[\u200b\[\]|\uE000]/g, '').replace(/\s+/g, ' ').trim();
        return `[[${label && label !== dest ? `${dest}${sep}${label}` : dest}]]`;
      },
    });

    td.addRule('wikiInfobox', {
      filter: (node) => node.nodeName === 'ASIDE' && node.classList.contains('infobox'),
      replacement: (content, node) => `\n\n:::infobox\n${(node.getAttribute('data-ib') || '').trim()}\n:::\n\n`,
    });

    td.addRule('wikiStrike', {
      filter: ['del', 's', 'strike'],
      replacement: (content) => `~~${content}~~`,
    });

    td.addRule('wikiFootnote', {
      filter: (node) => node.nodeName === 'SUP' && node.classList.contains('fnm'),
      replacement(content, node) {
        const text = (node.getAttribute('data-fn') || '').replace(/\s+/g, ' ').trim();
        return text ? `[* ${text}]` : '';
      },
    });

    return td;
  }

  /* 연속된 빈 줄을 하나로 줄인다. 코드 블록 안은 건드리지 않는다. */
  function collapseBlankLines(md) {
    const out = [];
    let fenced = false;
    let blank = 0;
    for (const line of md.split('\n')) {
      if (/^\s*```/.test(line)) fenced = !fenced;
      if (!fenced && line.trim() === '') {
        if (++blank > 1) continue;
      } else {
        blank = 0;
      }
      out.push(line);
    }
    return out.join('\n');
  }

  /* ---------- 편집기 ---------- */

  function create(mount, opts) {
    const td = makeTurndown();
    const listeners = [];
    const on = (target, type, fn, o) => {
      target.addEventListener(type, fn, o);
      listeners.push(() => target.removeEventListener(type, fn, o));
    };

    mount.innerHTML = `
      <div class="we">
        <div class="we-toolbar" role="toolbar" aria-label="서식 도구"></div>
        <div class="we-wrap">
          <div class="we-editor content" contenteditable="true" spellcheck="false" role="textbox" aria-multiline="true" aria-label="문서 내용" data-placeholder="내용을 입력하세요"></div>
          <textarea class="we-md" spellcheck="false" aria-label="마크다운 직접 편집" hidden></textarea>
          <div class="we-pop" hidden></div>
        </div>
      </div>`;
    const toolbar = mount.querySelector('.we-toolbar');
    const editorEl = mount.querySelector('.we-editor');
    const mdEl = mount.querySelector('.we-md');
    const pop = mount.querySelector('.we-pop');
    const wrap = mount.querySelector('.we-wrap');
    let mode = 'rich';
    let savedRange = null;

    const changed = () => opts.onChange && opts.onChange();

    /* --- 선택 영역 --- */
    const sel = () => window.getSelection();
    const inEditor = (node) => node && editorEl.contains(node.nodeType === 3 ? node.parentNode : node);
    const saveRange = () => {
      const s = sel();
      if (s.rangeCount && inEditor(s.anchorNode)) savedRange = s.getRangeAt(0).cloneRange();
    };
    const restoreRange = () => {
      if (document.activeElement === editorEl && inEditor(sel().anchorNode)) return;
      editorEl.focus();
      if (savedRange) {
        const s = sel();
        s.removeAllRanges();
        s.addRange(savedRange);
      }
    };
    const closest = (sel_) => {
      const s = sel();
      if (!s.rangeCount || !inEditor(s.anchorNode)) return null;
      const n = s.anchorNode.nodeType === 3 ? s.anchorNode.parentElement : s.anchorNode;
      return n.closest(sel_);
    };

    /* --- 편집 HTML 준비 --- */
    function ensureTrailingParagraph() {
      const last = editorEl.lastElementChild;
      if (!last || !/^(P|H[1-6])$/.test(last.tagName)) {
        const p = document.createElement('p');
        p.innerHTML = '<br>';
        editorEl.appendChild(p);
      }
    }

    function prepare() {
      fixNesting(editorEl);
      // Chrome 이 삽입 과정에서 만드는 스타일 span 을 정리한다 (고정폭 글꼴이면 코드로, 아니면 벗긴다)
      editorEl.querySelectorAll('span[style]').forEach((sp) => {
        if (/mono|consolas/i.test(sp.style.fontFamily)) {
          const code = document.createElement('code');
          code.append(...sp.childNodes);
          sp.replaceWith(code);
        } else {
          sp.replaceWith(...sp.childNodes);
        }
      });
      editorEl.querySelectorAll('aside.infobox').forEach((a) => {
        a.setAttribute('contenteditable', 'false');
        a.classList.add('ib-edit');
      });
      editorEl.querySelectorAll('sup.fnm').forEach((s) => {
        s.setAttribute('contenteditable', 'false');
        if (!s.textContent) s.textContent = '\u200b'; // 빈 요소는 변환 단계에서 버려지므로 보이지 않는 글자를 둔다
      });
      editorEl.querySelectorAll('a.wl').forEach((a) => a.classList.toggle('missing', !!opts.isMissing && opts.isMissing(a.getAttribute('data-wiki'))));
      if (!editorEl.firstElementChild) editorEl.innerHTML = '<p><br></p>';
      ensureTrailingParagraph();
    }

    /* --- 마크다운 입출력 --- */
    /* Chrome 이 목록·표 등을 <p> 안에 넣어 버리는 잘못된 중첩을 푼다 */
    function fixNesting(root) {
      root.querySelectorAll('p > ul, p > ol, p > table, p > pre, p > blockquote').forEach((el) => {
        const para = el.parentElement;
        para.replaceWith(...para.childNodes);
      });
    }

    /* 변환 전에 찌꺼기를 치운다: 글자가 없는 서식 요소는 벗기고, 빈 목록 항목은 지운다. */
    function cleanForMarkdown(root) {
      const isEmpty = (el) => !el.querySelector('img') && el.textContent.replace(/[\u200b\s]/g, '') === '';
      root.querySelectorAll('b, strong, i, em, s, strike, del, u, span, font, code').forEach((el) => {
        if (!el.closest('pre') && isEmpty(el)) el.replaceWith(...el.childNodes);
      });
      root.querySelectorAll('li').forEach((li) => {
        if (!li.querySelector('img, table, ul, ol, sup.fnm') && isEmpty(li)) li.remove();
      });
      root.querySelectorAll('ul, ol').forEach((l) => { if (!l.children.length) l.remove(); });
      // 표 칸 안의 줄바꿈·문단은 마크다운 표를 깨므로 공백으로 바꾼다
      root.querySelectorAll('td br, th br').forEach((br) => br.replaceWith(' '));
      root.querySelectorAll('td p, th p, td div, th div').forEach((el) => el.replaceWith(...el.childNodes, ' '));
      // Chrome 이 만드는 잘못된 중첩(<p><ul>, <ul><ul>, <li><ul> 만 있는 항목)을 바로잡는다
      fixNesting(root);
      root.querySelectorAll('ul > ul, ul > ol, ol > ul, ol > ol').forEach((l) => {
        const prev = l.previousElementSibling;
        if (prev && prev.tagName === 'LI') prev.appendChild(l);
      });
      root.querySelectorAll('li').forEach((li) => {
        const only = li.children.length === 1 && li.childNodes.length === 1 && /^(UL|OL)$/.test(li.firstElementChild.tagName);
        const prev = li.previousElementSibling;
        if (only && prev && prev.tagName === 'LI') { prev.appendChild(li.firstElementChild); li.remove(); }
      });
    }

    function toMarkdown() {
      const clone = editorEl.cloneNode(true);
      cleanForMarkdown(clone);
      clone.querySelectorAll('td, th').forEach((cell) => {
        const w = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = w.nextNode())) n.nodeValue = n.nodeValue.replace(/\|/g, PIPE);
      });
      let md = td.turndown(clone);
      md = md.replace(/\u200b/g, '').replace(/\u00a0/g, ' ');
      md = md.split(PIPE).join('\\|');
      return collapseBlankLines(md).trim() + '\n';
    }

    function setMarkdown(md) {
      editorEl.innerHTML = opts.renderHtml(md);
      prepare();
    }

    const getMarkdown = () => (mode === 'md' ? mdEl.value.replace(/\r\n?/g, '\n').trim() + '\n' : toMarkdown());

    /* --- 명령 실행 --- */
    function exec(cmd, val) {
      if (mode !== 'rich') return;
      restoreRange();
      document.execCommand(cmd, false, val);
      saveRange();
      changed();
      refreshState();
    }

    /* 현재 줄 안에서 커서가 몇 번째 글자인지 (목록 명령 뒤에 Chrome 이 커서를 줄 맨 앞으로 되돌리는 것을 막기 위해) */
    const blockOf = (node) => (node.nodeType === 3 ? node.parentElement : node).closest('li, p, h1, h2, h3, h4, h5, h6, blockquote, pre');
    function caretOffset() {
      const s = sel();
      if (!s.rangeCount || !s.isCollapsed || !inEditor(s.anchorNode)) return null;
      const blk = blockOf(s.anchorNode);
      if (!blk) return null;
      const r = document.createRange();
      r.selectNodeContents(blk);
      r.setEnd(s.anchorNode, s.anchorOffset);
      return r.toString().length;
    }
    function setCaretAt(blk, off) {
      const r = document.createRange();
      const w = document.createTreeWalker(blk, NodeFilter.SHOW_TEXT);
      let n;
      let acc = 0;
      while ((n = w.nextNode())) {
        if (acc + n.nodeValue.length >= off) { r.setStart(n, off - acc); r.collapse(true); break; }
        acc += n.nodeValue.length;
      }
      if (!n) { r.selectNodeContents(blk); r.collapse(false); }
      sel().removeAllRanges();
      sel().addRange(r);
      saveRange();
    }
    function execKeepCaret(cmd) {
      if (mode !== 'rich') return;
      restoreRange();
      const off = caretOffset();
      document.execCommand(cmd, false);
      const s = sel();
      const blk = s.rangeCount && inEditor(s.anchorNode) ? blockOf(s.anchorNode) : null;
      fixNesting(editorEl);
      if (off !== null && blk && blk.isConnected) setCaretAt(blk, off);
      saveRange();
      changed();
      refreshState();
    }

    function insertHtml(html) {
      if (mode !== 'rich') return;
      restoreRange();
      document.execCommand('insertHTML', false, html);
      saveRange();
      prepare();
      changed();
      refreshState();
    }

    function setBlock(tag) {
      const cur = closest('h1,h2,h3,h4,h5,h6,blockquote');
      const same = cur && cur.tagName.toLowerCase() === tag;
      exec('formatBlock', same ? 'p' : tag);
    }

    function selectContents(node) {
      const r = document.createRange();
      r.selectNodeContents(node);
      sel().removeAllRanges();
      sel().addRange(r);
      saveRange();
    }

    /* 커서를 node 바로 뒤로 옮긴다 (보이지 않는 글자를 하나 두어 그 자리에서 이어 쓸 수 있게 한다) */
    function caretAfter(node) {
      const after = document.createTextNode('\u200b');
      node.after(after);
      const r = document.createRange();
      r.setStart(after, 1);
      r.collapse(true);
      sel().removeAllRanges();
      sel().addRange(r);
      saveRange();
    }

    /* Chrome 의 insertHTML 은 <code> 를 스타일 span 으로 바꿔 버리므로 코드는 DOM 에 직접 넣는다. */
    function toggleInlineCode() {
      restoreRange();
      const s = sel();
      if (!s.rangeCount) return;
      const existing = closest('code');
      if (existing && !existing.closest('pre')) {
        if (s.toString()) existing.replaceWith(document.createTextNode(existing.textContent)); // 코드 풀기
        else caretAfter(existing); // 커서만 있으면 코드 밖으로 나가기
      } else {
        const r = s.getRangeAt(0);
        const code = document.createElement('code');
        if (r.collapsed) {
          code.textContent = '\u200b';
          r.insertNode(code);
          const caret = document.createRange();
          caret.setStart(code.firstChild, 1);
          caret.collapse(true);
          s.removeAllRanges();
          s.addRange(caret);
          saveRange();
        } else {
          code.appendChild(r.extractContents());
          r.insertNode(code);
          caretAfter(code);
        }
      }
      changed();
      refreshState();
    }

    function insertTable() {
      const cell = (tag) => `<${tag}><br></${tag}>`;
      const row = (tag) => `<tr>${cell(tag)}${cell(tag)}${cell(tag)}</tr>`;
      insertHtml(`<table data-new="1"><thead>${row('th')}</thead><tbody>${row('td')}${row('td')}</tbody></table><p><br></p>`);
      const table = editorEl.querySelector('table[data-new]');
      if (table) {
        table.removeAttribute('data-new');
        placeCaret(table.querySelector('th'));
        saveRange();
        refreshState();
      }
    }

    function insertCodeBlock() {
      insertHtml('<pre data-new="1"><code>코드</code></pre><p><br></p>');
      const pre = editorEl.querySelector('pre[data-new]');
      if (!pre) return;
      pre.removeAttribute('data-new');
      const r = document.createRange();
      r.selectNodeContents(pre.querySelector('code'));
      sel().removeAllRanges();
      sel().addRange(r);
      saveRange();
    }

    /* --- 상태 반영 (툴바 활성 표시, 제목 단계 라벨) --- */
    const headingLabel = (tag) => ({ H2: '제목 1', H3: '제목 2', H4: '제목 3', H5: '제목 4', H6: '제목 5', H1: '제목 1' }[tag] || '본문');
    function refreshState() {
      if (mode !== 'rich') return;
      const q = (c) => { try { return document.queryCommandState(c); } catch (e) { return false; } };
      const set = (name, on) => { const b = toolbar.querySelector(`[data-cmd="${name}"]`); if (b) b.classList.toggle('on', !!on); };
      const inFocus = inEditor(sel().anchorNode);
      const heading = inFocus && closest('h1,h2,h3,h4,h5,h6');
      set('bold', inFocus && !heading && q('bold')); // 제목은 원래 굵으므로 표시하지 않는다
      set('italic', inFocus && q('italic'));
      set('strike', inFocus && q('strikeThrough'));
      set('code', inFocus && closest('code') && !closest('pre'));
      set('ul', inFocus && q('insertUnorderedList'));
      set('ol', inFocus && q('insertOrderedList'));
      set('quote', inFocus && closest('blockquote'));
      const h = heading;
      const label = toolbar.querySelector('.we-heading-label');
      if (label) label.textContent = h ? headingLabel(h.tagName) : '본문';
      updateTablePop();
    }

    /* --- 툴바 구성 --- */
    const BTN = [
      { cmd: 'bold', icon: ICON.bold, title: `굵게 (${MOD}B)`, run: () => exec('bold') },
      { cmd: 'italic', icon: ICON.italic, title: `기울임 (${MOD}I)`, run: () => exec('italic') },
      { cmd: 'strike', icon: ICON.strike, title: `취소선 (${MOD}Shift+X)`, run: () => exec('strikeThrough') },
      { cmd: 'code', icon: ICON.code, title: '코드', run: toggleInlineCode },
      '|',
      { cmd: 'ul', icon: ICON.ul, title: '글머리 목록', run: () => execKeepCaret('insertUnorderedList') },
      { cmd: 'ol', icon: ICON.ol, title: '번호 목록', run: () => execKeepCaret('insertOrderedList') },
      { cmd: 'quote', icon: ICON.quote, title: '인용문', run: () => setBlock('blockquote') },
      '|',
      { cmd: 'link', icon: ICON.link, title: `링크 (${MOD}K)`, run: () => openLinkDialog() },
      { cmd: 'note', icon: ICON.note, title: `각주 (${MOD}Shift+F)`, run: () => insertFootnote() },
      { cmd: 'image', icon: ICON.image, title: '이미지', run: () => openImageDialog() },
    ];

    function buildToolbar() {
      const left = BTN.map((b) =>
        b === '|'
          ? '<span class="we-sep"></span>'
          : `<button type="button" class="we-btn" data-cmd="${b.cmd}" title="${esc(b.title)}" aria-label="${esc(b.title)}">${b.icon}</button>`
      ).join('');
      toolbar.innerHTML = `
        <div class="we-group we-left">
          <div class="we-menu">
            <button type="button" class="we-btn we-drop" data-menu="heading" title="문단 모양" aria-haspopup="true"><span class="we-heading-label">본문</span>${ICON.chevron}</button>
            <div class="we-menu-list" data-for="heading" hidden>
              <button type="button" data-block="p">본문</button>
              <button type="button" data-block="h2" class="h-1">제목 1</button>
              <button type="button" data-block="h3" class="h-2">제목 2</button>
              <button type="button" data-block="h4" class="h-3">제목 3</button>
            </div>
          </div>
          <span class="we-sep"></span>
          ${left}
          <div class="we-menu">
            <button type="button" class="we-btn we-drop" data-menu="insert" title="더 넣기" aria-haspopup="true">${ICON.plus}<span>삽입</span></button>
            <div class="we-menu-list" data-for="insert" hidden>
              <button type="button" data-insert="infobox">${ICON.card}<span>프로필 상자</span></button>
              <button type="button" data-insert="table">${ICON.table}<span>표</span></button>
              <button type="button" data-insert="hr">${ICON.hr}<span>구분선</span></button>
              <button type="button" data-insert="codeblock">${ICON.codeblock}<span>코드 블록</span></button>
            </div>
          </div>
        </div>
        <div class="we-group we-right">
          <button type="button" class="we-btn" data-cmd="undo" title="실행 취소 (${MOD}Z)" aria-label="실행 취소">${ICON.undo}</button>
          <button type="button" class="we-btn" data-cmd="redo" title="다시 실행 (${MOD}Shift+Z)" aria-label="다시 실행">${ICON.redo}</button>
          <span class="we-sep"></span>
          <button type="button" class="we-mode" data-mode title="마크다운 문법으로 직접 편집">마크다운</button>
        </div>`;
    }
    buildToolbar();

    /* 툴바 버튼은 포커스를 뺏지 않게 mousedown 을 막는다 (선택 영역 유지) */
    on(toolbar, 'mousedown', (e) => {
      if (e.target.closest('button') && !e.target.closest('[data-mode]')) e.preventDefault();
    });

    function closeMenus() {
      toolbar.querySelectorAll('.we-menu-list').forEach((m) => { m.hidden = true; });
    }

    /* 툴바는 모바일에서 가로로 스크롤되어 안쪽 요소가 잘리므로, 메뉴는 화면 기준(fixed)으로 버튼 아래에 띄운다. */
    let menuOpenedAt = 0;
    function placeMenu(btn, list) {
      menuOpenedAt = performance.now();
      const r = btn.getBoundingClientRect();
      list.style.top = `${r.bottom + 4}px`;
      list.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - list.offsetWidth - 8))}px`;
    }

    on(toolbar, 'click', (e) => {
      const btn = e.target.closest('button');
      if (!btn || btn.disabled) return;
      if (btn.dataset.menu) {
        const list = toolbar.querySelector(`.we-menu-list[data-for="${btn.dataset.menu}"]`);
        const open = list.hidden;
        closeMenus();
        if (open) {
          list.hidden = false;
          placeMenu(btn, list);
        }
        return;
      }
      if (btn.dataset.block) { closeMenus(); btn.dataset.block === 'p' ? exec('formatBlock', 'p') : setBlock(btn.dataset.block); return; }
      if (btn.dataset.insert) {
        closeMenus();
        const k = btn.dataset.insert;
        if (k === 'infobox') openInfoboxDialog();
        else if (k === 'table') insertTable();
        else if (k === 'hr') exec('insertHorizontalRule');
        else if (k === 'codeblock') insertCodeBlock();
        return;
      }
      if (btn.dataset.mode !== undefined) { setMode(mode === 'rich' ? 'md' : 'rich'); return; }
      const def = BTN.find((b) => b !== '|' && b.cmd === btn.dataset.cmd);
      if (def) { closeMenus(); def.run(); return; }
      if (btn.dataset.cmd === 'undo') exec('undo');
      if (btn.dataset.cmd === 'redo') exec('redo');
    });
    on(document, 'click', (e) => { if (!e.target.closest('.we-menu')) closeMenus(); });
    // 화면이 움직이면 버튼과 메뉴 위치가 어긋나므로 닫는다
    // (버튼이 화면 안으로 자동 스크롤되며 생기는, 메뉴를 연 직후의 스크롤은 무시한다)
    const closeOnScroll = () => { if (performance.now() - menuOpenedAt > 400) closeMenus(); };
    on(window, 'scroll', closeOnScroll, { passive: true });
    on(window, 'resize', closeMenus);
    on(toolbar, 'scroll', closeOnScroll, { passive: true });
    on(document, 'keydown', (e) => { if (e.key === 'Escape') closeMenus(); });

    /* --- 모드 전환 (편집기 ↔ 마크다운) --- */
    function setMode(next) {
      if (next === mode) return;
      hidePop();
      if (next === 'md') {
        mdEl.value = toMarkdown();
        editorEl.hidden = true;
        mdEl.hidden = false;
        mode = 'md';
        mdEl.focus();
      } else {
        setMarkdown(mdEl.value);
        mdEl.hidden = true;
        editorEl.hidden = false;
        mode = 'rich';
        editorEl.focus();
      }
      mount.querySelector('.we').classList.toggle('md-mode', mode === 'md');
      const mb = toolbar.querySelector('[data-mode]');
      mb.classList.toggle('on', mode === 'md');
      mb.textContent = mode === 'md' ? '← 편집기로' : '마크다운';
      mb.title = mode === 'md' ? '일반 편집기로 돌아가기' : '마크다운 문법으로 직접 편집';
      toolbar.classList.toggle('disabled', mode === 'md');
      changed();
    }
    on(mdEl, 'input', changed);

    /* --- 작은 창 (popover) --- */
    function hidePop() {
      pop.hidden = true;
      pop.innerHTML = '';
      pop.className = 'we-pop';
      pop._node = null;
    }
    function placePop(target) {
      const wr = wrap.getBoundingClientRect();
      const tr = target.getBoundingClientRect();
      pop.hidden = false;
      const left = Math.max(0, Math.min(tr.left - wr.left, wr.width - pop.offsetWidth));
      pop.style.left = `${left}px`;
      pop.style.top = `${tr.bottom - wr.top + 6}px`;
    }

    function showLinkPop(a) {
      const isWiki = a.classList.contains('wl');
      const dest = isWiki ? a.getAttribute('data-wiki') : a.getAttribute('href');
      pop.className = 'we-pop';
      pop.innerHTML = `
        <span class="we-pop-label" title="${esc(dest)}">${esc(dest.length > 40 ? `${dest.slice(0, 40)}…` : dest)}</span>
        <button type="button" data-act="edit">변경</button>
        <button type="button" data-act="unlink">해제</button>`;
      pop._node = a;
      placePop(a);
    }

    function showNotePop(sup, isNew) {
      pop.className = 'we-pop we-pop-note';
      pop.innerHTML = `
        <label class="we-pop-title">각주 내용</label>
        <textarea rows="3" maxlength="500" placeholder="각주로 달 내용을 적어 주세요"></textarea>
        <div class="we-pop-actions">
          <button type="button" data-act="note-del">삭제</button>
          <span class="grow"></span>
          <button type="button" data-act="note-ok" class="primary">확인</button>
        </div>`;
      const ta = pop.querySelector('textarea');
      ta.value = sup.getAttribute('data-fn') || '';
      pop._node = sup;
      pop._isNew = !!isNew;
      placePop(sup);
      ta.focus();
    }

    function finishNote(save) {
      const sup = pop._node;
      if (!sup) return;
      const text = pop.querySelector('textarea').value.replace(/\s+/g, ' ').trim();
      if (save && text) sup.setAttribute('data-fn', text);
      else if (!text || !save) {
        if (pop._isNew || !text) sup.remove();
      }
      hidePop();
      changed();
      restoreRange();
    }

    function updateTablePop() {
      const cell = closest('td,th');
      if (!cell) {
        if (pop.classList.contains('we-pop-table')) hidePop();
        return;
      }
      if (!pop.hidden && !pop.classList.contains('we-pop-table')) return;
      pop.className = 'we-pop we-pop-table';
      pop.innerHTML = `
        <button type="button" data-act="row-add">＋ 행</button>
        <button type="button" data-act="col-add">＋ 열</button>
        <button type="button" data-act="row-del">− 행</button>
        <button type="button" data-act="col-del">− 열</button>
        <button type="button" data-act="table-del" class="danger">표 삭제</button>`;
      pop._node = cell;
      placePop(cell.closest('table'));
      pop.style.top = `${cell.closest('table').getBoundingClientRect().top - wrap.getBoundingClientRect().top - pop.offsetHeight - 6}px`;
    }

    function tableAction(act) {
      const cell = pop._node && pop._node.closest ? pop._node : closest('td,th');
      if (!cell) return;
      const table = cell.closest('table');
      const row = cell.parentElement;
      const rows = [...table.rows];
      const colIdx = cell.cellIndex;
      const blankCell = (tag) => { const c = document.createElement(tag); c.innerHTML = '<br>'; return c; };
      if (act === 'row-add') {
        const body = table.tBodies[0] || table;
        const nr = document.createElement('tr');
        for (let i = 0; i < row.cells.length; i++) nr.appendChild(blankCell('td'));
        if (row.parentElement.tagName === 'THEAD') body.insertBefore(nr, body.firstChild);
        else row.after(nr);
      } else if (act === 'col-add') {
        rows.forEach((r) => r.cells[colIdx].after(blankCell(r.parentElement.tagName === 'THEAD' || r.cells[colIdx].tagName === 'TH' ? 'th' : 'td')));
      } else if (act === 'row-del') {
        if (row.parentElement.tagName === 'THEAD' || rows.length <= 2) return;
        row.remove();
      } else if (act === 'col-del') {
        if (row.cells.length <= 1) return;
        rows.forEach((r) => r.cells[Math.min(colIdx, r.cells.length - 1)].remove());
      } else if (act === 'table-del') {
        table.remove();
      }
      hidePop();
      prepare();
      changed();
    }

    on(pop, 'mousedown', (e) => {
      if (!e.target.closest('textarea, input')) e.preventDefault();
    });
    on(pop, 'click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'note-ok') finishNote(true);
      else if (act === 'note-del') { pop._node.remove(); hidePop(); changed(); restoreRange(); }
      else if (act === 'unlink') {
        const a = pop._node;
        a.replaceWith(document.createTextNode(a.textContent));
        hidePop();
        changed();
      } else if (act === 'edit') openLinkDialog(pop._node);
      else if (act) tableAction(act);
    });
    on(pop, 'keydown', (e) => {
      if (e.target.tagName === 'TEXTAREA' && (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); finishNote(true); }
      if (e.key === 'Escape') { e.preventDefault(); if (pop.classList.contains('we-pop-note')) finishNote(true); else hidePop(); }
    });

    /* --- 대화상자 --- */
    function openDialog(html, onMount) {
      const overlay = document.createElement('div');
      overlay.className = 'we-overlay';
      overlay.innerHTML = `<div class="we-dialog" role="dialog" aria-modal="true">${html}</div>`;
      document.body.appendChild(overlay);
      const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true); };
      const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); restoreRange(); } };
      document.addEventListener('keydown', onKey, true);
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) { close(); restoreRange(); } });
      overlay.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => { close(); restoreRange(); }));
      onMount(overlay.querySelector('.we-dialog'), close);
      return close;
    }

    function openLinkDialog(existing) {
      saveRange();
      const selectedText = existing ? existing.textContent : sel().toString().trim();
      const isWiki = existing ? existing.classList.contains('wl') : true;
      const cur = existing ? (isWiki ? existing.getAttribute('data-wiki') : existing.getAttribute('href')) : '';
      openDialog(`
        <h3>링크</h3>
        <div class="we-tabs">
          <button type="button" data-tab="wiki" class="on">위키 문서</button>
          <button type="button" data-tab="web">웹 주소</button>
        </div>
        <div class="we-field" data-pane="wiki">
          <label>연결할 문서</label>
          <input type="text" id="lk-wiki" placeholder="문서 제목을 검색하세요" autocomplete="off">
          <ul class="we-suggest" id="lk-suggest" hidden></ul>
        </div>
        <div class="we-field" data-pane="web" hidden>
          <label>주소</label>
          <input type="url" id="lk-web" placeholder="https://">
        </div>
        <div class="we-field">
          <label>표시할 글자 <small>(비우면 그대로 표시)</small></label>
          <input type="text" id="lk-text" placeholder="링크로 보일 글자">
        </div>
        <div class="we-dialog-actions"><button type="button" data-close>취소</button><button type="button" class="primary" id="lk-ok">확인</button></div>`,
      (dlg, close) => {
        const wikiIn = dlg.querySelector('#lk-wiki');
        const webIn = dlg.querySelector('#lk-web');
        const textIn = dlg.querySelector('#lk-text');
        const list = dlg.querySelector('#lk-suggest');
        let tab = isWiki ? 'wiki' : 'web';
        const setTab = (t) => {
          tab = t;
          dlg.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
          dlg.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== t; });
          (t === 'wiki' ? wikiIn : webIn).focus();
        };
        dlg.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
        if (isWiki) wikiIn.value = cur; else webIn.value = cur;
        const dflt = isWiki ? cur : '';
        textIn.value = selectedText && selectedText !== dflt ? selectedText : '';
        setTab(tab);

        let active = -1;
        const renderSuggest = () => {
          const q = wikiIn.value.trim().toLowerCase();
          const titles = (opts.titles ? opts.titles() : []);
          const hit = q ? [...titles.filter((t) => t.toLowerCase().startsWith(q)), ...titles.filter((t) => !t.toLowerCase().startsWith(q) && t.toLowerCase().includes(q))].slice(0, 6) : [];
          const exact = titles.includes(wikiIn.value.trim());
          list.innerHTML = hit.map((t) => `<li><button type="button" data-t="${esc(t)}">${esc(t)}</button></li>`).join('') +
            (q && !exact ? `<li class="new"><button type="button" data-t="${esc(wikiIn.value.trim())}">‘${esc(wikiIn.value.trim())}’ 새 문서로 연결</button></li>` : '');
          list.hidden = !list.innerHTML;
          active = -1;
        };
        wikiIn.addEventListener('input', renderSuggest);
        list.addEventListener('mousedown', (e) => e.preventDefault());
        list.addEventListener('click', (e) => {
          const b = e.target.closest('button');
          if (b) { wikiIn.value = b.dataset.t; list.hidden = true; textIn.focus(); }
        });
        wikiIn.addEventListener('keydown', (e) => {
          const items = [...list.querySelectorAll('button')];
          if (!items.length || list.hidden) return;
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
            items.forEach((b, i) => b.parentElement.classList.toggle('active', i === active));
          } else if (e.key === 'Enter' && active >= 0) {
            e.preventDefault();
            e.stopPropagation();
            wikiIn.value = items[active].dataset.t;
            list.hidden = true;
          }
        });

        const submit = () => {
          const text = textIn.value.trim();
          if (tab === 'wiki') {
            const dest = wikiIn.value.replace(/[\[\]|\n\r]/g, '').trim();
            if (!dest) { wikiIn.focus(); return; }
            applyLink(existing, { wiki: dest, text: text || dest });
          } else {
            let url = webIn.value.trim();
            if (!url) { webIn.focus(); return; }
            if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
            applyLink(existing, { href: url, text: text || selectedText || url });
          }
          close();
        };
        dlg.querySelector('#lk-ok').addEventListener('click', submit);
        dlg.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); submit(); } });
      });
    }

    function applyLink(existing, { wiki, href, text }) {
      const el = document.createElement('a');
      if (wiki) {
        el.className = 'wl';
        el.setAttribute('data-wiki', wiki);
      } else {
        el.setAttribute('href', href);
      }
      el.textContent = text;
      if (existing) {
        existing.replaceWith(el);
        prepare();
        hidePop();
        changed();
        return;
      }
      restoreRange();
      insertHtml(`${el.outerHTML}&#8203;`);
    }

    /* 프로필 상자: 새로 만들거나(existing 없음) 기존 상자를 고친다 */
    function openInfoboxDialog(existing) {
      saveRange();
      const I = window.WikiInfobox;
      const data = existing ? I.parse(existing.getAttribute('data-ib') || '') : { title: '', image: '', caption: '', rows: I.presetRows('person') };
      let rows = data.rows.map((r) => ({ ...r }));
      openDialog(`
        <h3>프로필 상자</h3>
        ${existing ? '' : `<div class="we-field"><label>양식</label>
          <select id="ib-preset">${Object.entries(I.PRESETS).map(([k, v]) => `<option value="${k}">${esc(v.name)}</option>`).join('')}</select></div>`}
        <div class="we-field"><label>제목 <small>(이름)</small></label><input type="text" id="ib-title" maxlength="60" placeholder="문서 제목과 같게 써도 좋아요"></div>
        <div class="we-field"><label>사진 주소 <small>(선택, https://…)</small></label><input type="url" id="ib-image" placeholder="https://"></div>
        <div class="we-field"><label>사진 설명 <small>(선택)</small></label><input type="text" id="ib-caption" maxlength="80"></div>
        <div class="we-field"><label>항목 <small>(내용에는 [[문서 링크]] 를 쓸 수 있어요)</small></label><div class="ib-rows" id="ib-rows"></div>
          <div class="ib-add"><button type="button" id="ib-add-row">＋ 항목</button><button type="button" id="ib-add-head">＋ 구분 제목</button></div></div>
        <div class="we-dialog-actions">
          ${existing ? '<button type="button" class="danger" id="ib-del">상자 삭제</button><span class="grow"></span>' : ''}
          <button type="button" data-close>취소</button><button type="button" class="primary" id="ib-ok">확인</button>
        </div>`,
      (dlg, close) => {
        dlg.classList.add('wide');
        const list = dlg.querySelector('#ib-rows');
        const q = (id) => dlg.querySelector(id);
        q('#ib-title').value = data.title;
        q('#ib-image').value = data.image;
        q('#ib-caption').value = data.caption;

        const ctl = '<span class="ib-ctl"><button type="button" data-a="up" title="위로" aria-label="위로">↑</button><button type="button" data-a="down" title="아래로" aria-label="아래로">↓</button><button type="button" data-a="del" title="삭제" aria-label="삭제">✕</button></span>';
        const render = () => {
          list.innerHTML = rows.map((r, i) => r.type === 'head'
            ? `<div class="ib-row ib-head-row" data-i="${i}"><input data-f="label" value="${esc(r.label)}" placeholder="구분 제목" aria-label="구분 제목">${ctl}</div>`
            : `<div class="ib-row" data-i="${i}"><input class="ib-l" data-f="label" value="${esc(r.label)}" placeholder="항목" aria-label="항목 이름"><input class="ib-v" data-f="value" value="${esc(r.value)}" placeholder="내용" aria-label="항목 내용">${ctl}</div>`).join('');
        };
        render();
        list.addEventListener('input', (e) => {
          const row = e.target.closest('.ib-row');
          if (row && e.target.dataset.f) rows[+row.dataset.i][e.target.dataset.f] = e.target.value;
        });
        list.addEventListener('click', (e) => {
          const b = e.target.closest('button[data-a]');
          if (!b) return;
          const i = +b.closest('.ib-row').dataset.i;
          if (b.dataset.a === 'del') rows.splice(i, 1);
          else if (b.dataset.a === 'up' && i > 0) [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]];
          else if (b.dataset.a === 'down' && i < rows.length - 1) [rows[i + 1], rows[i]] = [rows[i], rows[i + 1]];
          render();
        });
        const add = (type) => {
          rows.push({ type, label: '', value: '' });
          render();
          const last = list.querySelector('.ib-row:last-child input');
          if (last) last.focus();
        };
        q('#ib-add-row').addEventListener('click', () => add('row'));
        q('#ib-add-head').addEventListener('click', () => add('head'));
        const preset = q('#ib-preset');
        if (preset) preset.addEventListener('change', () => { rows = I.presetRows(preset.value); render(); });
        q('#ib-title').focus();

        const del = q('#ib-del');
        if (del) del.addEventListener('click', () => { existing.remove(); prepare(); changed(); close(); });

        q('#ib-ok').addEventListener('click', () => {
          const image = q('#ib-image').value.trim();
          if (image && !/^https?:\/\//i.test(image)) { q('#ib-image').classList.add('bad'); q('#ib-image').focus(); return; }
          const src = I.serialize({ title: q('#ib-title').value, image, caption: q('#ib-caption').value, rows });
          if (!src) { if (existing) { existing.remove(); prepare(); changed(); } close(); return; }
          const tpl = document.createElement('template');
          tpl.innerHTML = opts.renderHtml(`:::infobox\n${src}\n:::`);
          const node = tpl.content.querySelector('aside.infobox');
          if (!node) return;
          if (existing) existing.replaceWith(node);
          else editorEl.insertBefore(node, editorEl.firstChild); // 프로필 상자는 문서 맨 위(오른쪽)에 둔다
          close();
          prepare();
          changed();
        });
      });
    }

    function openImageDialog() {
      saveRange();
      openDialog(`
        <h3>이미지</h3>
        <div class="we-field"><label>이미지 주소</label><input type="url" id="im-src" placeholder="https://"></div>
        <div class="we-field"><label>설명 <small>(선택)</small></label><input type="text" id="im-alt" placeholder="이미지 설명"></div>
        <div class="we-dialog-actions"><button type="button" data-close>취소</button><button type="button" class="primary" id="im-ok">확인</button></div>`,
      (dlg, close) => {
        const src = dlg.querySelector('#im-src');
        src.focus();
        const submit = () => {
          const url = src.value.trim();
          if (!/^https?:\/\//i.test(url)) { src.focus(); src.classList.add('bad'); return; }
          const alt = dlg.querySelector('#im-alt').value.trim();
          close();
          restoreRange();
          insertHtml(`<img src="${esc(url)}" alt="${esc(alt)}">`);
        };
        dlg.querySelector('#im-ok').addEventListener('click', submit);
        dlg.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); submit(); } });
      });
    }

    function insertFootnote() {
      if (mode !== 'rich') return;
      saveRange();
      restoreRange();
      const s = sel();
      if (!s.rangeCount) return;
      // Chrome 의 insertHTML 은 편집 불가 요소를 문단 밖으로 빼 버리므로 DOM 에 직접 넣는다.
      const r = s.getRangeAt(0);
      r.collapse(false);
      const sup = document.createElement('sup');
      sup.className = 'fnm';
      sup.setAttribute('data-fn', '');
      sup.setAttribute('contenteditable', 'false');
      sup.textContent = '\u200b';
      r.insertNode(sup);
      caretAfter(sup);
      showNotePop(sup, true);
      changed();
    }

    /* --- 입력 이벤트 --- */
    on(editorEl, 'input', () => {
      if (editorEl.innerHTML === '' || editorEl.innerHTML === '<br>') editorEl.innerHTML = '<p><br></p>';
      changed();
    });
    on(editorEl, 'focus', () => { try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (e) {} });
    on(document, 'selectionchange', () => { if (inEditor(sel().anchorNode)) { saveRange(); refreshState(); } });

    on(editorEl, 'click', (e) => {
      const box = e.target.closest('aside.infobox');
      if (box) { e.preventDefault(); openInfoboxDialog(box); return; }
      const sup = e.target.closest('sup.fnm');
      if (sup) { showNotePop(sup, false); return; }
      const a = e.target.closest('a');
      if (a && (a.classList.contains('wl') || a.getAttribute('href'))) { e.preventDefault(); showLinkPop(a); return; }
      if (!closest('td,th')) hidePop();
    });

    on(editorEl, 'keydown', (e) => {
      const mod = IS_MAC ? e.metaKey : e.ctrlKey;
      if (mod && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); openLinkDialog(); return; }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); insertFootnote(); return; }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'x') { e.preventDefault(); exec('strikeThrough'); return; }
      if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'u') { e.preventDefault(); return; }
      if (mod && e.altKey && /^Digit[0234]$/.test(e.code)) {
        e.preventDefault();
        const tag = { Digit0: 'p', Digit2: 'h2', Digit3: 'h3', Digit4: 'h4' }[e.code];
        tag === 'p' ? exec('formatBlock', 'p') : setBlock(tag);
        return;
      }
      if (e.key === 'Enter' && !e.isComposing) {
        const cell = closest('td,th');
        if (cell) {
          e.preventDefault();
          const row = cell.parentElement;
          const idx = cell.cellIndex;
          let next = row.nextElementSibling || (row.parentElement.tagName === 'THEAD' && row.parentElement.nextElementSibling ? row.parentElement.nextElementSibling.firstElementChild : null);
          if (!next) { pop._node = cell; tableAction('row-add'); next = cell.closest('tr').nextElementSibling; }
          if (next && next.cells[idx]) placeCaret(next.cells[idx]);
          return;
        }
      }
      if (e.key === 'Tab') {
        const cell = closest('td,th');
        if (cell) {
          e.preventDefault();
          const cells = [...cell.closest('table').querySelectorAll('th,td')];
          const i = cells.indexOf(cell) + (e.shiftKey ? -1 : 1);
          if (i >= cells.length) { pop._node = cell; tableAction('row-add'); const c2 = [...cell.closest('table').querySelectorAll('th,td')]; placeCaret(c2[i]); }
          else if (i >= 0) placeCaret(cells[i]);
          return;
        }
        if (closest('li')) { e.preventDefault(); execKeepCaret(e.shiftKey ? 'outdent' : 'indent'); }
      }
    });

    function placeCaret(node) {
      if (!node) return;
      const r = document.createRange();
      r.selectNodeContents(node);
      r.collapse(false);
      const s = sel();
      s.removeAllRanges();
      s.addRange(r);
    }

    /* 붙여넣기: 서식은 허용된 것만 남기고 나머지는 걸러낸다 */
    on(editorEl, 'paste', (e) => {
      e.preventDefault();
      const cd = e.clipboardData;
      const html = cd.getData('text/html');
      const text = cd.getData('text/plain');
      if (html && !/<meta name=["']?wiki/.test(html)) {
        const clean = DOMPurify.sanitize(html, {
          ALLOWED_TAGS: ['p', 'br', 'strong', 'b', 'em', 'i', 'del', 's', 'strike', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'img'],
          ALLOWED_ATTR: ['href', 'src', 'alt'],
        });
        document.execCommand('insertHTML', false, clean);
      } else {
        document.execCommand('insertText', false, text);
      }
      prepare();
      changed();
    });
    on(editorEl, 'drop', (e) => { if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) e.preventDefault(); });

    /* --- 외부 API --- */
    return {
      setMarkdown,
      getMarkdown,
      focus() { (mode === 'rich' ? editorEl : mdEl).focus(); },
      destroy() {
        listeners.forEach((off) => off());
        document.querySelectorAll('.we-overlay').forEach((o) => o.remove());
        mount.innerHTML = '';
      },
      // 테스트용
      _el: editorEl,
    };
  }

  window.WikiEditor = { create };
})();
