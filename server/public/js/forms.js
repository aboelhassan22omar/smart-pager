// Bottom-sheet form shared by the super and brand dashboards.
//   openForm({ title, intro, fields: [{ name, label, type, value, placeholder, options }], submit, onSubmit })
// onSubmit(values) may throw an ApiError; its message (and data.field) is shown in the sheet.

import { esc } from './util.js';

function fieldHtml(f) {
  const id = `f-${f.name}`;
  const common = `id="${id}" name="${esc(f.name)}" ${f.required ? 'required' : ''}`;
  if (f.type === 'select') {
    const opts = f.options.map((o) => `<option value="${esc(o.value)}" ${o.value === f.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('');
    return `<label class="field" for="${id}"><span>${esc(f.label)}</span><select class="input" ${common}>${opts}</select></label>`;
  }
  const dir = f.dir ? `dir="${esc(f.dir)}"` : '';
  const mode = f.inputmode ? `inputmode="${esc(f.inputmode)}"` : '';
  return `<label class="field" for="${id}"><span>${esc(f.label)}</span>
    <input class="input" ${common} type="${esc(f.type ?? 'text')}" ${dir} ${mode}
           value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder ?? '')}" autocomplete="off"></label>`;
}

export function openForm({ title, intro = '', fields = [], submit = 'حفظ', danger = false, onSubmit }) {
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  backdrop.innerHTML = `
    <form class="sheet form-sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" novalidate>
      <h2 id="sheet-title">${esc(title)}</h2>
      ${intro ? `<p class="muted">${esc(intro)}</p>` : ''}
      <div class="stack">${fields.map(fieldHtml).join('')}</div>
      <p class="form-error" hidden></p>
      <div class="sheet-actions">
        <button class="btn ${danger ? 'btn-danger-solid' : 'btn-primary'} btn-block" type="submit">${esc(submit)}</button>
        <button class="btn btn-quiet btn-block" type="button" data-close>رجوع</button>
      </div>
    </form>`;
  document.body.append(backdrop);
  const form = backdrop.querySelector('form');
  const error = form.querySelector('.form-error');
  const close = () => backdrop.remove();
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop || e.target.closest('[data-close]')) close();
  });
  backdrop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
  (form.querySelector('input, select') ?? form.querySelector('[type=submit]')).focus();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = form.querySelector('[type=submit]');
    button.disabled = true;
    error.hidden = true;
    for (const el of form.querySelectorAll('[aria-invalid]')) el.removeAttribute('aria-invalid');
    const values = Object.fromEntries(new FormData(form).entries());
    try {
      const keepOpen = await onSubmit(values);
      if (!keepOpen) close();
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      const field = err.data?.field && form.elements[err.data.field];
      field?.setAttribute('aria-invalid', 'true');
      field?.focus();
    } finally {
      button.disabled = false;
    }
  });
  return { close, form };
}

/** A sheet that only shows a result (e.g. a generated password) with a copy button. */
export function showResult({ title, lines }) {
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  backdrop.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
      <h2 id="sheet-title">${esc(title)}</h2>
      <dl class="result-list">${lines.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd dir="ltr">${esc(v)}</dd></div>`).join('')}</dl>
      <div class="sheet-actions">
        <button class="btn btn-primary btn-block" type="button" data-copy>انسخ</button>
        <button class="btn btn-quiet btn-block" type="button" data-close>تمام</button>
      </div>
    </div>`;
  document.body.append(backdrop);
  backdrop.addEventListener('click', async (e) => {
    if (e.target === backdrop || e.target.closest('[data-close]')) backdrop.remove();
    if (e.target.closest('[data-copy]')) {
      await navigator.clipboard?.writeText(lines.map(([k, v]) => `${k}: ${v}`).join('\n')).catch(() => {});
      e.target.closest('[data-copy]').textContent = 'اتنسخ';
    }
  });
}
