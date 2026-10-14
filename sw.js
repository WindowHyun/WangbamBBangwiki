/*
 * 서비스 워커 — 앱처럼 빠르게 열고, 인터넷이 안 될 때 최근에 본 문서를 읽을 수 있게 한다.
 *
 *  - 앱 껍데기(index.html, assets/*, 아이콘): 미리 저장해 두고 빠르게 연다.
 *      · index.html 은 "인터넷 우선"이라 배포하면 바로 새 버전이 열린다. (안 될 때만 저장본)
 *      · assets/* 는 "저장본 먼저, 뒤에서 갱신". 파일 주소의 ?v=숫자 가 바뀌면 곧바로 새 파일을 받는다.
 *  - 문서 데이터(Supabase REST GET): "인터넷 우선". 안 될 때만 저장본을 주고 x-wiki-offline 헤더를 붙인다.
 *  - 저장·검색(POST)·이미지 업로드·이미지 파일은 건드리지 않는다.
 *
 * 이 파일의 동작을 바꾸면 VERSION 을 올린다.
 */
'use strict';

const VERSION = 'v1';
const SHELL = `wiki-shell-${VERSION}`;
const DATA = `wiki-data-${VERSION}`;
const MAX_DATA_ENTRIES = 80; // 저장해 둘 문서 데이터 개수 (오래된 것부터 지운다)
const SCOPE = self.registration.scope;
const INDEX = new URL('index.html', SCOPE).href;

/* index.html 에서 미리 저장할 파일 목록을 뽑는다 (assets/*, manifest) */
function shellUrls(html) {
  const urls = new Set();
  for (const m of html.matchAll(/(?:src|href)="((?:assets\/|manifest)[^"]*)"/g)) urls.add(new URL(m[1], SCOPE).href);
  urls.add(new URL('assets/icons/icon-192.png', SCOPE).href);
  return [...urls];
}

async function refreshShell(response) {
  const html = await response.text();
  const cache = await caches.open(SHELL);
  const wanted = shellUrls(html);
  await cache.put(INDEX, new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }));
  await Promise.all(wanted.map(async (u) => {
    if (await cache.match(u)) return;
    try { await cache.add(u); } catch (e) { /* 일부 실패해도 계속 */ }
  }));
  // 옛 버전 파일(?v=이전 숫자)은 정리한다
  for (const req of await cache.keys()) {
    if (req.url !== INDEX && !wanted.includes(req.url)) await cache.delete(req);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const res = await fetch(INDEX, { cache: 'reload' });
    if (res.ok) await refreshShell(res);
  })().catch(() => {}));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name !== SHELL && name !== DATA) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

async function navigate(event) {
  try {
    const res = await fetch(event.request);
    if (res.ok && new URL(event.request.url).pathname.replace(/index\.html$/, '') === new URL(SCOPE).pathname) {
      event.waitUntil(refreshShell(res.clone()));
    }
    return res;
  } catch (err) {
    const hit = await (await caches.open(SHELL)).match(INDEX);
    if (hit) return hit;
    throw err;
  }
}

async function staleWhileRevalidate(event) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(event.request);
  const fresh = fetch(event.request)
    .then((res) => { if (res.status === 200) cache.put(event.request, res.clone()); return res; })
    .catch(() => null);
  if (hit) { event.waitUntil(fresh); return hit; }
  const res = await fresh;
  return res || Response.error();
}

async function trimData(cache) {
  const keys = await cache.keys();
  for (const req of keys.slice(0, Math.max(0, keys.length - MAX_DATA_ENTRIES))) await cache.delete(req);
}

async function dataFirst(event) {
  const cache = await caches.open(DATA);
  try {
    const res = await fetch(event.request);
    if (res.status === 200) event.waitUntil(cache.put(event.request, res.clone()).then(() => trimData(cache)));
    return res;
  } catch (err) {
    const hit = await cache.match(event.request, { ignoreVary: true });
    if (!hit) throw err;
    const headers = new Headers(hit.headers);
    headers.set('x-wiki-offline', '1'); // 화면에서 "오프라인" 안내를 띄우는 데 쓴다
    return new Response(await hit.blob(), { status: hit.status, statusText: hit.statusText, headers });
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const inScope = url.origin === self.location.origin && url.href.startsWith(SCOPE);

  if (inScope && req.mode === 'navigate') return void event.respondWith(navigate(event));
  if (inScope) return void event.respondWith(staleWhileRevalidate(event));
  if (url.origin !== self.location.origin && url.pathname.startsWith('/rest/v1/')) return void event.respondWith(dataFirst(event));
});
