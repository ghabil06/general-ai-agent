/**
 * LARPTECH AI Command Center — Redesigned v2.0
 * Interactive dashboard powered by Anime.js v4.5.0
 * Features: Splash screen, particle canvas, radial gauge,
 *   batch execution, session history, live clock, section nav
 */

/* ─── Safe Anime.js v4 wrapper ────────────────────── */
function anim(targets, opts) {
  try {
    if (typeof anime !== 'undefined') {
      if (typeof anime.animate === 'function') return anime.animate(targets, opts);
      if (typeof anime === 'function')        return anime({ targets, ...opts });
    }
  } catch (_) { /* silent */ }
  return null;
}
function stagger(val, opts) {
  try {
    if (typeof anime !== 'undefined' && typeof anime.stagger === 'function') return anime.stagger(val, opts);
  } catch (_) { /* silent */ }
  return 0;
}

/* ─── State ──────────────────────────────────────── */
const S = {
  agent:        'svc_03',
  cases:        [],
  caseIdx:      0,
  executing:    false,
  prompts:      {},
  promptTab:    'main',
  sessionRuns:  0,
  injBlocked:   0,
  gatesPassed:  0,
  history:      [],
  startTime:    Date.now()
};

/* ─── Agent Configs ──────────────────────────────── */
const AGENTS = {
  svc_03: { name: 'Accounts Payable', cap: 500, unit: '$', metric: 'case_amount', defVal: 450,
             guardLabel: '$500 Cap',     ruleText: 'Strictly bounded to invoices ≤ $500.00 with verified PO.' },
  svc_04: { name: 'Security Triage',   cap: 12,  unit: 'Lvl ', metric: 'case_rule_level', defVal: 6,
             guardLabel: 'Level 12',     ruleText: 'Alerts ≥ Level 12 cannot be closed; SOC escalation mandatory.' },
  svc_06: { name: 'Paper Trading',     cap: 10000, unit: '$', metric: 'case_notional', defVal: 9450,
             guardLabel: '$10k Cap',     ruleText: 'Orders strictly bounded to simulated paper accounts. Notional ≤ $10,000.' }
};

/* ═══ Bootstrap ═══════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  runSplash();
  drawParticleCanvas();
  startClock();
  bindAgentCards();
  bindLab();
  bindGates();
  bindPromptTabs();
  bindBatchModal();
  loadOverview();
  loadCases(S.agent);
  loadPrompts(S.agent);
  loadAuditLogs();
});

/* ─── Splash Sequence ────────────────────────────── */
function runSplash() {
  // Animate splash words
  document.querySelectorAll('.splash-word').forEach((el, i) => {
    anim(el, { opacity: [0, 1], translateY: [20, 0], duration: 500, delay: 200 + i * 200, ease: 'outQuart' });
  });
  // Animate progress bar
  anim('#splash-bar', { width: ['0%', '100%'], duration: 1600, delay: 200, ease: 'inOutQuart' });
  // Hide splash
  setTimeout(() => {
    const overlay = document.getElementById('splash-overlay');
    overlay.classList.add('hidden');
    document.getElementById('app').classList.add('visible');
    anim('#app', { opacity: [0, 1], duration: 600, ease: 'outQuad' });
    entranceAnimations();
  }, 2000);
}

function entranceAnimations() {
  // Topbar
  anim('#topbar', { translateY: [-20, 0], opacity: [0, 1], duration: 500, ease: 'outQuart' });
  // Stat cards stagger
  anim('.stat-card', { translateY: [30, 0], opacity: [0, 1], duration: 500, delay: stagger(80), ease: 'outQuart' });
  // Agent cards
  anim('.agent-card', { scale: [0.92, 1], opacity: [0, 1], duration: 400, delay: stagger(100, { start: 300 }), ease: 'outBack(1.6)' });
  // Pipeline nodes
  anim('.pipe-node', { translateY: [25, 0], opacity: [0, 1], duration: 400, delay: stagger(80, { start: 500 }), ease: 'outQuart' });
  // Panels
  anim('.glass', { translateY: [15, 0], opacity: [0, 1], duration: 400, delay: stagger(60, { start: 700 }), ease: 'outQuart' });
}

