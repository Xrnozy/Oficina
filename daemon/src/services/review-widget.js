/* Oficina review widget. Served by the review proxy and injected into every page of the app under test.
   It talks only to its own origin (/__oficina/*), keeps its styles inside a shadow root, and never blocks the page. */
(() => {
  if (window.__oficinaReview) return;
  window.__oficinaReview = true;
  const me = document.currentScript;
  const token = me && me.src ? new URL(me.src).searchParams.get('t') || '' : '';
  const API = '/__oficina';
  const store = {
    get(k) { try { return localStorage.getItem('oficina.' + k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem('oficina.' + k, v); } catch (e) { /* storage may be blocked */ } },
  };
  const ui = { min: store.get('min') === '1', side: store.get('side') === 'left' ? 'left' : 'right', mode: 'review', confirm: false, busy: false, error: '', draft: '', withPage: true, data: null, offline: false, seen: false };
  let lastSig = '', lastApproval = null;

  const css = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .root { position: fixed; bottom: 16px; z-index: 2147483647; font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg); --bg: #ffffff; --fg: #1b1f24; --fg2: #57606a; --line: #d0d7de; --soft: #f6f8fa; --accent: #1f6feb; --accent-fg: #fff; --ok: #1a7f37; --warn: #9a6700; --bad: #cf222e; }
    .root.right { right: 16px; } .root.left { left: 16px; }
    @media (prefers-color-scheme: dark) { .root { --bg: #161b22; --fg: #e6edf3; --fg2: #9da7b3; --line: #30363d; --soft: #21262d; --accent: #4493f8; --accent-fg: #0b1220; --ok: #3fb950; --warn: #d29922; --bad: #f85149; } }
    .panel { width: min(360px, calc(100vw - 32px)); max-height: min(78vh, 640px); display: flex; flex-direction: column; background: var(--bg); border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 8px 28px rgba(0,0,0,.28); overflow: hidden; }
    header { display: flex; align-items: center; gap: 8px; padding: 10px 10px 10px 14px; border-bottom: 1px solid var(--line); }
    header .t { flex: 1; min-width: 0; } header .t b { display: block; font-size: 13px; } header .t span { display: block; color: var(--fg2); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--fg2); flex: none; } .dot.ready { background: var(--warn); } .dot.ok { background: var(--ok); } .dot.bad { background: var(--bad); }
    button { font: inherit; color: inherit; cursor: pointer; }
    .icon { width: 30px; height: 30px; border: 0; border-radius: 8px; background: transparent; color: var(--fg2); display: grid; place-items: center; font-size: 16px; line-height: 1; }
    .icon:hover { background: var(--soft); color: var(--fg); }
    button:focus-visible, a:focus-visible, textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .body { padding: 12px 14px; overflow: auto; flex: 1; display: flex; flex-direction: column; gap: 12px; }
    .sum { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
    h4 { margin: 0 0 4px; font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: var(--fg2); font-weight: 600; }
    ul, ol { margin: 0; padding-left: 18px; } li { margin: 2px 0; overflow-wrap: anywhere; }
    ul.plain { list-style: none; padding: 0; }
    .route { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border: 1px solid var(--line); border-radius: 8px; margin-bottom: 4px; text-decoration: none; color: inherit; }
    .route:hover { background: var(--soft); } .route.here { border-color: var(--accent); }
    .route span.n { flex: 1; min-width: 0; overflow-wrap: anywhere; } .route small { color: var(--fg2); display: block; }
    .chip { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--line); color: var(--fg2); white-space: nowrap; }
    .chip.ok { color: var(--ok); border-color: var(--ok); } .chip.warn { color: var(--warn); border-color: var(--warn); } .chip.bad { color: var(--bad); border-color: var(--bad); }
    details summary { cursor: pointer; color: var(--fg2); font-size: 12px; } details[open] summary { margin-bottom: 4px; }
    footer { padding: 10px 14px 12px; border-top: 1px solid var(--line); display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .btn { border: 1px solid var(--line); background: var(--soft); border-radius: 8px; padding: 7px 12px; font-weight: 600; }
    .btn:hover { border-color: var(--fg2); } .btn[disabled] { opacity: .55; cursor: default; }
    .btn.go { background: var(--ok); border-color: var(--ok); color: #fff; } .btn.no { color: var(--bad); border-color: var(--bad); background: transparent; }
    .btn.send { background: var(--bad); border-color: var(--bad); color: #fff; }
    textarea { width: 100%; min-height: 96px; resize: vertical; font: inherit; color: inherit; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 8px; }
    label { font-weight: 600; display: block; margin-bottom: 4px; } .hint { color: var(--fg2); font-size: 12px; margin: 4px 0 0; }
    .err { color: var(--bad); font-size: 12px; margin: 4px 0 0; } .note { margin: 0; color: var(--fg2); }
    .check { display: flex; gap: 6px; align-items: center; font-weight: 400; margin: 6px 0 0; }
    .pill { display: flex; align-items: center; gap: 8px; border: 1px solid var(--line); background: var(--bg); border-radius: 999px; padding: 8px 14px 8px 12px; box-shadow: 0 4px 16px rgba(0,0,0,.25); font-weight: 600; }
    .pill:hover { background: var(--soft); }
    .quote { margin: 0; padding: 6px 10px; border-left: 3px solid var(--line); color: var(--fg2); white-space: pre-wrap; overflow-wrap: anywhere; }
    @media (prefers-reduced-motion: no-preference) { .panel, .pill { animation: pop .14s ease-out; } @keyframes pop { from { opacity: 0; transform: translateY(6px); } } }
  `;

  const host = document.createElement('div');
  host.setAttribute('data-oficina-review', '');
  const shadow = host.attachShadow({ mode: 'open' });
  try { const sheet = new CSSStyleSheet(); sheet.replaceSync(css); shadow.adoptedStyleSheets = [sheet]; }
  catch (e) { const s = document.createElement('style'); s.textContent = css; shadow.appendChild(s); }
  const root = document.createElement('div');
  shadow.appendChild(root);
  const attach = () => { (document.body || document.documentElement).appendChild(host); };
  if (document.body) attach(); else document.addEventListener('DOMContentLoaded', attach);

  const h = (tag, props, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  };

  const call = async (path, body) => {
    const res = await fetch(API + path, {
      method: body ? 'POST' : 'GET', cache: 'no-store',
      headers: body ? { 'content-type': 'application/json', 'x-oficina-token': token } : { 'x-oficina-token': token },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || 'Request failed (' + res.status + ')');
    return json;
  };

  const set = (patch) => { Object.assign(ui, patch); render(true); };
  const minimize = (v) => { ui.min = v; store.set('min', v ? '1' : '0'); if (!v) ui.seen = true; render(true); };
  const dock = () => { ui.side = ui.side === 'right' ? 'left' : 'right'; store.set('side', ui.side); render(true); };
  const here = () => location.pathname + location.search;

  async function decide(approve) {
    const reason = ui.draft.trim();
    if (!approve && !reason) { set({ error: 'Say what is wrong or what should be better. The agents work from your words.' }); return; }
    set({ busy: true, error: '' });
    try {
      await call('/decide', { approve, reason, page: !approve && ui.withPage ? here() : '' });
      ui.draft = ''; ui.mode = 'review'; ui.confirm = false; ui.busy = false;
      await poll();
    } catch (e) { set({ busy: false, error: e.message }); }
  }

  function viewReady(d) {
    const rep = d.report || {};
    const status = { ready: ['ok', 'App running'], degraded: ['warn', 'App running, with problems'], failed: ['bad', 'App not running'] }[rep.appStatus] || ['warn', 'Check the app'];
    const body = [];
    body.push(h('div', {}, h('span', { class: 'chip ' + status[0] }, status[1]), d.round > 1 ? h('span', { class: 'chip', style: 'margin-left:6px' }, 'Review ' + d.round) : null));
    body.push(h('p', { class: 'sum', text: rep.summary || '' }));
    if ((d.routes || []).length) {
      body.push(h('div', {}, h('h4', {}, 'Pages to test'), (d.routes).map((r) => {
        const probe = r.probe && r.probe.status != null ? r.probe.status : null;
        const cur = r.path.split('?')[0] === location.pathname;
        return h('a', { class: 'route' + (cur ? ' here' : ''), href: r.path, 'aria-current': cur ? 'page' : null },
          h('span', { class: 'n' }, r.label, r.why ? h('small', {}, r.why) : null),
          probe != null ? h('span', { class: 'chip ' + (probe < 400 ? 'ok' : probe < 500 ? 'warn' : 'bad') }, String(probe)) : h('span', { class: 'chip bad' }, 'no answer'));
      })));
    }
    if ((rep.howToTest || []).length) body.push(h('div', {}, h('h4', {}, 'How to test'), h('ol', {}, rep.howToTest.map((x) => h('li', { text: x })))));
    const issues = rep.issues || [];
    body.push(h('div', {}, h('h4', {}, 'Issues found'), issues.length
      ? h('ul', {}, issues.map((i) => h('li', {}, h('span', { class: 'chip ' + (i.severity === 'high' ? 'bad' : i.severity === 'medium' ? 'warn' : '') }, i.severity), ' ', i.message)))
      : h('p', { class: 'note' }, 'None reported.')));
    if ((rep.changes || []).length) body.push(h('details', {}, h('summary', {}, 'What changed (' + rep.changes.length + ')'), h('ul', {}, rep.changes.map((x) => h('li', { text: x })))));
    const past = (d.history || []).filter((x) => x.decision === 'rejected');
    if (past.length) body.push(h('details', {}, h('summary', {}, 'Your earlier feedback (' + past.length + ')'), past.map((x) => h('p', { class: 'quote', text: 'Review ' + x.round + ': ' + x.feedback }))));
    return body;
  }

  function footerReady() {
    if (ui.mode === 'reject') {
      const ta = h('textarea', { id: 'fb', 'aria-label': 'What is wrong or what should be better', placeholder: 'What did you see? What should be different?', oninput: (e) => { ui.draft = e.target.value; } });
      ta.value = ui.draft;
      return h('div', { style: 'width:100%' },
        h('label', { for: 'fb' }, 'What is wrong, or what should be better?'), ta,
        h('p', { class: 'hint' }, 'The agents read your words and the app log, fix it, and send you a new review.'),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: ui.withPage ? true : null, onchange: (e) => { ui.withPage = e.target.checked; } }), 'Tell them I was on ' + here()),
        ui.error ? h('p', { class: 'err', role: 'alert', text: ui.error }) : null,
        h('div', { style: 'display:flex;gap:8px;margin-top:8px' },
          h('button', { class: 'btn send', disabled: ui.busy ? true : null, onclick: () => decide(false) }, ui.busy ? 'Sending...' : 'Send to the agents'),
          h('button', { class: 'btn', disabled: ui.busy ? true : null, onclick: () => set({ mode: 'review', error: '' }) }, 'Back')));
    }
    if (ui.confirm) {
      return h('div', { style: 'width:100%' }, h('p', { class: 'note', style: 'margin-bottom:8px' }, 'Approve this work? The task moves on.'),
        ui.error ? h('p', { class: 'err', role: 'alert', text: ui.error }) : null,
        h('div', { style: 'display:flex;gap:8px' },
          h('button', { class: 'btn go', disabled: ui.busy ? true : null, onclick: () => decide(true) }, ui.busy ? 'Approving...' : 'Yes, approve'),
          h('button', { class: 'btn', disabled: ui.busy ? true : null, onclick: () => set({ confirm: false, error: '' }) }, 'Back')));
    }
    return h('div', { style: 'display:flex;gap:8px;width:100%' },
      h('button', { class: 'btn go', style: 'flex:1', onclick: () => set({ confirm: true }) }, 'Approve'),
      h('button', { class: 'btn no', style: 'flex:1', onclick: () => set({ mode: 'reject' }) }, 'Request changes'));
  }

  function render(force) {
    const d = ui.data;
    const sig = JSON.stringify([d, ui.min, ui.side, ui.mode, ui.confirm, ui.busy, ui.error, ui.offline, here()]);
    if (!force && sig === lastSig) return;
    lastSig = sig;
    const hadFocus = shadow.activeElement && shadow.activeElement.id === 'fb';
    root.className = 'root ' + ui.side;
    root.replaceChildren();
    const phase = d ? d.phase : 'preparing';
    const tone = phase === 'ready' ? 'ready' : phase === 'decided' && d.last && d.last.decision === 'approved' ? 'ok' : phase === 'closed' ? '' : '';
    const label = { preparing: 'Getting ready', ready: 'Needs your decision', decided: d && d.last && d.last.decision === 'approved' ? 'Approved' : 'Sent back for fixes', closed: 'Review over' }[phase];
    if (ui.min) {
      root.append(h('button', { class: 'pill', title: 'Open the review panel (Alt+Shift+R)', 'aria-label': 'Open the review panel. ' + label, onclick: () => minimize(false) },
        h('span', { class: 'dot ' + tone }), 'Review', h('span', { class: 'chip' }, label)));
      return;
    }
    const kids = [];
    if (phase === 'ready' && d) kids.push(...viewReady(d));
    else if (phase === 'decided' && d && d.last) {
      if (d.last.decision === 'approved') kids.push(h('p', { class: 'sum', text: 'Approved. The task moves on. You can close this tab.' }));
      else kids.push(h('p', { class: 'sum', text: 'Sent to the agents. They are fixing it now. This page reloads when the next review is ready.' }), h('p', { class: 'quote', text: d.last.feedback }));
    } else if (phase === 'closed') kids.push(h('p', { class: 'sum', text: (d && d.message) || 'This review is over.' }));
    else kids.push(h('p', { class: 'sum', text: 'The agent is checking the app and writing the review. This panel updates by itself.' }));
    if (ui.offline) kids.push(h('p', { class: 'err', role: 'status', text: 'Lost contact with Oficina. Trying again.' }));
    const panel = h('section', { class: 'panel', role: 'region', 'aria-label': 'Oficina review' },
      h('header', {}, h('span', { class: 'dot ' + tone }),
        h('div', { class: 't' }, h('b', {}, 'Oficina review'), h('span', {}, (d && d.title) || label)),
        h('button', { class: 'icon', title: 'Move to the ' + (ui.side === 'right' ? 'left' : 'right'), 'aria-label': 'Move panel to the other side', onclick: dock }, ui.side === 'right' ? '←' : '→'),
        h('button', { class: 'icon', title: 'Minimize (Esc)', 'aria-label': 'Minimize the review panel', onclick: () => minimize(true) }, '–')),
      h('div', { class: 'body', 'aria-live': 'polite' }, kids),
      phase === 'ready' ? h('footer', {}, footerReady()) : null);
    root.append(panel);
    if (hadFocus || (ui.mode === 'reject' && force && !lastApproval)) { const ta = shadow.getElementById('fb'); if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } }
  }

  async function poll() {
    try {
      const d = await call('/state');
      ui.offline = false;
      if (d.phase === 'ready' && d.approvalId && lastApproval && d.approvalId !== lastApproval) { location.reload(); return; }
      if (d.phase === 'ready' && d.approvalId) lastApproval = d.approvalId;
      if (d.phase === 'ready' && !ui.seen && !ui.data) ui.seen = ui.min ? false : true;
      ui.data = d;
    } catch (e) { ui.offline = true; }
    render(false);
  }

  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.shiftKey && (e.key === 'R' || e.key === 'r')) { e.preventDefault(); minimize(!ui.min); }
    else if (e.key === 'Escape' && !ui.min && e.composedPath().includes(host)) minimize(true);
  });
  render(true);
  poll();
  setInterval(() => { if (!document.hidden) poll(); }, 2500);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
})();
