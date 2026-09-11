/**
 * huckly fork: runtime zh-TW UI overlay.
 *
 * Instead of editing ~650 English strings across index.html and 15 modules
 * (which would conflict with every upstream merge), this watches the DOM and
 * swaps text nodes / title / placeholder / aria-label values whose trimmed text
 * exactly matches a key in zh-tw.dict.js. Unknown strings are left alone.
 *
 * Switch language:  ?lang=en  or  ?lang=zh-TW   (remembered in localStorage)
 * Collect untranslated strings:  ?i18n-debug=1  then  hucklyI18n.missing
 */
import { ZH_TW } from './zh-tw.dict.js';

const STORAGE_KEY = 'huckly:lang';
const ATTRS = ['title', 'placeholder', 'aria-label'];
const MAX_KEY_LENGTH = 240;

// Elements whose text the app reads back or compares, or that must not change.
const SKIP_SELECTOR = [
  'script',
  'style',
  'textarea',
  'input',
  'code',
  'pre',
  '[contenteditable]',
  '[data-i18n-skip]',
  '.material-symbols-outlined',
  '.material-symbols-rounded',
  '.material-icons',
  // Brand wordmark "GOD'S EYE VIEW" is split across spans; keep it intact.
  '#title-bar h1',
  // splitFlap.js aborts its animation when element.textContent !== expected.
  '.gev-flap-host',
  // data/manager.js rewrites chip labels whenever textContent !== chip.label.
  '.data-toggle-chip',
  // ui.js compares this element's textContent before rewriting it.
  '#traffic-sync-progress',
].join(',');

function readLang() {
  try {
    const fromQuery = new URLSearchParams(window.location.search).get('lang');
    if (fromQuery) {
      window.localStorage.setItem(STORAGE_KEY, fromQuery);
      return fromQuery;
    }
    return window.localStorage.getItem(STORAGE_KEY) || 'zh-TW';
  } catch {
    return 'zh-TW';
  }
}

const lang = readLang();
const debug = /[?&]i18n-debug=1\b/.test(window.location.search);
const dict = new Map(Object.entries(ZH_TW));
const missing = new Set();

function lookup(value) {
  const key = value.trim();
  if (!key || key.length > MAX_KEY_LENGTH) return null;
  const zh = dict.get(key);
  if (zh === undefined) {
    if (debug && missing.size < 2000 && /[A-Za-z]{2}/.test(key)) missing.add(key);
    return null;
  }
  return { key, zh };
}

function translateTextNode(node, checkAncestors) {
  const raw = node.nodeValue;
  if (!raw) return;
  const hit = lookup(raw);
  if (!hit) return;
  if (checkAncestors && node.parentElement?.closest(SKIP_SELECTOR)) return;
  node.nodeValue = raw.replace(hit.key, () => hit.zh);
}

function translateAttrs(el) {
  for (const name of ATTRS) {
    const value = el.getAttribute(name);
    if (!value) continue;
    const hit = lookup(value);
    if (hit) el.setAttribute(name, hit.zh);
  }
}

function walk(root) {
  if (root.nodeType === Node.TEXT_NODE) {
    translateTextNode(root, true);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  if (root.closest(SKIP_SELECTOR)) return;
  translateAttrs(root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.nodeType === Node.ELEMENT_NODE && node.matches(SKIP_SELECTOR)
      ? NodeFilter.FILTER_REJECT
      : NodeFilter.FILTER_ACCEPT),
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) translateTextNode(node, false);
    else translateAttrs(node);
  }
}

function start() {
  document.documentElement.lang = 'zh-Hant-TW';
  walk(document.body);
  // Our own writes produce zh values that are not dictionary keys, so the
  // observer settles after one pass and cannot loop.
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'characterData') {
        translateTextNode(record.target, true);
      } else if (record.type === 'attributes') {
        if (!record.target.closest(SKIP_SELECTOR)) translateAttrs(record.target);
      } else {
        for (const node of record.addedNodes) walk(node);
      }
    }
  }).observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ATTRS,
  });
}

window.hucklyI18n = Object.freeze({
  lang,
  missing,
  setLang(next) {
    try { window.localStorage.setItem(STORAGE_KEY, next); } catch { /* storage blocked */ }
    window.location.reload();
  },
});

if (lang === 'zh-TW' && document.body) start();