/* ─── Particle Canvas ────────────────────────────── */
function drawParticleCanvas() {
  const canvas = document.getElementById('particle-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let w, h, particles = [];
  const PARTICLE_COUNT = 50;

  function resize() { w = canvas.width = window.innerWidth; h = canvas.height = window.innerHeight; }
  resize();
  window.addEventListener('resize', resize);

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    particles.push({ x: Math.random() * w, y: Math.random() * h, r: Math.random() * 1.5 + 0.5,
      vx: (Math.random() - 0.5) * 0.3, vy: (Math.random() - 0.5) * 0.3, o: Math.random() * 0.35 + 0.1 });
  }

  (function loop() {
    ctx.clearRect(0, 0, w, h);
    for (const p of particles) {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0) p.x = w; if (p.x > w) p.x = 0;
      if (p.y < 0) p.y = h; if (p.y > h) p.y = 0;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(0, 224, 255, ${p.o})`;
      ctx.fill();
    }
    // Draw faint lines between nearby particles
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx = particles[i].x - particles[j].x, dy = particles[i].y - particles[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 150) {
          ctx.beginPath();
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          ctx.strokeStyle = `rgba(0, 224, 255, ${0.04 * (1 - dist / 150)})`;
          ctx.lineWidth = 0.5;
          ctx.stroke();
        }
      }
    }
    requestAnimationFrame(loop);
  })();
}

/* ─── Live Clock & Uptime ────────────────────────── */
function startClock() {
  function tick() {
    const now = new Date();
    document.getElementById('live-clock').textContent = now.toLocaleTimeString('en-US', { hour12: false });
    const s = Math.floor((Date.now() - S.startTime) / 1000);
    const m = Math.floor(s / 60);
    document.getElementById('uptime-val').textContent = m > 0 ? `${m}m${s % 60}s` : `${s}s`;
  }
  tick();
  setInterval(tick, 1000);
}

/* ─── Agent Cards ────────────────────────────────── */
function bindAgentCards() {
  document.querySelectorAll('.agent-card').forEach(card => {
    card.addEventListener('click', () => {
      const id = card.dataset.agent;
      if (id === S.agent) return;
      document.querySelectorAll('.agent-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      anim(card, { scale: [0.96, 1.03, 1], duration: 400, ease: 'outBack(1.5)' });
      S.agent = id;
      S.caseIdx = 0;
      updateAgentContext();
      loadCases(id);
      loadPrompts(id);
    });
  });
}

function updateAgentContext() {
  const cfg = AGENTS[S.agent];
  document.getElementById('pn4-label').textContent = cfg.guardLabel;
  resetStages();
  resetVerdict();
}

/* ─── Load Overview ──────────────────────────────── */
async function loadOverview() {
  try {
    const r = await fetch('/api/overview');
    const d = await r.json();
    if (d.stats) {
      document.getElementById('stat-cases-num').textContent = d.stats.totalCases || 36;
    }
  } catch (e) { console.error(e); }
}

/* ─── Cases ──────────────────────────────────────── */
async function loadCases(agent) {
  const sel = document.getElementById('case-select');
  sel.innerHTML = '<option>Loading…</option>';
  try {
    const r = await fetch(`/api/cases?agent=${agent}`);
    const d = await r.json();
    S.cases = d.cases || [];
    sel.innerHTML = '';
    S.cases.forEach((c, i) => {
      const o = document.createElement('option');
      o.value = i; o.textContent = c.description || `Case #${i + 1}`;
      sel.appendChild(o);
    });
    document.getElementById('case-count-chip').textContent = `${S.cases.length} Cases`;
    document.getElementById('batch-count').textContent = S.cases.length;
    if (S.cases.length) displayCase(0);
  } catch (e) { sel.innerHTML = '<option>Error</option>'; }
}

