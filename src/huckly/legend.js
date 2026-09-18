import { CORAL_CLASS_STYLE } from './coralOverlay.js';
import { SEABED_RAMP } from './seabedOverlay.js';

/**
 * huckly fork: bottom-right legend for the coral and seabed overlays. Shown only
 * while at least one of them is on; stacked above the toggle chips.
 */
const DEPTH_TICKS_M = [0, 5, 10, 15, 20, 25];
const MAX_DEPTH_M = 25;

function rgb([r, g, b]) {
  return `rgb(${r}, ${g}, ${b})`;
}

function depthGradient() {
  const stops = SEABED_RAMP.filter(([depth]) => depth <= MAX_DEPTH_M + 1).map(
    ([depth, color]) => `${rgb(color)} ${Math.min(100, (depth / MAX_DEPTH_M) * 100).toFixed(1)}%`,
  );
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

function swatch(style, outline) {
  const box = outline
    ? `border:2px solid ${style.color};background:transparent`
    : `background:${style.color};opacity:${Math.min(1, style.alpha + 0.2)}`;
  return (
    `<span style="display:inline-flex;align-items:center;gap:5px;margin-right:10px">` +
    `<span style="display:inline-block;width:12px;height:10px;${box}"></span>${style.label}` +
    `${outline ? '（外框）' : ''}</span>`
  );
}

export function createHucklyLegend({ slot = 2 } = {}) {
  const box = document.createElement('div');
  box.id = 'huckly-overlay-legend';
  box.dataset.i18nSkip = '';
  box.hidden = true;
  Object.assign(box.style, {
    position: 'fixed',
    right: '12px',
    bottom: `${48 + slot * 30}px`,
    zIndex: '40',
    width: '230px',
    padding: '8px 10px',
    font: '500 11px "JetBrains Mono", "SF Mono", monospace',
    color: '#cfefff',
    background: 'rgba(4, 16, 24, 0.82)',
    border: '1px solid rgba(127, 231, 255, 0.35)',
    borderRadius: '4px',
    lineHeight: '1.5',
    pointerEvents: 'none',
  });
  document.body.appendChild(box);

  return {
    update({ coral = false, seabed = false } = {}) {
      box.hidden = !coral && !seabed;
      if (box.hidden) return;
      const parts = [];
      if (seabed) {
        const ticks = DEPTH_TICKS_M.map(
          (m) =>
            `<span style="position:absolute;left:${(m / MAX_DEPTH_M) * 100}%;transform:translateX(-50%)">${m}</span>`,
        ).join('');
        parts.push(
          '<div style="margin-bottom:2px;color:#7fe7ff">水深（公尺）· 陰影光源：西北</div>' +
            `<div style="height:10px;border-radius:2px;background:${depthGradient()}"></div>` +
            `<div style="position:relative;height:14px;margin:0 4px">${ticks}</div>`,
        );
      }
      if (coral) {
        const styles = [CORAL_CLASS_STYLE['Coral/Algae'], CORAL_CLASS_STYLE.Seagrass];
        parts.push(`<div style="margin-top:4px">${styles.map((s) => swatch(s, seabed)).join('')}</div>`);
      }
      box.innerHTML = parts.join('');
    },
    remove() {
      box.remove();
    },
  };
}
