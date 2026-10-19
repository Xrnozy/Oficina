import React from 'react';
import { useQuery } from '../api';
import { Empty, PageHeader, Skeleton, fmtAgo, useCurrentRun } from '../components';
import { FileText } from 'lucide-react';

// Project record (spec 2): the PM's plan, requirements, assignments,
// progress, decisions and open issues — always current, no model calls.

function inline(s: string): React.ReactNode[] {
  return s.split(/(\*\*[^*]+\*\*|`[^`]+`|_[^_]+_)/g).map((p, i) => {
    if (p.startsWith('**')) return <strong key={i} className="text-fg font-medium">{p.slice(2, -2)}</strong>;
    if (p.startsWith('`')) return <code key={i} className="mono text-fg-2 bg-sunken px-1 rounded">{p.slice(1, -1)}</code>;
    if (p.startsWith('_') && p.endsWith('_') && p.length > 2) return <em key={i} className="text-fg-4">{p.slice(1, -1)}</em>;
    return p;
  });
}

function Markdown({ text }: { text: string }) {
  const out: React.ReactNode[] = [];
  let list: React.ReactNode[] = [];
  const flush = () => { if (list.length) { out.push(<ul key={out.length} className="space-y-1.5 my-2">{list}</ul>); list = []; } };
  text.split('\n').forEach((line, i) => {
    if (line.startsWith('- ')) {
      const body = line.slice(2);
      const box = body.match(/^\[( |x)\] (.*)$/);
      list.push(
        <li key={i} className="flex gap-2 text-sm text-fg-2 leading-relaxed">
          {box ? <span className={`mt-1 w-3.5 h-3.5 rounded border shrink-0 grid place-items-center text-[9px] ${box[1] === 'x' ? 'bg-ok border-ok text-white' : 'border-line-strong'}`}>{box[1] === 'x' ? '✓' : ''}</span> : <span className="text-fg-4 mt-0.5">•</span>}
          <span className="min-w-0">{inline(box ? box[2] : body)}</span>
        </li>,
      );
      return;
    }
    flush();
    if (line.startsWith('# ')) out.push(<h2 key={i} className="text-lg font-semibold mb-1">{inline(line.slice(2))}</h2>);
    else if (line.startsWith('## ')) out.push(<h3 key={i} className="eyebrow mt-6 mb-1 pb-1.5 border-b border-line">{line.slice(3)}</h3>);
    else if (line.trim()) out.push(<p key={i} className="text-sm text-fg-3">{inline(line)}</p>);
  });
  flush();
  return <div>{out}</div>;
}

export default function Project() {
  const { run } = useCurrentRun();
  const { data: doc, loading } = useQuery<any>(run ? `/runs/${run.id}/project-doc` : null, [run?.id]);
  if (!run) return <Empty icon={FileText} title="No run yet" text="The project record starts with the PM's first plan." />;
  return (
    <div>
      <PageHeader title="Project record" sub="Plan, requirements, assignments, progress, decisions and open issues for the current run. Built from the PM's plan notes and prompt reviews plus the engine's records, so it never goes stale and costs no model calls.">
        {doc && <span className="text-xs text-fg-4">updated {fmtAgo(doc.generatedAt)}</span>}
        {doc && <button className="btn btn-sm" onClick={() => {
          const url = URL.createObjectURL(new Blob([doc.markdown], { type: 'text/markdown' }));
          const a = document.createElement('a'); a.href = url; a.download = `project-${run.id}.md`; a.click(); URL.revokeObjectURL(url);
        }}>Download .md</button>}
      </PageHeader>
      {loading && !doc ? <Skeleton rows={6} /> : doc && <article className="panel p-6 max-w-[900px]"><Markdown text={doc.markdown} /></article>}
    </div>
  );
}