function displayCase(idx) {
  S.caseIdx = idx;
  const c = S.cases[idx]; if (!c) return;
  const v = c.vars || {};
  const cat = v.case_category || (v.case_injection ? 'injection' : 'standard');
  const exp = v.expected_action || 'review';
  const text = v.invoice_data || v.alert_data || v.market_data || '';

  const catEl = document.getElementById('cis-category');
  catEl.textContent = cat;
  catEl.className = 'cis-val chip' + (cat.includes('injection') ? ' chip-red' : cat.includes('over') ? ' chip-amber' : '');

  const expEl = document.getElementById('cis-expected');
  expEl.textContent = exp;
  expEl.className = 'cis-val chip' + (exp.includes('approve') || exp.includes('execute') || exp.includes('close') ? ' chip-green' : ' chip-amber');

  document.getElementById('case-desc').textContent = c.description || 'Test scenario';
  document.getElementById('payload-ta').value = text;

  anim('#case-info-strip', { opacity: [0.5, 1], translateY: [6, 0], duration: 300, ease: 'outQuad' });
  updateRadialGauge(c);
}

/* ─── Radial Gauge ───────────────────────────────── */
function updateRadialGauge(caseObj) {
  const cfg = AGENTS[S.agent];
  const v = caseObj?.vars || {};
  let val = cfg.defVal;
  if (S.agent === 'svc_03') val = v.case_amount ?? 450;
  else if (S.agent === 'svc_04') val = v.case_rule_level ?? 6;
  else val = v.case_notional ?? 9450;

  const cap = cfg.cap;
  const ratio = Math.min(val / cap, 1);
  const circumference = 2 * Math.PI * 52; // r=52
  const dashLen = ratio * circumference;
  const isOver = val > cap;

  const arc = document.getElementById('gauge-arc');
  arc.style.strokeDasharray = `${dashLen}, ${circumference}`;
  arc.style.stroke = isOver ? '#f43f5e' : '#34d399';

  const valEl = document.getElementById('gauge-val');
  valEl.textContent = cfg.unit === '$' ? `$${val.toLocaleString()}` : `${cfg.unit}${val}`;
  document.getElementById('gauge-cap').textContent = cfg.unit === '$' ? `/ $${cap.toLocaleString()}` : `/ ${cfg.unit}${cap}`;

  const label = document.getElementById('gauge-label');
  label.textContent = isOver ? 'EXCEEDS BOUNDARY' : 'WITHIN BOUNDARY';
  label.style.color = isOver ? '#f43f5e' : '#34d399';

  anim('#radial-gauge', { scale: [0.96, 1.02, 1], duration: 400, ease: 'outBack(1.5)' });
}

/* ─── Lab Events ─────────────────────────────────── */
function bindLab() {
  document.getElementById('case-select').addEventListener('change', e => displayCase(+e.target.value));
  document.getElementById('btn-reset').addEventListener('click', () => displayCase(S.caseIdx));
  document.getElementById('btn-execute').addEventListener('click', () => execSimulation());
  document.getElementById('btn-clear-history').addEventListener('click', () => {
    S.history = [];
    document.getElementById('eh-list').innerHTML = '<div class="eh-empty">No executions yet.</div>';
  });
}

/* ─── Execute Simulation ─────────────────────────── */
async function execSimulation() {
  if (S.executing) return;
  S.executing = true;
  const btn = document.getElementById('btn-execute');
  btn.classList.add('running');
  btn.querySelector('.btn-execute-text').textContent = 'Executing…';
  resetStages();
  resetVerdict();

  animatePipeline();

  try {
    const res = await fetch('/api/simulate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: S.agent, caseIndex: S.caseIdx, customText: document.getElementById('payload-ta').value })
    });
    const data = await res.json();
    setTimeout(() => {
      renderResults(data);
      S.sessionRuns++;
      if (data.hasInjection) S.injBlocked++;
      updateStats();
      addToHistory(data);
      btn.classList.remove('running');
      btn.querySelector('.btn-execute-text').textContent = 'Execute Agent Workflow';
      S.executing = false;
    }, 1200);
  } catch (e) {
    console.error(e);
    btn.classList.remove('running');
    btn.querySelector('.btn-execute-text').textContent = 'Execute Agent Workflow';
    S.executing = false;
  }
}

/* ─── Pipeline Animation ─────────────────────────── */
function animatePipeline() {
  const nodes = document.querySelectorAll('.pipe-node');
  nodes.forEach((n, i) => {
    setTimeout(() => {
      n.classList.add('active');
      anim(n, { scale: [1, 1.12, 1], translateY: [0, -8, 0], duration: 500, ease: 'outBack(2)' });
      setTimeout(() => { n.classList.remove('active'); n.classList.add('done'); }, 400);
    }, i * 200);
  });
}

