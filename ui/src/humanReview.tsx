import React, { useState } from 'react';
import { get, post } from './api';
import { Tag, act, toast, type Tone } from './components';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, CircleHelp, ExternalLink, Play, RefreshCw, Square, XCircle } from 'lucide-react';

// The review you do before approving a Human approval step: the agent's report, what the engine itself verified (the app,
// every screen it proposed, the log), buttons to open each screen, and the app's own controls.

const STATUS: Record<string, { tone: Tone; label: string }> = {
  ready: { tone: 'ok', label: 'App running' }, degraded: { tone: 'warn', label: 'App running, with problems' }, failed: { tone: 'bad', label: 'App not running' },
};
const SEV: Record<string, Tone> = { high: 'bad', medium: 'warn', low: 'idle' };
const RESULT_ICON: Record<string, React.ReactNode> = {
  pass: <CheckCircle2 size={13} className="text-ok shrink-0 mt-0.5" />, fail: <XCircle size={13} className="text-bad shrink-0 mt-0.5" />, unknown: <CircleHelp size={13} className="text-fg-4 shrink-0 mt-0.5" />,
};

export function HumanReview({ approval, onChanged }: { approval: any; onChanged?: () => void }) {
  const p = approval.payload ?? {};
  const rep = p.report ?? {};
  const [app, setApp] = useState<any>(p.app ?? null);
  const [log, setLog] = useState<string[] | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = approval.status === 'pending';
  const st = STATUS[rep.appStatus] ?? STATUS.failed;

  const control = async (action: 'restart' | 'stop' | 'open', url?: string) => {
    setBusy(true);
    const r = await act(post(`/approvals/${approval.id}/app`, { action, url }), action === 'restart' ? 'App restarted' : action === 'stop' ? 'App stopped' : undefined);
    setBusy(false);
    if (r) { if (r.app) setApp({ ...app, ...r.app }); if (r.log) setLog(r.log); onChanged?.(); }
  };
  const toggleLog = async () => {
    const next = !showLog; setShowLog(next);
    if (next) { try { const r = await get<any>(`/approvals/${approval.id}/app`); setLog(r.log ?? []); if (r.app) setApp((a: any) => ({ ...a, ...r.app })); } catch { setLog(p.logTail ?? []); } }
  };
  const appState = app?.state ?? p.app?.state;
  const running = appState === 'ready' || appState === 'starting';

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 flex-wrap">
        <Tag tone={st.tone}>{st.label}</Tag>
        {app?.url && <span className="mono text-xs text-fg-3 truncate">{app.url}</span>}
        {rep.agent && <span className="text-xs text-fg-4">report by {rep.agent}</span>}
        {pending && (
          <span className="ml-auto flex gap-1">
            <button className="btn btn-xs" disabled={busy} onClick={() => control('restart')} title="Start the app again (fresh state)"><RefreshCw size={11} /> Restart</button>
            {running && <button className="btn btn-xs" disabled={busy} onClick={() => control('stop')} title="Stop the app"><Square size={11} /> Stop</button>}
          </span>
        )}
      </div>
      {app?.note && appState !== 'ready' && <p className="text-xs text-fg-3">{app.note}</p>}

      <p className="text-[15px] text-fg leading-snug whitespace-pre-wrap">{rep.summary}</p>

      <div>
        <div className="eyebrow mb-2">Screens to test</div>
        <ul className="space-y-1.5">
          {(p.routes ?? []).map((r: any) => (
            <li key={r.path} className="rounded-lg border border-line px-3 py-2 flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm text-fg">{r.label} <span className="mono text-xs text-fg-4">{r.path}</span></div>
                {r.why && <div className="text-xs text-fg-3">{r.why}</div>}
              </div>
              {r.probe && (
                <Tag tone={r.probe.status != null && r.probe.status < 400 ? 'ok' : r.probe.status != null && r.probe.status < 500 ? 'warn' : 'bad'} title="Checked by the engine, not the agent">
                  {r.probe.status != null ? `HTTP ${r.probe.status}` : 'no answer'}
                </Tag>
              )}
              {r.url && (
                <>
                  <a className="btn btn-xs" href={r.reviewUrl ?? r.url} target="_blank" rel="noreferrer"><ExternalLink size={11} /> Open</a>
                </>
              )}
            </li>
          ))}
          {!(p.routes ?? []).length && <li className="text-xs text-fg-4">No screens were proposed.</li>}
        </ul>
        {pending && app?.url && running && <button className="btn btn-sm mt-2" disabled={busy} onClick={() => control('open', p.routes?.[0]?.reviewUrl ?? p.routes?.[0]?.url)}><Play size={12} /> Open the app with the review panel</button>}
      </div>

      {(rep.howToTest ?? []).length > 0 && (
        <div>
          <div className="eyebrow mb-2">How to test</div>
          <ol className="space-y-1 list-decimal pl-5 text-sm text-fg-2">{rep.howToTest.map((h: string, i: number) => <li key={i}>{h}</li>)}</ol>
        </div>
      )}

      {(rep.changes ?? []).length > 0 && (
        <div>
          <div className="eyebrow mb-2">What changed</div>
          <ul className="space-y-1 text-sm text-fg-2 list-disc pl-5">{rep.changes.map((c: string, i: number) => <li key={i}>{c}</li>)}</ul>
        </div>
      )}

      <div>
        <div className="eyebrow mb-2">Testing</div>
        {(rep.testing ?? []).length === 0 && <p className="text-xs text-fg-4">The agent reported no checks of its own.</p>}
        <ul className="space-y-1.5">
          {(rep.testing ?? []).map((t: any, i: number) => (
            <li key={i} className="flex gap-2 text-sm text-fg-2">{RESULT_ICON[t.result] ?? RESULT_ICON.unknown}<span><span>{t.what}</span>{t.notes && <span className="text-fg-4"> — {t.notes}</span>}</span></li>
          ))}
        </ul>
      </div>

      <div>
        <div className="eyebrow mb-2">Issues found</div>
        {(rep.issues ?? []).length === 0 && <p className="text-sm text-fg-2 flex items-center gap-2"><CheckCircle2 size={13} className="text-ok" /> None reported, none found by the engine's own checks.</p>}
        <ul className="space-y-1.5">
          {(rep.issues ?? []).map((i: any, k: number) => (
            <li key={k} className="flex items-start gap-2 text-sm">
              <AlertTriangle size={13} className={`mt-0.5 shrink-0 ${i.severity === 'high' ? 'text-bad' : i.severity === 'medium' ? 'text-warn' : 'text-fg-4'}`} />
              <span className="text-fg-2 flex-1">{i.message}</span>
              <Tag tone={SEV[i.severity] ?? 'idle'}>{i.severity}</Tag>
              {i.source === 'engine' && <Tag tone="info" title="Found by the engine itself, not claimed by the agent">verified</Tag>}
            </li>
          ))}
        </ul>
      </div>

      <div>
        <button className="flex items-center gap-1 text-xs text-fg-3 hover:text-fg" onClick={toggleLog}>
          {showLog ? <ChevronDown size={13} /> : <ChevronRight size={13} />} App log{(p.errorLines ?? []).length ? <span className="text-bad ml-1">· {(p.errorLines ?? []).length} error line(s)</span> : null}
        </button>
        {showLog && (
          <pre className="mono text-[11px] leading-[16px] whitespace-pre-wrap break-words bg-sunken border border-line rounded-lg p-3 mt-2 max-h-64 overflow-auto text-fg-2">
            {(log ?? p.logTail ?? []).map((l: string, i: number) => <div key={i} className={/error|exception|unhandled|fatal|EADDRINUSE|ECONNREFUSED/i.test(l) ? 'text-bad' : ''}>{l}</div>)}
            {!(log ?? p.logTail ?? []).length && '(no output)'}
          </pre>
        )}
        {app?.logFile && <p className="text-2xs text-fg-4 mt-1.5 mono break-all">full log: {app.logFile}</p>}
      </div>
    </div>
  );
}

/** Review history on a task page: who decided what, in which round, and what the feedback was. */
export function HumanDecisions({ decisions }: { decisions: { at: string; nodeLabel: string; decision: 'approved' | 'rejected'; feedback: string; round: number }[] }) {
  return (
    <ol className="space-y-3">
      {decisions.map((d) => (
        <li key={`${d.round}-${d.at}`} className="flex gap-3 min-w-0">
          <span className="mono text-fg-4 pt-px shrink-0">{String(d.round).padStart(2, '0')}</span>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Tag tone={d.decision === 'approved' ? 'ok' : 'bad'}>{d.decision === 'approved' ? 'Approved' : 'Rejected'}</Tag>
              <span className="text-xs text-fg-4">{d.nodeLabel} · {new Date(d.at).toLocaleString()}</span>
            </div>
            {d.feedback ? <p className="text-sm text-fg-2 whitespace-pre-wrap break-words [overflow-wrap:anywhere] mt-1">{d.feedback}</p> : <p className="text-xs text-fg-4 mt-1">No comment.</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}

export { toast };
