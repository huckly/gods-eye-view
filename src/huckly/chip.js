/**
 * huckly fork: small toggle chip shared by the fork's own overlays. Stacked
 * above the bottom-right POWER UP chip; `slot` 0 is the lowest.
 * `data-i18n-skip` keeps the zh-TW overlay from rewriting its dynamic text.
 */
export function createHucklyChip({ id, slot = 0 }) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.id = id;
  chip.dataset.i18nSkip = '';
  Object.assign(chip.style, {
    position: 'fixed',
    right: '12px',
    bottom: `${48 + slot * 30}px`,
    zIndex: '40',
    padding: '4px 10px',
    font: '600 11px "JetBrains Mono", "SF Mono", monospace',
    letterSpacing: '1px',
    color: '#7fe7ff',
    background: 'rgba(4, 16, 24, 0.78)',
    border: '1px solid rgba(127, 231, 255, 0.45)',
    borderRadius: '4px',
    cursor: 'pointer',
  });
  document.body.appendChild(chip);
  return chip;
}

/** Read a `?name=1|0` URL toggle (remembered in localStorage) with a fallback. */
export function readToggle(name, storageKey) {
  try {
    const param = new URLSearchParams(window.location.search).get(name);
    if (param === '1' || param === '0') {
      window.localStorage.setItem(storageKey, param);
      return param === '1';
    }
    return window.localStorage.getItem(storageKey) === '1';
  } catch {
    return false;
  }
}

export function rememberToggle(storageKey, enabled) {
  try {
    window.localStorage.setItem(storageKey, enabled ? '1' : '0');
  } catch {
    /* storage blocked */
  }
}
