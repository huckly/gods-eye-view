import { SEABED_RAMP } from './seabedOverlay.js';

/**
 * huckly fork: bottom-right legend for the coral and seabed overlays, stacked
 * above the toggle chips. The coral section is a per-class checklist in Atlas
 * order and colours (like the Atlas web map's Benthic Map panel); the seabed
 * section is the depth colour bar. Hidden while both overlays are off.
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

function classRow({ cls, label, color, visible, count }, outline) {
  const box = outline ? `border:2px solid ${color};background:transparent` : `background:${color}`;
  return (
    `<label style="display:flex;align-items:center;gap:6px;cursor:pointer;margin:1px 0">` +
    `<input type="checkbox" data-coral-class="${cls}" ${visible ? 'checked' : ''} ` +
    `style="margin:0;accent-color:#7fe7ff;cursor:pointer">` +
    `<span style="flex:1">${label}</span>` +
    `<span style="opacity:.6">${count.toLocaleString()}</span>` +
    `<span style="display:inline-block;width:14px;height:11px;${box}"></span></label>`
  );
}

export function createHucklyLegend({ slot = 2, onToggleClass = () => {} } = {}) {
  const box = document.createElement('div');
  box.id = 'huckly-overlay-legend';
  box.dataset.i18nSkip = '';
  box.hidden = true;
  Object.assign(box.style, {
    position: 'fixed',
    right: '12px',
    bottom: `${48 + slot * 30}px`,
    zIndex: '40',
    width: '240px',
    padding: '8px 10px',
    font: '500 11px "JetBrains Mono", "SF Mono", monospace',
    color: '#cfefff',
    background: 'rgba(4, 16, 24, 0.86)',
    border: '1px solid rgba(127, 231, 255, 0.35)',
    borderRadius: '4px',
    lineHeight: '1.5',
  });
  box.addEventListener('change', (event) => {
    const input = event.target;
    if (input?.dataset?.coralClass) onToggleClass(input.dataset.coralClass, input.checked);
  });
  document.body.appendChild(box);

  return {
    update({ coral = false, seabed = false, coralClasses = [] } = {}) {
      box.hidden = !coral && !seabed;
      if (box.hidden) return;
      const parts = [];
      if (coral) {
        parts.push(
          `<div style="color:#7fe7ff;margin-bottom:2px">底質（Allen Coral Atlas）${seabed ? '· 外框' : ''}</div>` +
            coralClasses.map((row) => classRow(row, seabed)).join(''),
        );
      }
      if (seabed) {
        const ticks = DEPTH_TICKS_M.map(
          (m) =>
            `<span style="position:absolute;left:${(m / MAX_DEPTH_M) * 100}%;transform:translateX(-50%)">${m}</span>`,
        ).join('');
        parts.push(
          `<div style="color:#7fe7ff;margin:${coral ? '6px' : '0'} 0 2px">水深（公尺）· 陰影光源：西北</div>` +
            `<div style="height:10px;border-radius:2px;background:${depthGradient()}"></div>` +
            `<div style="position:relative;height:14px;margin:0 4px">${ticks}</div>`,
        );
      }
      box.innerHTML = parts.join('');
    },
    remove() {
      box.remove();
    },
  };
}
