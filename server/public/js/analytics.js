// Brand analytics: filters, stat tiles, orders-per-day columns, peak-hours heatmap,
// per-branch table, customer feedback, CSV link. Plain HTML/SVG, RTL (time runs right-to-left).

import { api, esc } from './util.js';

const DAY_NAMES = ['الأحد', 'الاتنين', 'التلات', 'الأربع', 'الخميس', 'الجمعة', 'السبت'];
const WEEK_ORDER = [6, 0, 1, 2, 3, 4, 5]; // Egyptian week starts on Saturday
const HEAT_STEPS = 5;
const SVG_NS = 'http://www.w3.org/2000/svg';

const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => iso(new Date(Date.now() - n * 86_400_000));
const fmtInt = (n) => new Intl.NumberFormat('en-US').format(n);
const fmtMin = (s) => (s == null ? '—' : s < 60 ? `${s} ث` : `${Math.round(s / 60)} د`);
const hourLabel = (h) => {
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12} ${h < 12 ? 'ص' : 'م'}`;
};
const dayLabel = (day) => {
  const [, m, d] = day.split('-').map(Number);
  return `${d}/${m}`;
};

// ---------- tooltip (one floating element for every chart) ----------

function tooltip(root) {
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  document.body.append(tip);
  const show = (e) => {
    const el = e.target.closest('[data-tip]');
    if (!el || !root.contains(el)) {
      tip.hidden = true;
      return;
    }
    tip.textContent = el.dataset.tip;
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    const x = Math.min(window.innerWidth - r.width - 8, Math.max(8, e.clientX - r.width / 2));
    const y = e.clientY - r.height - 12 < 8 ? e.clientY + 16 : e.clientY - r.height - 12;
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  };
  root.addEventListener('pointermove', show);
  root.addEventListener('pointerdown', show);
  root.addEventListener('pointerleave', () => {
    tip.hidden = true;
  });
}

// ---------- charts ----------

function niceMax(v) {
  if (v <= 5) return 5;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((x) => x >= v);
}

/** Orders per day: single series in the accent, so no legend box (the title names it). */
function renderColumns(el, daily) {
  el.textContent = '';
  const width = Math.max(280, el.clientWidth);
  const height = 200;
  const pad = { top: 12, bottom: 26, left: 8, right: 36 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const max = niceMax(Math.max(1, ...daily.map((d) => d.orders)));
  const band = plotW / Math.max(1, daily.length);
  const barW = Math.max(2, Math.min(24, band - 2));
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'عدد الطلبات في اليوم');

  let html = '';
  for (const t of [0, max / 2, max]) {
    const y = pad.top + plotH - (t / max) * plotH;
    html += `<line class="grid" x1="${pad.left}" x2="${pad.left + plotW}" y1="${y}" y2="${y}"/>`;
    html += `<text class="tick" x="${width - 4}" y="${y + 4}" text-anchor="end">${fmtInt(Math.round(t))}</text>`;
  }
  const labelEvery = Math.ceil(daily.length / Math.max(1, Math.floor(plotW / 56)));
  daily.forEach((d, i) => {
    // RTL: the first day sits on the right.
    const cx = pad.left + plotW - (i + 0.5) * band;
    const h = (d.orders / max) * plotH;
    const x = cx - barW / 2;
    const y = pad.top + plotH - h;
    const r = Math.min(4, barW / 2, h);
    const tip = `${dayLabel(d.day)}: ${fmtInt(d.orders)} طلب${d.late ? `، منهم ${fmtInt(d.late)} متأخر` : ''}`;
    if (h > 0) {
      // 4px rounded data-end, square at the baseline.
      html += `<path class="bar" d="M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + barW - r} Q${x + barW},${y} ${x + barW},${y + r} V${y + h} Z"/>`;
    }
    html += `<rect class="hit" x="${cx - band / 2}" y="${pad.top}" width="${band}" height="${plotH}" data-tip="${esc(tip)}"/>`;
    if (i % labelEvery === 0) html += `<text class="tick" x="${cx}" y="${height - 6}" text-anchor="middle">${dayLabel(d.day)}</text>`;
  });
  html += `<line class="axis" x1="${pad.left}" x2="${pad.left + plotW}" y1="${pad.top + plotH}" y2="${pad.top + plotH}"/>`;
  svg.innerHTML = html;
  el.append(svg);
}

/** Peak hours: sequential, one hue (latte) from the surface up; 5 steps + legend. */
function renderHeatmap(el, heatmap) {
  const max = Math.max(0, ...heatmap.flat());
  const step = (v) => (v === 0 || max === 0 ? 0 : Math.max(1, Math.ceil((v / max) * HEAT_STEPS)));
  let html = '<div class="heat-grid" role="table" aria-label="الطلبات حسب اليوم والساعة">';
  html += '<span class="heat-corner"></span>';
  for (let h = 0; h < 24; h++) {
    const minor = h % 6 !== 0 ? ' data-minor' : ''; // hidden on narrow screens
    html += `<span class="heat-hour"${minor}>${h % 3 === 0 ? hourLabel(h) : ''}</span>`;
  }
  for (const wd of WEEK_ORDER) {
    html += `<span class="heat-day">${DAY_NAMES[wd]}</span>`;
    for (let h = 0; h < 24; h++) {
      const v = heatmap[wd][h];
      const tip = `${DAY_NAMES[wd]} ${hourLabel(h)} – ${hourLabel((h + 1) % 24)}: ${fmtInt(v)} طلب`;
      html += `<span class="heat-cell" data-step="${step(v)}" data-tip="${esc(tip)}" role="cell" aria-label="${esc(tip)}"></span>`;
    }
  }
  html += '</div>';
  html += `<div class="heat-legend" aria-hidden="true"><span>أقل</span>${
    Array.from({ length: HEAT_STEPS + 1 }, (_, i) => `<i data-step="${i}"></i>`).join('')
  }<span>أكتر</span></div>`;
  el.innerHTML = max ? html : '<p class="empty-note">مفيش طلبات في الفترة دي.</p>';
}

function tile(label, value, note) {
  return `<div class="stat-tile"><p class="stat-label">${esc(label)}</p><p class="stat-value num">${esc(value)}</p>${
    note ? `<p class="stat-note">${esc(note)}</p>` : ''}</div>`;
}

function renderTiles(el, total, exact) {
  const approx = exact ? '' : 'تقريبي (الفترة أقدم من 90 يوم)';
  el.innerHTML = [
    tile('الطلبات', fmtInt(total.orders), `${fmtInt(total.picked)} اتسلّموا`),
    tile('اتأخروا', `${total.latePct}%`, `${fmtInt(total.late)} طلب عدّى الوقت المحدد`),
    tile('وقت التحضير', fmtMin(total.prepMedianS), approx || 'نص الطلبات بيجهز في أقل من كده'),
    tile('وقت الاستلام', fmtMin(total.waitMedianS), approx || 'من ما يجهز لحد ما العميل ياخده'),
  ].join('');
}

function renderTable(el, branches) {
  if (!branches.length) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = `
    <table class="data-table">
      <thead><tr><th>الفرع</th><th>الطلبات</th><th>اتأخروا</th><th>وقت التحضير</th><th>وقت الاستلام</th><th>اتلغوا</th><th>انتهوا</th></tr></thead>
      <tbody>${branches.map((b) => `
        <tr>
          <th scope="row">${esc(b.name)}</th>
          <td class="num">${fmtInt(b.totals.orders)}</td>
          <td class="num">${b.totals.latePct}%</td>
          <td class="num">${fmtMin(b.totals.prepMedianS)}</td>
          <td class="num">${fmtMin(b.totals.waitMedianS)}</td>
          <td class="num">${fmtInt(b.totals.cancelled)}</td>
          <td class="num">${fmtInt(b.totals.expired)}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;
}

const fmtWhen = (ts) => new Intl.DateTimeFormat('ar-EG', { day: 'numeric', month: 'numeric', hour: 'numeric', minute: '2-digit' }).format(ts);

/** Latest internal ratings; 1-2 stars are marked so the owner can follow up. */
function renderFeedback(el, fb, showBranch) {
  if (!fb?.count) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const lowNote = fb.low ? `، ${fmtInt(fb.low)} منهم نجمة أو اتنين` : '';
  el.innerHTML = `
    <h3>آراء العملاء</h3>
    <p class="muted small">متوسط <span class="num">${fb.avg.toFixed(1)}</span> من 5 من ${fmtInt(fb.count)} تقييم${lowNote}</p>
    <ul class="feedback-list">${fb.latest.map((f) => `
      <li ${f.rating <= 2 ? 'data-low' : ''}>
        <span class="fb-rating num" aria-label="${f.rating} من 5">★ ${f.rating}</span>
        <p>${f.comment ? esc(f.comment) : '<span class="muted">من غير تعليق</span>'}</p>
        <small>${showBranch ? `${esc(f.branchName)} · ` : ''}${esc(fmtWhen(f.at))}</small>
      </li>`).join('')}
    </ul>`;
}

// ---------- section ----------

export function mountAnalytics(root, { base, branches }) {
  root.innerHTML = `
    <div class="dash-head">
      <h2>التحليلات</h2>
      <a class="btn btn-sm" id="an-csv" href="#" download>نزّل CSV</a>
    </div>
    <div class="filters" role="group" aria-label="الفترة والفرع">
      <div class="presets">
        <button class="btn btn-sm" data-days="7" type="button">آخر 7 أيام</button>
        <button class="btn btn-sm" data-days="30" type="button">آخر 30 يوم</button>
        <button class="btn btn-sm" data-days="90" type="button">آخر 90 يوم</button>
      </div>
      <label class="field inline"><span>من</span><input class="input" type="date" id="an-from" dir="ltr"></label>
      <label class="field inline"><span>لحد</span><input class="input" type="date" id="an-to" dir="ltr"></label>
      <label class="field inline"><span>الفرع</span><select class="input" id="an-branch">
        <option value="">كل الفروع</option>
        ${branches.map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('')}
      </select></label>
    </div>
    <p class="form-error" id="an-error" hidden></p>
    <div class="stat-tiles" id="an-tiles"></div>
    <div class="chart-card">
      <h3>الطلبات في اليوم</h3>
      <div class="columns" id="an-columns"></div>
    </div>
    <div class="chart-card">
      <h3>ساعات الذروة</h3>
      <p class="muted small">كل مربع عدد الطلبات في ساعة من يوم في الأسبوع. اللون الأفتح يعني طلبات أكتر.</p>
      <div id="an-heat"></div>
    </div>
    <div class="chart-card table-card" id="an-table"></div>
    <div class="chart-card" id="an-feedback" hidden></div>`;

  const $ = (id) => root.querySelector(`#${id}`);
  const from = $('an-from');
  const to = $('an-to');
  const branch = $('an-branch');
  let last = null;
  tooltip(root);

  const params = () => new URLSearchParams({ from: from.value, to: to.value, ...(branch.value ? { branch: branch.value } : {}) });

  async function load() {
    const q = params();
    $('an-csv').href = `${base}/analytics.csv?${q}`;
    for (const b of root.querySelectorAll('[data-days]')) {
      b.classList.toggle('is-active', to.value === daysAgo(0) && from.value === daysAgo(Number(b.dataset.days) - 1));
    }
    try {
      last = await api(`${base}/analytics?${q}`);
      $('an-error').hidden = true;
      renderTiles($('an-tiles'), last.total, last.exact);
      renderColumns($('an-columns'), last.daily);
      renderHeatmap($('an-heat'), last.heatmap);
      renderTable($('an-table'), branch.value ? [] : last.branches);
      $('an-table').hidden = Boolean(branch.value) || last.branches.length < 2;
      renderFeedback($('an-feedback'), last.feedback, !branch.value && last.branches.length > 1);
    } catch (err) {
      $('an-error').textContent = err.message;
      $('an-error').hidden = false;
    }
  }

  const setDays = (n) => {
    from.value = daysAgo(n - 1);
    to.value = daysAgo(0);
    load();
  };
  root.querySelector('.presets').addEventListener('click', (e) => {
    const b = e.target.closest('[data-days]');
    if (b) setDays(Number(b.dataset.days));
  });
  for (const el of [from, to, branch]) el.addEventListener('change', load);
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => last && renderColumns($('an-columns'), last.daily), 150);
  });
  setDays(7);
}
