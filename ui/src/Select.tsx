import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

// A styled replacement for <select>. It takes the same children (<option>, <optgroup>), value and
// onChange (called with an event-like { target: { value } }), so call sites only change the tag name.
// The list is drawn in a portal with fixed positioning: it is never clipped by a scrolling panel or a
// modal, never pushes the layout, and flips above the field when there is no room below.

interface Opt { value: string; label: React.ReactNode; text: string; disabled: boolean; group?: string }

const textOf = (n: React.ReactNode): string => {
  if (n == null || typeof n === 'boolean') return '';
  if (typeof n === 'string' || typeof n === 'number') return String(n);
  if (Array.isArray(n)) return n.map(textOf).join('');
  if (React.isValidElement(n)) return textOf((n.props as { children?: React.ReactNode }).children);
  return '';
};

function collect(children: React.ReactNode, group?: string, out: Opt[] = []): Opt[] {
  React.Children.forEach(children, (c) => {
    if (!React.isValidElement(c)) return;
    const p = c.props as { value?: unknown; children?: React.ReactNode; disabled?: boolean; label?: string; hidden?: boolean };
    if (c.type === 'option') {
      if (p.hidden) return;
      const text = textOf(p.children);
      out.push({ value: p.value != null ? String(p.value) : text, label: p.children, text, disabled: !!p.disabled, group });
    } else if (c.type === 'optgroup') {
      collect(p.children, p.label, out);
    } else if (c.type === React.Fragment) {
      collect(p.children, group, out);
    }
  });
  return out;
}

export interface SelectProps {
  value?: string | number | null;
  onChange?: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  children?: React.ReactNode;
  className?: string;
  disabled?: boolean;
  title?: string;
  placeholder?: string;
  'aria-label'?: string;
  autoFocus?: boolean;
}

