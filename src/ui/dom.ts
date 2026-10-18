// Minimal DOM construction helpers (no framework).
type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>;
type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'value' && 'value' in el) (el as HTMLInputElement).value = String(v);
    else if (k === 'checked' && 'checked' in el) (el as HTMLInputElement).checked = Boolean(v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

/** Like Element.append, but skips null/false children. */
export function append(el: Element, ...children: Child[]): void {
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function fmt(v: number, places = 2): string {
  const r = Math.round(v * 10 ** places) / 10 ** places;
  return String(Object.is(r, -0) ? 0 : r);
}

/** Number field that commits on change (Enter/blur/spinner), not on every keystroke. */
export function numberField(opts: {
  label: string;
  value: number;
  step?: number;
  min?: number;
  max?: number;
  testId: string;
  disabled?: boolean;
  onCommit: (v: number) => void;
  /** Enter on a value equal to the current one (no edit): e.g. key it anyway in Animate mode. */
  onEnterUnchanged?: (v: number) => void;
  suffix?: Node | null;
}): HTMLElement {
  const input = h('input', {
    type: 'number',
    step: opts.step ?? 1,
    min: opts.min,
    max: opts.max,
    value: fmt(opts.value),
    'data-testid': opts.testId,
    'aria-label': opts.label,
    disabled: opts.disabled,
  });
  // The field shows a rounded value, so typing exactly what is displayed (e.g. "1" over a
  // real 0.995) fires no `change` event. Enter therefore commits whenever the typed number
  // differs from the true value; `last` stops change + Enter committing the same edit twice.
  let last = opts.value;
  const commit = () => {
    const v = Number(input.value);
    if (input.value.trim() === '' || !Number.isFinite(v)) {
      input.value = fmt(opts.value);
      return;
    }
    if (v === last) return;
    last = v;
    opts.onCommit(v);
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const v = Number(input.value);
      if (opts.onEnterUnchanged && input.value.trim() !== '' && v === last) opts.onEnterUnchanged(v);
      else commit();
    }
    if (e.key === 'Escape') {
      input.value = fmt(opts.value);
      input.blur();
    }
  });
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, opts.label), input, opts.suffix ?? null);
}
