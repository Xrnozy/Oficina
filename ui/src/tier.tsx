import React from 'react';

// The model-tier override as a labelled choice instead of a dropdown: all four options are visible at once, each says
// what it does, and nothing is squeezed into a narrow select. Used for a workflow step (Routing) and for an agent.

export const TIER_CHOICES: { v: '' | 'fast' | 'standard' | 'strong'; label: string; hint: string; dot: string }[] = [
  { v: '', label: 'Auto', dot: 'bg-fg-4', hint: 'The router picks per work item, from what it is and how hard the task is.' },
  { v: 'fast', label: 'Fast', dot: 'bg-ok', hint: 'Cheap, quick models: docs, analysis, easy tasks.' },
  { v: 'standard', label: 'Standard', dot: 'bg-info', hint: 'The everyday tier: most implementation, testing, PM prompts and acceptance.' },
  { v: 'strong', label: 'Strong', dot: 'bg-warn', hint: 'The most capable models, for hard tasks. Costs the most.' },
];

export function TierPicker({ value, onChange, disabled, label, note, className = '' }: {
  value: string; onChange: (v: string) => void; disabled?: boolean; label?: string; note?: React.ReactNode; className?: string;
}) {
  const cur = TIER_CHOICES.find((t) => t.v === (value || '')) ?? TIER_CHOICES[0];
  return (
    <div className={className}>
      {label && <div className="field-label">{label}</div>}
      <div role="radiogroup" aria-label={label ?? 'Model tier'} className="flex flex-wrap gap-1.5">
        {TIER_CHOICES.map((t) => {
          const on = t.v === (value || '');
          return (
            <button key={t.label} type="button" role="radio" aria-checked={on} disabled={disabled} title={t.hint} onClick={() => onChange(t.v)}
              className={`h-8 px-3 rounded-lg border text-[13px] flex items-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${on ? 'bg-raised border-fg/60 text-fg font-medium' : 'border-line text-fg-2 hover:border-line-strong hover:text-fg'}`}>
              <span className={`w-2 h-2 rounded-full ${t.dot}`} />{t.label}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-fg-3 mt-2 max-w-[60ch]">{cur.hint}{note ? <> {note}</> : null}</p>
    </div>
  );
}