/* ─── Render Results ─────────────────────────────── */
function renderResults(data) {
  const { decision, stages, guardrailPassed, hasInjection, auditRow, totalDurationMs } = data;

  // Duration
  document.getElementById('dbox-dur').textContent = `${totalDurationMs} ms`;
  anim('#dbox-dur', { scale: [0.7, 1.15, 1], duration: 300, ease: 'outBack(2)' });

  // Stages
  const stgEls = document.querySelectorAll('.stg');
  stgEls.forEach((el, i) => {
    const sd = stages[i];
    if (sd) {
      el.classList.add(sd.status === 'warning' ? 'warn' : sd.status === 'error' ? 'err' : 'done');
      const ms = el.querySelector('.stg-ms');
      if (ms) ms.textContent = `${sd.durationMs}ms`;

      const det = document.getElementById(`stg${i}-d`);
      if (det) {
        if (sd.id === 'prompt_assembly' && hasInjection) det.textContent = 'INJECTION DETECTED — Neutralized';
        else if (sd.id === 'guardrail_check') det.textContent = guardrailPassed ? 'Dual Check: VALIDATED' : 'BREACH DETECTED';
        else if (sd.id === 'decision_engine') det.textContent = `Action: ${decision.action}`;
        else det.textContent = sd.detail || 'Completed';
      }
    }
  });
  anim('.stg', { translateX: [-8, 0], opacity: [0.4, 1], delay: stagger(70), duration: 300, ease: 'outQuad' });

  // Decision JSON
  document.getElementById('dbox-code').textContent = JSON.stringify(decision, null, 2);
  anim('#dbox-code', { opacity: [0.2, 1], duration: 300 });

  // Verdict
  const vc = document.getElementById('verdict-chip');
  const action = decision.action || '';
  vc.className = 'verdict-chip';
  if (['auto_approve', 'execute_trade', 'close_false_positive'].includes(action)) {
    vc.classList.add('approved');
    vc.innerHTML = `<span class="vc-icon">✓</span><span class="vc-text">${action.toUpperCase()}</span>`;
  } else if (['request_human_approval', 'escalate_incident'].includes(action)) {
    vc.classList.add('escalated');
    vc.innerHTML = `<span class="vc-icon">⚠️</span><span class="vc-text">${action.toUpperCase()}</span>`;
  } else {
    vc.classList.add('blocked');
    vc.innerHTML = `<span class="vc-icon">🛑</span><span class="vc-text">${action.toUpperCase()}</span>`;
  }
  anim(vc, { scale: [0.5, 1.12, 1], opacity: [0, 1], duration: 500, ease: 'outElastic(1, 0.5)' });

  // Audit SQL
  if (auditRow) {
    document.getElementById('sql-code').textContent =
      `INSERT INTO agents.audit_log (agent_id, action, amount_resolved, guardrail_verdict, injection_flag, status) ` +
      `VALUES ('${auditRow.agent_id}', '${auditRow.action}', ${auditRow.amount_resolved}, '${auditRow.guardrail_verdict}', ${auditRow.injection_flag}, '${auditRow.status}');`;
    anim('#sql-preview', { borderColor: ['rgba(0,224,255,0.6)', 'rgba(255,255,255,0.06)'], duration: 1200 });
  }

  // Also refresh audit logs
  loadAuditLogs();
}

function resetStages() {
  document.querySelectorAll('.stg').forEach(el => {
    el.classList.remove('done', 'warn', 'err');
    const ms = el.querySelector('.stg-ms'); if (ms) ms.textContent = '--';
  });
  document.querySelectorAll('.pipe-node').forEach(n => n.classList.remove('active', 'done', 'warn'));
}

function resetVerdict() {
  const vc = document.getElementById('verdict-chip');
  vc.className = 'verdict-chip';
  vc.innerHTML = '<span class="vc-icon">⏳</span><span class="vc-text">STANDBY</span>';
}

