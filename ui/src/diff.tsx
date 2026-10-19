import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, FileMinus, FilePlus, FileText, ArrowRightLeft } from 'lucide-react';

// Git-style diff viewer: one section per file, additions green, removals
// red, hunk headers muted. Parses the unified diff the daemon returns.

export interface DiffFile {
  path: string; from?: string; status: 'A' | 'M' | 'D' | 'R' | 'B';
  hunks: { header: string; lines: { t: '+' | '-' | ' ' | '\\'; text: string; oldNo?: number; newNo?: number }[] }[];
  added: number; removed: number; binary: boolean;
}

export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let f: DiffFile | null = null;
  let oldNo = 0, newNo = 0;
  for (const line of (diff ?? '').split('\n')) {
    const head = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (head) {
      f = { path: head[2], status: 'M', hunks: [], added: 0, removed: 0, binary: false };
      if (head[1] !== head[2]) { f.from = head[1]; f.status = 'R'; }
      files.push(f);
      continue;
    }
    if (!f) continue;
    if (line.startsWith('new file mode')) { f.status = 'A'; continue; }
    if (line.startsWith('deleted file mode')) { f.status = 'D'; continue; }
    if (line.startsWith('rename from ')) { f.from = line.slice(12); f.status = 'R'; continue; }
    if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) { f.binary = true; continue; }
    if (/^(index |similarity |rename to |old mode|new mode|--- |\+\+\+ )/.test(line)) continue;
    const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (h) { oldNo = +h[1]; newNo = +h[2]; f.hunks.push({ header: line, lines: [] }); continue; }
    const hunk = f.hunks[f.hunks.length - 1];
    if (!hunk) continue;
    const t = line[0] as '+' | '-' | ' ' | '\\';
    if (t === '+') { hunk.lines.push({ t, text: line.slice(1), newNo: newNo++ }); f.added++; }
    else if (t === '-') { hunk.lines.push({ t, text: line.slice(1), oldNo: oldNo++ }); f.removed++; }
    else if (t === '\\') hunk.lines.push({ t, text: line.slice(1) });
    else if (line.length || hunk.lines.length) hunk.lines.push({ t: ' ', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
  }
  return files;
}

const STATUS: Record<string, { label: string; cls: string; icon: React.ElementType }> = {
  A: { label: 'created', cls: 'text-ok', icon: FilePlus },
  D: { label: 'deleted', cls: 'text-bad', icon: FileMinus },
  R: { label: 'renamed', cls: 'text-info', icon: ArrowRightLeft },
  M: { label: 'modified', cls: 'text-fg-3', icon: FileText },
};

export function DiffStat({ added, removed }: { added: number; removed: number }) {
  return <span className="num text-2xs"><span className="text-ok">+{added}</span> <span className="text-bad">−{removed}</span></span>;
}

function FileSection({ f, open: initial }: { f: DiffFile; open: boolean }) {
  const [open, setOpen] = useState(initial);
  const st = STATUS[f.status] ?? STATUS.M;
  return (
    <section className="border border-line rounded-lg overflow-hidden">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-2 px-3 py-2 bg-raised/60 text-left text-xs hover:bg-raised">
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <st.icon size={13} className={st.cls} />
        <span className="mono text-fg truncate">{f.from ? <>{f.from} <span className="text-fg-4">→</span> {f.path}</> : f.path}</span>
        <span className={`text-2xs ${st.cls}`}>{st.label}</span>
        <span className="ml-auto"><DiffStat added={f.added} removed={f.removed} /></span>
      </button>
      {open && (
        <div className="bg-sunken/40 min-w-0 font-mono text-[11.5px] leading-[18px]">
          {f.binary && <div className="px-3 py-2 text-xs text-fg-4">Binary file — contents not shown.</div>}
          {!f.binary && !f.hunks.length && <div className="px-3 py-2 text-xs text-fg-4">{f.status === 'R' ? 'Renamed without content changes.' : 'No textual changes.'}</div>}
          {f.hunks.map((h, i) => (
            <div key={i}>
              <div className="px-3 py-0.5 text-fg-4 bg-info/[0.05] select-none">{h.header}</div>
              {h.lines.map((l, j) => (
                <div key={j} className={`flex ${l.t === '+' ? 'bg-ok/[0.12]' : l.t === '-' ? 'bg-bad/[0.12]' : ''}`}>
                  <span className="w-10 shrink-0 pr-2 text-right text-fg-4 select-none num">{l.oldNo ?? ''}</span>
                  <span className="w-10 shrink-0 pr-2 text-right text-fg-4 select-none num">{l.newNo ?? ''}</span>
                  <span className={`min-w-0 flex-1 pr-3 whitespace-pre-wrap break-words [overflow-wrap:anywhere] ${l.t === '+' ? 'text-ok' : l.t === '-' ? 'text-bad' : l.t === '\\' ? 'text-fg-4 italic' : 'text-fg-2'}`}>
                    <span className="select-none">{l.t === ' ' || l.t === '\\' ? ' ' : l.t}</span>{l.text}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function DiffView({ diff, empty = 'No changes.', maxOpen = 6 }: { diff: string; empty?: string; maxOpen?: number }) {
  const files = useMemo(() => parseDiff(diff), [diff]);
  const [filter, setFilter] = useState('');
  const shown = files.filter((f) => !filter || f.path.toLowerCase().includes(filter.toLowerCase()));
  if (!files.length) return <div className="text-xs text-fg-4 py-2">{empty}</div>;
  const added = files.reduce((n, f) => n + f.added, 0); const removed = files.reduce((n, f) => n + f.removed, 0);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs text-fg-3 flex-wrap">
        <span>{files.length} file{files.length === 1 ? '' : 's'}</span><DiffStat added={added} removed={removed} />
        {files.length > 3 && <input className="input input-sm ml-auto w-44" placeholder="Filter files…" value={filter} onChange={(e) => setFilter(e.target.value)} />}
      </div>
      {shown.map((f, i) => <FileSection key={`${f.path}|${i}`} f={f} open={i < maxOpen} />)}
    </div>
  );
}
