#!/usr/bin/env node
// pages/ 아래의 모든 .md 를 훑어 data/index.json 을 만든다.
// 사용법: node scripts/build-index.mjs
import { readdirSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pagesDir = join(root, 'pages');
const outFile = join(root, 'data', 'index.json');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) out.push(...walk(p));
    else if (name.name.endsWith('.md')) out.push(p);
  }
  return out;
}

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
  return { meta, body: raw };
}

function plain(body) {
  return body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
    .replace(/\[\*[^\]]*\]/g, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/[*_`|~]/g, '')
    .replace(/^\s*[-+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstParagraph(body) {
  for (const block of body.replace(/```[\s\S]*?```/g, '').split(/\n\s*\n/)) {
    const t = block.trim();
    if (!t || /^(#{1,6}\s|[-*+]\s|\||>|!\[)/.test(t)) continue;
    return plain(t).slice(0, 140);
  }
  return '';
}

function links(body) {
  const set = new Set();
  const noCode = body.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  for (const m of noCode.matchAll(/\[\[([^\[\]\n]+?)\]\]/g)) {
    let dest = m[1].split('|')[0].trim();
    if (/^https?:\/\//i.test(dest) || /^분류:/.test(dest)) continue;
    dest = dest.split('#')[0].trim();
    if (dest) set.add(dest);
  }
  return [...set];
}

function lastModified(file) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cI', '--', file], { cwd: root, encoding: 'utf8' }).trim();
    if (out) return out;
  } catch {}
  return statSync(file).mtime.toISOString();
}

const pages = walk(pagesDir)
  .map((file) => {
    const rel = relative(pagesDir, file).split(sep).join('/');
    const title = rel.replace(/\.md$/, '');
    const { meta, body } = parseDoc(readFileSync(file, 'utf8'));
    const entry = {
      title,
      categories: (meta.categories || '').split(',').map((s) => s.trim()).filter(Boolean),
      summary: firstParagraph(body),
      updated: lastModified(file),
      links: links(body),
      text: plain(body).slice(0, 3000),
    };
    if (meta.redirect) entry.redirect = meta.redirect;
    return entry;
  })
  .sort((a, b) => a.title.localeCompare(b.title, 'ko'));

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify({ pages }, null, 1) + '\n');
console.log(`data/index.json: 문서 ${pages.length}개`);