function updateStats() {
  document.getElementById('stat-sims-num').textContent = S.sessionRuns;
  document.getElementById('stat-inject-num').textContent = S.injBlocked;
  document.getElementById('stat-gates-num').textContent = S.gatesPassed;
  // Bounce the changed stats
  anim('#stat-sims', { scale: [0.95, 1.05, 1], duration: 300, ease: 'outBack(1.5)' });
  if (S.injBlocked > 0) anim('#stat-inject', { scale: [0.95, 1.05, 1], duration: 300, ease: 'outBack(1.5)' });
}

/* ─── Execution History ──────────────────────────── */
function addToHistory(data) {
  const now = new Date().toLocaleTimeString('en-US', { hour12: false });
  const item = { time: now, agent: S.agent, action: data.decision.action, guardrail: data.guardrailPassed ? 'PASS' : 'FAIL' };
  S.history.unshift(item);
  if (S.history.length > 30) S.history.pop();

  const list = document.getElementById('eh-list');
  list.innerHTML = '';
  S.history.forEach(h => {
    const colorClass = h.guardrail === 'PASS' ? 'text-emerald' : 'text-crimson';
    const div = document.createElement('div');
    div.className = 'eh-item';
    div.innerHTML = `<span class="eh-time">${h.time}</span>
      <span class="eh-agent chip chip-cyan">${h.agent.toUpperCase()}</span>
      <span class="eh-action">${h.action}</span>
      <span class="eh-result ${colorClass}">${h.guardrail}</span>`;
    list.appendChild(div);
  });

  anim('.eh-item:first-child', { translateX: [-12, 0], opacity: [0, 1], duration: 300, ease: 'outQuad' });
}

/* ─── Batch Execution (NEW FEATURE) ──────────────── */
function bindBatchModal() {
  const modal = document.getElementById('batch-modal');
  document.getElementById('btn-batch').addEventListener('click', () => runBatch());
  document.getElementById('btn-close-batch').addEventListener('click', () => { modal.style.display = 'none'; });
  modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; });
}

async function runBatch() {
  if (S.cases.length === 0) return;
  const modal = document.getElementById('batch-modal');
  const tbody = document.getElementById('batch-tbody');
  const summary = document.getElementById('batch-summary');
  const progress = document.getElementById('batch-progress-fill');
  modal.style.display = 'flex';
  tbody.innerHTML = '';
  progress.style.width = '0%';
  summary.textContent = `Running ${S.cases.length} cases for ${S.agent.toUpperCase()}…`;

  anim('.modal', { scale: [0.9, 1], opacity: [0, 1], duration: 400, ease: 'outBack(1.5)' });

  let matches = 0, injections = 0;
  for (let i = 0; i < S.cases.length; i++) {
    try {
      const r = await fetch('/api/simulate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: S.agent, caseIndex: i, customText: '' })
      });
      const d = await r.json();
      const expected = S.cases[i].vars?.expected_action || '?';
      const got = d.decision.action;
      const match = expected === got;
      if (match) matches++;
      if (d.hasInjection) injections++;

      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${i + 1}</td><td>${S.cases[i].description || '-'}</td><td>${expected}</td>
        <td>${got}</td><td class="${match ? 'text-emerald' : 'text-crimson'}">${match ? '✓' : '✗'}</td>
        <td>${d.hasInjection ? '🛡️' : '—'}</td>`;
      tbody.appendChild(tr);
    } catch (e) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${i + 1}</td><td colspan="5" class="text-crimson">Error: ${e.message}</td>`;
      tbody.appendChild(tr);
    }
    progress.style.width = `${((i + 1) / S.cases.length * 100).toFixed(0)}%`;
  }

  const pct = ((matches / S.cases.length) * 100).toFixed(1);
  summary.innerHTML = `<strong>${matches}/${S.cases.length} matched</strong> (${pct}%) · <span class="text-crimson">${injections} injections blocked</span>`;
  S.sessionRuns += S.cases.length;
  S.injBlocked += injections;
  updateStats();
}