export function Select({ value, onChange, children, className: cls = '', disabled, title, placeholder, autoFocus, ...rest }: SelectProps) {
  // a select is one line: a caller's `block` / `inline-block` would stack the label and the chevron
  // never let a flex row squeeze a dropdown to a sliver: unless the caller sets a width, keep it at least 8rem
  const sized = /(^|s)!?(w-|min-w-|flex-1)/.test(cls) ? cls : `${cls} min-w-[8rem]`;
  const className = sized.replace(/(^|s)block(?=s|$)/g, '$1flex').replace(/(^|s)inline-block(?=s|$)/g, '$1inline-flex');
  const opts = useMemo(() => collect(children), [children]);
  const current = value == null ? '' : String(value);
  const selected = opts.find((o) => o.value === current);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; width: number; maxH: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const typed = useRef({ s: '', t: 0 });
  const id = useId();

  const measure = useCallback(() => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const flip = below < 180 && above > below;
    const width = Math.max(r.width, 160);
    setPos({
      left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)), width,
      ...(flip ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
      maxH: Math.min(320, Math.max(120, flip ? above : below)),
    });
  }, []);

  const close = useCallback((refocus = false) => { setOpen(false); if (refocus) btn.current?.focus(); }, []);
  const commit = (o: Opt) => {
    if (o.disabled) return;
    onChange?.({ target: { value: o.value }, currentTarget: { value: o.value } } as unknown as React.ChangeEvent<HTMLSelectElement>);
    close(true);
  };
  const openList = () => {
    if (disabled) return;
    measure();
    setActive(Math.max(0, opts.findIndex((o) => o.value === current)));
    setOpen(true);
  };

  // follow the field while open; close on outside press
  useLayoutEffect(() => { if (open) measure(); }, [open, measure]);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!btn.current?.contains(t) && !list.current?.contains(t)) setOpen(false);
    };
    const move = (e: Event) => { if (!list.current?.contains(e.target as Node)) measure(); };
    document.addEventListener('mousedown', down);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', move, true);
    return () => { document.removeEventListener('mousedown', down); window.removeEventListener('resize', measure); window.removeEventListener('scroll', move, true); };
  }, [open, measure]);
  useEffect(() => { if (open) list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' }); }, [open, active]);

  const step = (from: number, dir: 1 | -1) => {
    for (let i = from + dir; i >= 0 && i < opts.length; i += dir) if (!opts[i].disabled) return i;
    return from;
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); openList(); }
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => step(a, 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => step(a, -1)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(step(-1, 1)); }
    else if (e.key === 'End') { e.preventDefault(); setActive(step(opts.length, -1)); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (opts[active]) commit(opts[active]); }
    else if (e.key === 'Tab') setOpen(false);
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      // type to jump
      const now = Date.now();
      typed.current.s = now - typed.current.t > 700 ? e.key.toLowerCase() : typed.current.s + e.key.toLowerCase();
      typed.current.t = now;
      const hit = opts.findIndex((o) => !o.disabled && o.text.toLowerCase().startsWith(typed.current.s));
      if (hit >= 0) setActive(hit);
    }
  };

  const grouped = opts.some((o) => o.group);
  return (
    <>
      <button ref={btn} type="button" role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined}
        aria-label={rest['aria-label']} title={title} disabled={disabled} autoFocus={autoFocus}
        onClick={() => (open ? close() : openList())} onKeyDown={onKey}
        className={`${className} sel-trigger ${open && /(^|s)(input|inp)(s|$)/.test(className) ? '!border-fg/60 ring-2 ring-fg/10' : ''}`}>
        {/* the invisible stack of every option keeps the field as wide as its longest option, so it never jumps */}
        <span className="grid min-w-0 flex-1">
          <span className={`col-start-1 row-start-1 min-w-0 truncate text-left ${selected ? '' : 'text-fg-4'}`}>{selected ? selected.label : (placeholder ?? '')}</span>
          <span aria-hidden className="col-start-1 row-start-1 invisible h-0 overflow-hidden">{opts.map((o, i) => <span key={i} className="block whitespace-nowrap">{o.label}</span>)}</span>
        </span>
        <ChevronDown size={13} strokeWidth={1.75} className={`shrink-0 text-fg-3 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>
      {open && pos && createPortal(
        <div ref={list} id={id} role="listbox" aria-label={rest['aria-label']}
          style={{ position: 'fixed', left: pos.left, top: pos.top, bottom: pos.bottom, minWidth: pos.width, maxWidth: 'min(440px, calc(100vw - 16px))', maxHeight: pos.maxH }}
          onClick={(e) => e.stopPropagation()} className="z-[90] overflow-auto rounded-xl border border-line-strong bg-surface p-1 shadow-pop animate-rise">
          {opts.map((o, i) => {
            const showGroup = grouped && o.group && (i === 0 || opts[i - 1].group !== o.group);
            return (
              <React.Fragment key={`${o.value}:${i}`}>
                {showGroup && <div className="px-2.5 pt-2 pb-1 text-2xs font-mono uppercase tracking-[0.05em] text-fg-4">{o.group}</div>}
                <div role="option" aria-selected={o.value === current} aria-disabled={o.disabled} data-i={i}
                  onMouseEnter={() => !o.disabled && setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={(e) => { e.stopPropagation(); commit(o); }}
                  className={`flex items-center gap-2 min-h-8 px-2.5 py-1.5 rounded-lg text-sm leading-snug cursor-pointer select-none ${o.disabled ? 'text-fg-4 cursor-not-allowed' : i === active ? 'bg-raised text-fg' : 'text-fg-2'} ${o.value === current ? 'font-medium text-fg' : ''}`}>
                  <span className="min-w-0 flex-1 whitespace-normal break-words">{o.label}</span>
                  {o.value === current && <Check size={13} strokeWidth={2} className="shrink-0 text-fg" aria-hidden />}
                </div>
              </React.Fragment>
            );
          })}
          {!opts.length && <div className="px-2.5 py-2 text-xs text-fg-4">No options</div>}
        </div>,
        document.body,
      )}
    </>
  );
}
