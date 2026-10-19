import { Select } from '../Select';
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '../api';
import { Empty, PageHeader, SevChip, Skeleton, StatusChip, fmtAgo } from '../components';
import { ShieldCheck } from 'lucide-react';

const SEVS = ['critical', 'high', 'medium', 'low'];
const STATUSES = ['open', 'assigned', 'fixing', 'verifying', 'resolved', 'reopened', 'escalated', 'wontfix'];

export default function Errors() {
  const [sev, setSev] = useState('');
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const { data: errors, loading } = useQuery<any[]>('/errors');
  const all = errors ?? [];
  const list = all.filter((e) => (!sev || e.severity === sev) && (!status || e.status === status)
    && (!q || `${e.id} ${e.title} ${e.signature}`.toLowerCase().includes(q.toLowerCase())));

  return (
    <div>
      <PageHeader title="Error reports" sub="Raised from failing deterministic checks, deduplicated by signature, and matched against the knowledge base of past fixes." />

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <input className="input input-sm w-56" placeholder="Search title, ID or signature…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="flex gap-1">
          {SEVS.map((s) => {
            const n = all.filter((e) => e.severity === s).length;
            return (
              <button key={s} onClick={() => setSev(sev === s ? '' : s)} className={`h-7 px-2.5 rounded-md text-xs border transition-colors ${sev === s ? 'bg-raised border-line-strong text-fg' : 'border-transparent text-fg-3 hover:text-fg'}`}>
                {s} <span className="text-fg-4 num ml-0.5">{n}</span>
              </button>
            );
          })}
        </div>
        <Select className="input input-sm" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">Any status</option>
          {STATUSES.map((s) => <option key={s}>{s}</option>)}
        </Select>
        <span className="text-xs text-fg-4 ml-auto num">{list.length} of {all.length}</span>
      </div>

      {loading && <Skeleton rows={4} />}
      {!loading && !list.length && (
        <Empty icon={ShieldCheck} title={all.length ? 'Nothing matches' : 'No error reports'} text={all.length ? 'Try clearing a filter.' : "Deterministic checks haven't failed, or everything has been resolved."} />
      )}
      {list.length > 0 && (
        <div className="panel divide-line overflow-hidden">
          {list.map((e) => (
            <Link key={e.id} to={`/errors/${e.id}`} className="row">
              <SevChip sev={e.severity} />
              <div className="flex-1 min-w-0">
                <div className="text-sm text-fg truncate">{e.title}</div>
                <div className="text-2xs text-fg-4 mono truncate">{e.id} · sig {e.signature?.slice(0, 12)}</div>
              </div>
              <span className="text-xs text-fg-3 num hidden sm:block">attempt {e.assignment?.attempt ?? 0}/{e.assignment?.maxAttempts ?? 3}</span>
              <StatusChip value={e.status} />
              <span className="text-2xs text-fg-4 w-14 text-right num hidden md:block">{fmtAgo(e.updatedAt ?? e.createdAt)}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