/* ─── Quality Gates ──────────────────────────────── */
function bindGates() {
  const gateMap = [
    { btn: 'gb-1', gate: 'validate_all', status: 'gs-1' },
    { btn: 'gb-2', gate: 'test_nodes',   status: 'gs-2' },
    { btn: 'gb-3', gate: 'replay',       status: 'gs-3' }
  ];

  gateMap.forEach(({ btn, gate, status }) => {
    const el = document.getElementById(btn);
    if (el) el.addEventListener('click', () => runGate(gate, status, el));
  });

  document.getElementById('btn-run-all-gates').addEventListener('click', async () => {
    for (const g of gateMap) {
      await runGate(g.gate, g.status, document.getElementById(g.btn));
    }
  });

  document.getElementById('btn-clear-term').addEventListener('click', () => {
    document.getElementById('term-body').textContent = 'Console cleared.';
  });
}

async function runGate(gate, statusId, btnEl) {
  const statusEl = document.getElementById(statusId);
  const term = document.getElementById('term-body');

  statusEl.className = 'gc-status running';
  statusEl.querySelector('.gs-text').textContent = 'RUNNING…';
  anim(btnEl, { scale: [1, 0.9, 1], duration: 250 });
  term.textContent += `\n\n$ Gate: ${gate}...\n`;

  try {
    const r = await fetch('/api/run-gate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gate })
    });
    const d = await r.json();
    term.textContent += `${d.stdout || ''}${d.stderr || ''}`;
    term.scrollTop = term.scrollHeight;

    if (d.success) {
      statusEl.className = 'gc-status passed';
      statusEl.querySelector('.gs-text').textContent = `PASSED (${d.durationMs}ms)`;
      S.gatesPassed++;
      updateStats();
      anim(statusEl, { scale: [0.9, 1.05, 1], duration: 350, ease: 'outBack(2)' });
    } else {
      statusEl.className = 'gc-status failed';
      statusEl.querySelector('.gs-text').textContent = `FAILED (${d.code})`;
    }
  } catch (e) {
    statusEl.className = 'gc-status failed';
    statusEl.querySelector('.gs-text').textContent = 'ERROR';
    term.textContent += `\nError: ${e.message}\n`;
  }
}

/* ─── Prompt Tabs ────────────────────────────────── */
function bindPromptTabs() {
  const main = document.getElementById('ptab-main');
  const guard = document.getElementById('ptab-guard');
  main.addEventListener('click', () => {
    main.classList.add('active'); guard.classList.remove('active');
    S.promptTab = 'main'; renderPrompt();
  });
  guard.addEventListener('click', () => {
    guard.classList.add('active'); main.classList.remove('active');
    S.promptTab = 'guardrail'; renderPrompt();
  });
}

async function loadPrompts(agent) {
  try {
    const r = await fetch(`/api/prompts?agent=${agent}`);
    S.prompts = await r.json();
    renderPrompt();
  } catch (e) { console.error(e); }
}

function renderPrompt() {
  const el = document.getElementById('policy-code');
  el.textContent = S.promptTab === 'main'
    ? (S.prompts.promptText || 'No prompt loaded.')
    : (S.prompts.guardrailText || 'No secondary guardrail specified.');
  anim(el, { opacity: [0.3, 1], duration: 250 });
}

/* ─── Audit Logs ─────────────────────────────────── */
async function loadAuditLogs() {
  try {
    const r = await fetch('/api/audit-logs');
    const d = await r.json();
    const rows = d.rows || [];
    const tbody = document.getElementById('audit-tbody');
    tbody.innerHTML = '';
    document.getElementById('audit-chip').textContent = `${rows.length} records`;
    rows.forEach(row => {
      const tr = document.createElement('tr');
      const acClass = (row.action || '').includes('approve') ? 'chip-green' : 'chip-amber';
      const vClass = row.verdict === 'PASSED' ? 'chip-green' : 'chip-red';
      tr.innerHTML = `<td>${row.timestamp || '—'}</td>
        <td><span class="chip chip-cyan">${row.agent_id || '—'}</span></td>
        <td><span class="chip ${acClass}">${row.action || '—'}</span></td>
        <td>${row.amount ? '$' + row.amount : '—'}</td>
        <td>${row.amount_source || '—'}</td>
        <td><span class="chip ${vClass}">COMPLIANT</span></td>`;
      tbody.appendChild(tr);
    });
    anim('.data-table tr', { opacity: [0, 1], translateX: [-6, 0], delay: stagger(30), duration: 250 });
  } catch (e) { console.error(e); }
}
