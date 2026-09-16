(() => {
  'use strict';

  const cfg = window.CLEANIT_CONFIG || {};
  const configReady = cfg.SUPABASE_URL && cfg.SUPABASE_KEY && !cfg.SUPABASE_URL.includes('TU-PROYECTO') && !cfg.SUPABASE_KEY.includes('TU_PUBLISHABLE');
  const client = configReady ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  }) : null;

  const state = {
    session: null,
    profile: null,
    currentView: 'dashboard',
    activeAudit: null,
    activeResponses: [],
    activeChecklist: [],
    history: [],
    charts: { classification: null, sections: null },
    modals: {}
  };

  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const el = id => document.getElementById(id);

  const esc = (v = '') => String(v)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

  const todayISO = () => {
    const d = new Date();
    const z = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
  };

  const fmtDate = (v) => {
    if (!v) return '—';
    const [y, m, d] = String(v).slice(0, 10).split('-');
    return y && m && d ? `${d}/${m}/${y}` : v;
  };

  const fmtDateTime = (v) => v ? new Intl.DateTimeFormat('es-AR', {
    dateStyle: 'short', timeStyle: 'short'
  }).format(new Date(v)) : '—';

  const pct = (v) => Number.isFinite(Number(v)) ? `${Number(v).toFixed(1)}%` : '—';

  const roleLabel = role => role === 'admin' ? 'Administrador' : 'Auditor';
  const statusLabel = status => status === 'completed' ? 'Completada' : 'Borrador';

  const classificationClass = (c) => {
    if (c === 'Conforme') return 'badge-soft-success';
    if (c === 'Conforme con observaciones') return 'badge-soft-warning';
    if (c === 'No conforme') return 'badge-soft-danger';
    return 'badge-soft-neutral';
  };

  function toast(message, type = 'dark') {
    const id = `t_${Date.now()}`;
    const html = `<div id="${id}" class="toast align-items-center text-bg-${type} border-0" role="alert">
      <div class="d-flex"><div class="toast-body">${esc(message)}</div><button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button></div>
    </div>`;
    el('toastContainer').insertAdjacentHTML('beforeend', html);
    const node = el(id);
    const t = bootstrap.Toast.getOrCreateInstance(node, { delay: 3200 });
    node.addEventListener('hidden.bs.toast', () => node.remove());
    t.show();
  }

  function loading(on) {
    let node = el('loadingOverlay');
    if (on && !node) {
      document.body.insertAdjacentHTML('beforeend', `<div id="loadingOverlay" class="loading-overlay"><div class="spinner-border" role="status"></div></div>`);
    } else if (!on && node) node.remove();
  }

  async function safe(call, fallbackMessage = 'Ocurrió un error') {
    try {
      const res = await call();
      if (res?.error) throw res.error;
      return res;
    } catch (err) {
      console.error(err);
      toast(err?.message || fallbackMessage, 'danger');
      throw err;
    }
  }

  function setView(name, { load = true } = {}) {
    if ((name === 'checklistAdmin' || name === 'usersAdmin') && state.profile?.role !== 'admin') name = 'dashboard';
    state.currentView = name;
    $$('.app-view').forEach(v => v.classList.add('d-none'));
    el(`view-${name}`)?.classList.remove('d-none');
    $$('#mainNav .nav-link').forEach(b => b.classList.toggle('active', b.dataset.view === name));
    el('sidebar').classList.remove('open');

    const titles = {
      dashboard: ['Panel', 'Resumen de desempeño de auditorías.'],
      newAudit: ['Nueva auditoría', 'Registro digital y guardado automático.'],
      history: ['Historial', 'Trazabilidad y consulta de resultados.'],
      checklistAdmin: ['Checklist', 'Administración de secciones e ítems.'],
      usersAdmin: ['Usuarios', 'Roles de acceso.'],
      auditDetail: ['Detalle de auditoría', 'Resultado, evidencia y descarga.']
    };
    const [title, sub] = titles[name] || ['', ''];
    el('pageTitle').textContent = title;
    el('pageSubtitle').textContent = sub;

    if (!load) return;
    if (name === 'dashboard') loadDashboard();
    if (name === 'history') loadHistory();
    if (name === 'checklistAdmin') loadChecklistAdmin();
    if (name === 'usersAdmin') loadUsersAdmin();
    if (name === 'newAudit' && !state.activeAudit) resetNewAuditView();
  }

  async function init() {
    el('auditDate').value = todayISO();
    bindGlobalEvents();
    state.modals.section = new bootstrap.Modal(el('sectionModal'));
    state.modals.item = new bootstrap.Modal(el('itemModal'));

    if (!configReady) {
      el('loginView').classList.remove('d-none');
      el('configurationWarning').classList.remove('d-none');
      el('loginError').textContent = 'Primero configurá Supabase en assets/js/config.js.';
      el('loginError').classList.remove('d-none');
      el('loginBtn').disabled = true;
      return;
    }

    const { data: { session } } = await client.auth.getSession();
    state.session = session;
    if (session) await enterApp();
    else showLogin();

    client.auth.onAuthStateChange(async (_event, sessionNew) => {
      state.session = sessionNew;
      if (!sessionNew) showLogin();
    });
  }

  function bindGlobalEvents() {
    el('loginForm').addEventListener('submit', login);
    el('logoutBtn').addEventListener('click', logout);
    el('mobileMenuBtn').addEventListener('click', () => el('sidebar').classList.toggle('open'));
    $$('#mainNav .nav-link').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
    $$('[data-nav]').forEach(b => b.addEventListener('click', () => setView(b.dataset.nav)));

    el('auditStartForm').addEventListener('submit', startAudit);
    el('finalizeAuditBtn').addEventListener('click', finalizeAudit);
    el('exitDraftBtn').addEventListener('click', async () => {
      await saveGeneralNotes();
      state.activeAudit = null;
      state.activeResponses = [];
      setView('history');
    });
    el('executionGeneralNotes').addEventListener('change', saveGeneralNotes);

    ['historyFrom', 'historyTo', 'historyStatus', 'historySearch'].forEach(id => {
      el(id).addEventListener(id === 'historySearch' ? 'input' : 'change', renderHistory);
    });

    el('addSectionBtn').addEventListener('click', () => openSectionModal());
    el('sectionForm').addEventListener('submit', saveSection);
    el('itemForm').addEventListener('submit', saveItem);
  }

  function showLogin() {
    el('appView').classList.add('d-none');
    el('loginView').classList.remove('d-none');
  }

  async function enterApp() {
    loading(true);
    try {
      const { data, error } = await client.from('profiles').select('*').eq('id', state.session.user.id).single();
      if (error) throw error;
      state.profile = data;
      el('loginView').classList.add('d-none');
      el('appView').classList.remove('d-none');
      el('sidebarUserName').textContent = data.full_name || data.email;
      el('sidebarUserRole').textContent = roleLabel(data.role);
      el('topbarRoleBadge').textContent = roleLabel(data.role);
      $$('.admin-only').forEach(n => n.classList.toggle('d-none', data.role !== 'admin'));
      setView('dashboard');
    } catch (e) {
      showLogin();
      el('loginError').textContent = 'No se pudo cargar el perfil del usuario. Verificá que hayas ejecutado schema.sql.';
      el('loginError').classList.remove('d-none');
    } finally { loading(false); }
  }

  async function login(ev) {
    ev.preventDefault();
    el('loginError').classList.add('d-none');
    el('loginBtn').disabled = true;
    el('loginBtn').textContent = 'Ingresando…';
    try {
      const { data, error } = await client.auth.signInWithPassword({
        email: el('loginEmail').value.trim(),
        password: el('loginPassword').value
      });
      if (error) throw error;
      state.session = data.session;
      await enterApp();
    } catch (err) {
      el('loginError').textContent = err.message || 'No se pudo iniciar sesión.';
      el('loginError').classList.remove('d-none');
    } finally {
      el('loginBtn').disabled = false;
      el('loginBtn').textContent = 'Ingresar';
    }
  }

  async function logout() {
    await client.auth.signOut();
    state.profile = null;
    state.activeAudit = null;
    state.activeResponses = [];
    showLogin();
  }

  // ============================================================
  // CHECKLIST DATA
  // ============================================================
  async function fetchChecklist(activeOnly = true) {
    let sectionQuery = client.from('audit_sections').select('*').order('sort_order');
    if (activeOnly) sectionQuery = sectionQuery.eq('is_active', true);
    const { data: sections, error: sectionError } = await sectionQuery;
    if (sectionError) throw sectionError;

    let itemQuery = client.from('audit_items').select('*').order('sort_order');
    if (activeOnly) itemQuery = itemQuery.eq('is_active', true);
    const { data: items, error: itemError } = await itemQuery;
    if (itemError) throw itemError;

    return sections.map(s => ({ ...s, items: items.filter(i => i.section_id === s.id) }));
  }

  // ============================================================
  // DASHBOARD
  // ============================================================
  async function loadDashboard() {
    loading(true);
    try {
      const { data: audits, error } = await client
        .from('audits')
        .select('*, auditor:profiles(full_name,email)')
        .eq('status', 'completed')
        .order('audit_date', { ascending: false })
        .limit(500);
      if (error) throw error;

      const total = audits.length;
      const avg = total ? audits.reduce((a, x) => a + Number(x.score || 0), 0) / total : 0;
      const non = audits.filter(x => x.classification === 'No conforme').length;
      const critical = audits.reduce((a, x) => a + Number(x.critical_failures || 0), 0);
      el('kpiTotal').textContent = total;
      el('kpiAverage').textContent = total ? pct(avg) : '—';
      el('kpiNonConform').textContent = non;
      el('kpiCritical').textContent = critical;
      el('dashboardScope').textContent = state.profile.role === 'admin' ? 'Resultados consolidados de todos los auditores.' : 'Resultados de tus auditorías.';

      renderRecentAudits(audits.slice(0, 7));
      renderClassificationChart(audits);
      await renderSectionsChart(audits);
    } catch (e) { console.error(e); }
    finally { loading(false); }
  }

  function renderRecentAudits(audits) {
    const body = el('recentAuditsBody');
    if (!audits.length) {
      body.innerHTML = `<tr><td colspan="6"><div class="empty-state">Todavía no hay auditorías completadas.</div></td></tr>`;
      return;
    }
    body.innerHTML = audits.map(a => `<tr>
      <td>${fmtDate(a.audit_date)}</td>
      <td class="fw-semibold">${esc(a.vehicle_plate || '—')}</td>
      <td>${esc(a.auditor?.full_name || a.auditor?.email || '—')}</td>
      <td><strong>${pct(a.score)}</strong></td>
      <td><span class="badge ${classificationClass(a.classification)}">${esc(a.classification)}</span></td>
      <td class="text-end"><button class="btn btn-sm btn-outline-secondary" onclick="CleanItApp.openAudit('${a.id}')">Ver</button></td>
    </tr>`).join('');
  }

  function renderClassificationChart(audits) {
    const counts = {
      'Conforme': audits.filter(a => a.classification === 'Conforme').length,
      'Conforme con observaciones': audits.filter(a => a.classification === 'Conforme con observaciones').length,
      'No conforme': audits.filter(a => a.classification === 'No conforme').length
    };
    state.charts.classification?.destroy();
    state.charts.classification = new Chart(el('classificationChart'), {
      type: 'doughnut',
      data: { labels: Object.keys(counts), datasets: [{ data: Object.values(counts) }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
    });
  }

  async function renderSectionsChart(audits) {
    state.charts.sections?.destroy();
    if (!audits.length) {
      state.charts.sections = new Chart(el('sectionsChart'), {
        type: 'bar', data: { labels: [], datasets: [{ label: 'Cumplimiento %', data: [] }] },
        options: { responsive: true, maintainAspectRatio: false }
      });
      return;
    }
    const ids = audits.map(a => a.id);
    const { data: rows, error } = await client
      .from('audit_responses')
      .select('audit_id,section_title_snapshot,section_order_snapshot,answer')
      .in('audit_id', ids);
    if (error) throw error;
    const map = new Map();
    rows.forEach(r => {
      if (r.answer === 'na' || !r.answer) return;
      const key = `${r.section_order_snapshot}|${r.section_title_snapshot}`;
      const acc = map.get(key) || { name: r.section_title_snapshot, order: r.section_order_snapshot, yes: 0, total: 0 };
      acc.total += 1;
      if (r.answer === 'complies') acc.yes += 1;
      map.set(key, acc);
    });
    const vals = [...map.values()].sort((a,b) => a.order - b.order);
    state.charts.sections = new Chart(el('sectionsChart'), {
      type: 'bar',
      data: { labels: vals.map(v => v.name.replace(/^\d+\.\s*/, '')), datasets: [{ label: 'Cumplimiento %', data: vals.map(v => v.total ? v.yes / v.total * 100 : 0) }] },
      options: {
        responsive: true, maintainAspectRatio: false, indexAxis: 'y',
        scales: { x: { min: 0, max: 100, ticks: { callback: v => `${v}%` } } },
        plugins: { legend: { display: false } }
      }
    });
  }

  // ============================================================
  // AUDIT EXECUTION
  // ============================================================
  function resetNewAuditView() {
    el('auditStartPanel').classList.remove('d-none');
    el('auditExecutionPanel').classList.add('d-none');
    el('auditStartForm').reset();
    el('auditDate').value = todayISO();
  }

  async function startAudit(ev) {
    ev.preventDefault();
    loading(true);
    try {
      const checklist = await fetchChecklist(true);
      const activeItems = checklist.flatMap(s => s.items);
      if (!activeItems.length) throw new Error('No hay ítems activos en el checklist.');

      const meta = {
        audit_date: el('auditDate').value || todayISO(),
        auditor_id: state.profile.id,
        responsible_name: el('responsibleName').value.trim() || null,
        operators_text: el('operatorsText').value.trim() || null,
        vehicle_plate: el('vehiclePlate').value.trim().toUpperCase() || null,
        general_notes: el('auditGeneralNotes').value.trim() || null,
        status: 'draft'
      };
      const { data: audit, error } = await client.from('audits').insert(meta).select().single();
      if (error) throw error;

      const snapshots = [];
      checklist.forEach(section => section.items.forEach(item => snapshots.push({
        audit_id: audit.id,
        section_id: section.id,
        item_id: item.id,
        section_title_snapshot: section.title,
        section_order_snapshot: section.sort_order,
        item_code_snapshot: item.code,
        item_title_snapshot: item.title,
        criterion_snapshot: item.criterion,
        is_critical_snapshot: item.is_critical,
        item_order_snapshot: item.sort_order,
        answer: null,
        observation: null
      })));
      const { data: responses, error: rError } = await client.from('audit_responses').insert(snapshots).select();
      if (rError) throw rError;

      state.activeAudit = audit;
      state.activeResponses = responses;
      state.activeChecklist = checklist;
      showAuditExecution();
      toast('Auditoría iniciada. Los cambios se guardan automáticamente.', 'success');
    } catch (e) { console.error(e); }
    finally { loading(false); }
  }

  function groupResponses(responses) {
    const groups = new Map();
    [...responses]
      .sort((a,b) => a.section_order_snapshot - b.section_order_snapshot || a.item_order_snapshot - b.item_order_snapshot)
      .forEach(r => {
        const key = `${r.section_order_snapshot}|${r.section_title_snapshot}`;
        if (!groups.has(key)) groups.set(key, { title: r.section_title_snapshot, order: r.section_order_snapshot, rows: [] });
        groups.get(key).rows.push(r);
      });
    return [...groups.values()].sort((a,b) => a.order - b.order);
  }

  function showAuditExecution() {
    el('auditStartPanel').classList.add('d-none');
    el('auditExecutionPanel').classList.remove('d-none');
    const a = state.activeAudit;
    el('activeAuditTitle').textContent = a.vehicle_plate ? `Vehículo ${a.vehicle_plate}` : 'Auditoría operativa Naón';
    el('activeAuditMeta').textContent = `${fmtDate(a.audit_date)} · Auditor: ${state.profile.full_name || state.profile.email}`;
    el('executionGeneralNotes').value = a.general_notes || '';
    renderAuditChecklist();
    updateAuditProgress();
  }

  function renderAuditChecklist() {
    const c = el('auditChecklistContainer');
    c.innerHTML = groupResponses(state.activeResponses).map(group => {
      const answered = group.rows.filter(r => r.answer).length;
      return `<section class="audit-section">
        <div class="audit-section-head"><div><h3 class="h6 mb-1">${esc(group.title)}</h3><div class="small text-secondary">${answered}/${group.rows.length} respondidos</div></div></div>
        ${group.rows.map(r => `<div class="audit-item" data-response-id="${r.id}">
          <div class="d-flex gap-3 align-items-start">
            <div class="audit-item-code">${esc(r.item_code_snapshot || '')}</div>
            <div class="flex-grow-1 min-w-0">
              <div class="d-flex flex-wrap align-items-center gap-2"><div class="audit-item-title">${esc(r.item_title_snapshot)}</div>${r.is_critical_snapshot ? '<span class="critical-pill">Crítico</span>' : ''}</div>
              <div class="audit-criterion">${esc(r.criterion_snapshot)}</div>
              <div class="answer-group mt-3">
                ${answerButton(r,'complies','Cumple')}${answerButton(r,'non_complies','No cumple')}${answerButton(r,'na','N/A')}
                <span class="save-indicator ms-auto align-self-center" data-save-for="${r.id}"></span>
              </div>
              <div class="mt-3">
                <input class="form-control form-control-sm response-observation" data-id="${r.id}" value="${esc(r.observation || '')}" placeholder="Observación / evidencia (opcional)">
              </div>
            </div>
          </div>
        </div>`).join('')}
      </section>`;
    }).join('');

    $$('.answer-btn', c).forEach(btn => btn.addEventListener('click', () => answerResponse(btn.dataset.id, btn.dataset.answer)));
    $$('.response-observation', c).forEach(inp => inp.addEventListener('change', () => saveObservation(inp.dataset.id, inp.value)));
  }

  function answerButton(r, value, label) {
    return `<button type="button" class="answer-btn ${r.answer === value ? 'selected' : ''}" data-id="${r.id}" data-answer="${value}">${label}</button>`;
  }

  async function answerResponse(id, answer) {
    const r = state.activeResponses.find(x => x.id === id);
    if (!r) return;
    const old = r.answer;
    r.answer = answer;
    const row = document.querySelector(`[data-response-id="${id}"]`);
    $$('.answer-btn', row).forEach(b => b.classList.toggle('selected', b.dataset.answer === answer));
    updateAuditProgress();
    const ind = document.querySelector(`[data-save-for="${id}"]`);
    if (ind) ind.textContent = 'Guardando…';
    const { error } = await client.from('audit_responses').update({ answer }).eq('id', id);
    if (error) {
      r.answer = old;
      renderAuditChecklist();
      updateAuditProgress();
      toast(error.message, 'danger');
    } else if (ind) {
      ind.textContent = 'Guardado';
      setTimeout(() => { if (ind) ind.textContent = ''; }, 1000);
    }
  }

  async function saveObservation(id, observation) {
    const r = state.activeResponses.find(x => x.id === id);
    if (r) r.observation = observation.trim() || null;
    const ind = document.querySelector(`[data-save-for="${id}"]`);
    if (ind) ind.textContent = 'Guardando…';
    const { error } = await client.from('audit_responses').update({ observation: observation.trim() || null }).eq('id', id);
    if (error) toast(error.message, 'danger');
    else if (ind) { ind.textContent = 'Guardado'; setTimeout(() => { if (ind) ind.textContent = ''; }, 1000); }
  }

  async function saveGeneralNotes() {
    if (!state.activeAudit) return;
    const value = el('executionGeneralNotes').value.trim() || null;
    state.activeAudit.general_notes = value;
    const { error } = await client.from('audits').update({ general_notes: value }).eq('id', state.activeAudit.id);
    if (error) toast(error.message, 'danger');
  }

  function updateAuditProgress() {
    const total = state.activeResponses.length;
    const answered = state.activeResponses.filter(r => r.answer).length;
    const value = total ? Math.round(answered / total * 100) : 0;
    el('auditProgressText').textContent = `${value}% (${answered}/${total})`;
    el('auditProgressBar').style.width = `${value}%`;
  }

  function calculateAudit(responses) {
    const applicable = responses.filter(r => r.answer && r.answer !== 'na');
    const compliant = applicable.filter(r => r.answer === 'complies').length;
    const noncompliant = applicable.filter(r => r.answer === 'non_complies').length;
    const critical = responses.filter(r => r.answer === 'non_complies' && r.is_critical_snapshot).length;
    const score = applicable.length ? compliant / applicable.length * 100 : 0;
    let classification = score >= 95 ? 'Conforme' : score >= 90 ? 'Conforme con observaciones' : 'No conforme';
    if (critical > 0) classification = 'No conforme';
    return { applicable: applicable.length, compliant, noncompliant, critical, score, classification };
  }

  async function finalizeAudit() {
    const missing = state.activeResponses.filter(r => !r.answer);
    if (missing.length) {
      toast(`Faltan responder ${missing.length} ítems.`, 'warning');
      const first = document.querySelector(`[data-response-id="${missing[0].id}"]`);
      first?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const calc = calculateAudit(state.activeResponses);
    if (!confirm(`Resultado preliminar: ${calc.score.toFixed(1)}% · ${calc.classification}.\n\n¿Finalizar la auditoría? Después quedará bloqueada para preservar trazabilidad.`)) return;
    loading(true);
    try {
      await saveGeneralNotes();
      const payload = {
        status: 'completed', completed_at: new Date().toISOString(), score: Number(calc.score.toFixed(2)),
        classification: calc.classification, critical_failures: calc.critical,
        applicable_items: calc.applicable, compliant_items: calc.compliant, noncompliant_items: calc.noncompliant,
        general_notes: el('executionGeneralNotes').value.trim() || null
      };
      const { data, error } = await client.from('audits').update(payload).eq('id', state.activeAudit.id).select().single();
      if (error) throw error;
      state.activeAudit = null;
      state.activeResponses = [];
      toast('Auditoría finalizada y registrada.', 'success');
      await openAudit(data.id);
    } catch (e) { console.error(e); }
    finally { loading(false); }
  }

  async function continueDraft(id) {
    loading(true);
    try {
      const { data: audit, error } = await client.from('audits').select('*').eq('id', id).single();
      if (error) throw error;
      if (audit.status !== 'draft') return openAudit(id);
      const { data: responses, error: rError } = await client.from('audit_responses').select('*').eq('audit_id', id).order('section_order_snapshot').order('item_order_snapshot');
      if (rError) throw rError;
      state.activeAudit = audit;
      state.activeResponses = responses;
      setView('newAudit', { load: false });
      showAuditExecution();
    } finally { loading(false); }
  }

  // ============================================================
  // HISTORY
  // ============================================================
  async function loadHistory() {
    loading(true);
    try {
      const { data, error } = await client.from('audits').select('*, auditor:profiles(full_name,email)').order('audit_date', { ascending: false }).order('created_at', { ascending: false }).limit(1000);
      if (error) throw error;
      state.history = data;
      renderHistory();
    } catch (e) { console.error(e); }
    finally { loading(false); }
  }

  function renderHistory() {
    const from = el('historyFrom').value;
    const to = el('historyTo').value;
    const status = el('historyStatus').value;
    const search = el('historySearch').value.trim().toLowerCase();
    const rows = state.history.filter(a => {
      if (from && a.audit_date < from) return false;
      if (to && a.audit_date > to) return false;
      if (status && a.status !== status) return false;
      if (search) {
        const hay = `${a.vehicle_plate || ''} ${a.responsible_name || ''} ${a.auditor?.full_name || ''} ${a.auditor?.email || ''}`.toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });
    el('historyBody').innerHTML = rows.length ? rows.map(a => `<tr>
      <td>${fmtDate(a.audit_date)}</td>
      <td class="fw-semibold">${esc(a.vehicle_plate || '—')}</td>
      <td>${esc(a.responsible_name || '—')}</td>
      <td>${esc(a.auditor?.full_name || a.auditor?.email || '—')}</td>
      <td>${a.status === 'completed' ? `<strong>${pct(a.score)}</strong>` : '—'}</td>
      <td><span class="badge ${a.status === 'completed' ? 'badge-soft-success' : 'badge-soft-neutral'}">${statusLabel(a.status)}</span></td>
      <td>${a.classification ? `<span class="badge ${classificationClass(a.classification)}">${esc(a.classification)}</span>` : '—'}</td>
      <td class="text-end">${a.status === 'draft'
        ? `<button class="btn btn-sm btn-dark" onclick="CleanItApp.continueDraft('${a.id}')">Continuar</button>`
        : `<button class="btn btn-sm btn-outline-secondary" onclick="CleanItApp.openAudit('${a.id}')">Ver</button>`}
      </td>
    </tr>`).join('') : `<tr><td colspan="8"><div class="empty-state">No hay auditorías para los filtros seleccionados.</div></td></tr>`;
  }

  // ============================================================
  // DETAIL + PDF
  // ============================================================
  async function openAudit(id) {
    loading(true);
    try {
      const { data: audit, error } = await client.from('audits').select('*, auditor:profiles(full_name,email)').eq('id', id).single();
      if (error) throw error;
      const { data: responses, error: rError } = await client.from('audit_responses').select('*').eq('audit_id', id).order('section_order_snapshot').order('item_order_snapshot');
      if (rError) throw rError;
      setView('auditDetail', { load: false });
      renderAuditDetail(audit, responses);
    } catch (e) { console.error(e); }
    finally { loading(false); }
  }

  function renderAuditDetail(audit, responses) {
    const groups = groupResponses(responses);
    const container = el('auditDetailContainer');
    const completed = audit.status === 'completed';
    container.innerHTML = `
      <div class="d-flex flex-wrap gap-2 justify-content-between align-items-start mb-4">
        <div>
          <button class="btn btn-link px-0 text-secondary text-decoration-none no-print" onclick="CleanItApp.goHistory()">← Volver al historial</button>
          <h1 class="h3 mb-1">Auditoría ${esc(audit.vehicle_plate || 'sin patente')}</h1>
          <div class="text-secondary">${fmtDate(audit.audit_date)} · ${esc(audit.auditor?.full_name || audit.auditor?.email || '—')}</div>
        </div>
        <div class="d-flex gap-2 no-print">
          ${completed ? `<button class="btn btn-dark" onclick="CleanItApp.downloadPdf('${audit.id}')">Descargar informe PDF</button>` : `<button class="btn btn-dark" onclick="CleanItApp.continueDraft('${audit.id}')">Continuar borrador</button>`}
        </div>
      </div>

      <div class="row g-3 mb-4">
        <div class="col-md-4"><div class="audit-summary-card h-100"><div class="text-secondary small text-uppercase fw-bold">Puntaje</div><div class="score-big mt-2">${completed ? pct(audit.score) : '—'}</div><div class="mt-2">${audit.classification ? `<span class="badge ${classificationClass(audit.classification)}">${esc(audit.classification)}</span>` : '<span class="badge badge-soft-neutral">Borrador</span>'}</div></div></div>
        <div class="col-md-4"><div class="audit-summary-card h-100"><div class="text-secondary small text-uppercase fw-bold">Control</div><div class="mt-3"><strong>${audit.compliant_items || 0}</strong> cumple · <strong>${audit.noncompliant_items || 0}</strong> no cumple</div><div class="mt-2"><strong>${audit.critical_failures || 0}</strong> fallas críticas</div></div></div>
        <div class="col-md-4"><div class="audit-summary-card h-100"><div class="text-secondary small text-uppercase fw-bold">Operación</div><div class="mt-3"><strong>Responsable:</strong> ${esc(audit.responsible_name || '—')}</div><div class="mt-1"><strong>Operarios:</strong> ${esc(audit.operators_text || '—')}</div></div></div>
      </div>

      ${groups.map(g => `<section class="audit-section">
        <div class="audit-section-head"><h3 class="h6 mb-0">${esc(g.title)}</h3><div class="small text-secondary">${sectionScore(g.rows)}</div></div>
        ${g.rows.map(r => `<div class="audit-item">
          <div class="d-flex gap-3 align-items-start">
            <div class="audit-item-code">${esc(r.item_code_snapshot || '')}</div>
            <div class="flex-grow-1"><div class="d-flex flex-wrap gap-2"><span class="audit-item-title">${esc(r.item_title_snapshot)}</span>${r.is_critical_snapshot ? '<span class="critical-pill">Crítico</span>' : ''}</div><div class="audit-criterion">${esc(r.criterion_snapshot)}</div>${r.observation ? `<div class="mt-2 small"><strong>Observación:</strong> ${esc(r.observation)}</div>` : ''}</div>
            <div class="detail-answer ${answerTextClass(r.answer)}">${answerText(r.answer)}</div>
          </div>
        </div>`).join('')}
      </section>`).join('')}

      <div class="panel-card p-4 mt-3 mb-5"><h3 class="h6">Observaciones generales</h3><div class="text-secondary">${esc(audit.general_notes || 'Sin observaciones generales.')}</div><div class="small text-secondary mt-3">Inicio: ${fmtDateTime(audit.started_at)}${audit.completed_at ? ` · Cierre: ${fmtDateTime(audit.completed_at)}` : ''}</div></div>
    `;
    container.dataset.audit = JSON.stringify(audit);
    container.dataset.responses = JSON.stringify(responses);
  }

  function sectionScore(rows) {
    const app = rows.filter(r => r.answer && r.answer !== 'na');
    if (!app.length) return 'Sin ítems aplicables';
    const yes = app.filter(r => r.answer === 'complies').length;
    return `${(yes / app.length * 100).toFixed(1)}%`;
  }
  const answerText = a => a === 'complies' ? 'CUMPLE' : a === 'non_complies' ? 'NO CUMPLE' : a === 'na' ? 'N/A' : 'SIN RESPUESTA';
  const answerTextClass = a => a === 'complies' ? 'text-success' : a === 'non_complies' ? 'text-danger' : 'text-secondary';

  async function downloadPdf(id) {
    loading(true);
    try {
      const { data: audit, error } = await client.from('audits').select('*, auditor:profiles(full_name,email)').eq('id', id).single();
      if (error) throw error;
      const { data: responses, error: rError } = await client.from('audit_responses').select('*').eq('audit_id', id).order('section_order_snapshot').order('item_order_snapshot');
      if (rError) throw rError;
      makePdf(audit, responses);
    } catch (e) { console.error(e); }
    finally { loading(false); }
  }

  function makePdf(audit, responses) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const margin = 14;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(18); doc.text('CLEAN IT', margin, 16);
    doc.setFontSize(13); doc.text('Informe de Auditoría Operativa · Naón', margin, 24);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    doc.text(`Fecha: ${fmtDate(audit.audit_date)}    Patente: ${audit.vehicle_plate || '—'}    Auditor: ${audit.auditor?.full_name || audit.auditor?.email || '—'}`, margin, 31);
    doc.text(`Responsable: ${audit.responsible_name || '—'}`, margin, 36);
    doc.text(`Operarios: ${audit.operators_text || '—'}`, margin, 41);

    doc.autoTable({
      startY: 47,
      head: [['Puntaje', 'Resultado', 'Cumple', 'No cumple', 'Fallas críticas']],
      body: [[pct(audit.score), audit.classification || '—', audit.compliant_items || 0, audit.noncompliant_items || 0, audit.critical_failures || 0]],
      theme: 'grid', styles: { fontSize: 9 }, headStyles: { fillColor: [17, 24, 39] }
    });

    groupResponses(responses).forEach(group => {
      const start = doc.lastAutoTable ? doc.lastAutoTable.finalY + 7 : 55;
      doc.autoTable({
        startY: start,
        head: [[group.title, 'Criterio / evidencia', 'Resultado']],
        body: group.rows.map(r => [
          `${r.item_code_snapshot || ''} ${r.item_title_snapshot}${r.is_critical_snapshot ? ' [CRÍTICO]' : ''}`,
          `${r.criterion_snapshot}${r.observation ? `\nObs.: ${r.observation}` : ''}`,
          answerText(r.answer)
        ]),
        theme: 'grid',
        styles: { fontSize: 7.5, cellPadding: 2.2, overflow: 'linebreak' },
        headStyles: { fillColor: [17, 24, 39] },
        columnStyles: { 0: { cellWidth: 52 }, 1: { cellWidth: 103 }, 2: { cellWidth: 27 } },
        margin: { left: margin, right: margin }
      });
    });

    const y = doc.lastAutoTable ? doc.lastAutoTable.finalY + 7 : 60;
    doc.autoTable({
      startY: y,
      head: [['Observaciones generales']],
      body: [[audit.general_notes || 'Sin observaciones generales.']],
      theme: 'grid', styles: { fontSize: 8 }, headStyles: { fillColor: [17, 24, 39] }, margin: { left: margin, right: margin }
    });

    const pages = doc.getNumberOfPages();
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i); doc.setFontSize(7); doc.setTextColor(110);
      doc.text(`Clean It · Auditoría ${audit.id.slice(0,8)} · Página ${i}/${pages}`, margin, 292);
    }
    const plate = (audit.vehicle_plate || 'SIN-PATENTE').replace(/[^a-z0-9-]/gi, '_');
    doc.save(`Auditoria_CleanIt_${fmtDate(audit.audit_date).replaceAll('/','-')}_${plate}.pdf`);
  }

  // ============================================================
  // CHECKLIST ADMIN
  // ============================================================
  async function loadChecklistAdmin() {
    loading(true);
    try {
      const checklist = await fetchChecklist(false);
      el('checklistAdminContainer').innerHTML = checklist.map(s => `<section class="admin-section ${s.is_active ? '' : 'inactive-row'}">
        <div class="admin-section-head">
          <div><div class="d-flex gap-2 align-items-center"><strong>${esc(s.title)}</strong>${s.is_active ? '' : '<span class="badge badge-soft-neutral">Inactiva</span>'}</div><div class="small text-secondary">${esc(s.description || '')}</div></div>
          <div class="admin-actions"><button class="btn btn-sm btn-outline-secondary" onclick="CleanItApp.editSection('${s.id}')">Editar</button><button class="btn btn-sm btn-dark" onclick="CleanItApp.addItem('${s.id}')">+ Ítem</button><button class="btn btn-sm btn-outline-danger" onclick="CleanItApp.deleteSection('${s.id}')">Eliminar</button></div>
        </div>
        ${s.items.length ? s.items.map(i => `<div class="admin-item ${i.is_active ? '' : 'inactive-row'}">
          <div class="fw-bold text-secondary">${esc(i.code || '')}</div>
          <div><div class="d-flex flex-wrap gap-2 align-items-center"><strong>${esc(i.title)}</strong>${i.is_critical ? '<span class="critical-pill">Crítico</span>' : ''}${i.is_active ? '' : '<span class="badge badge-soft-neutral">Inactivo</span>'}</div><div class="small text-secondary mt-1">${esc(i.criterion)}</div></div>
          <div class="admin-actions"><button class="btn btn-sm btn-outline-secondary" onclick="CleanItApp.editItem('${i.id}')">Editar</button><button class="btn btn-sm btn-outline-danger" onclick="CleanItApp.deleteItem('${i.id}')">Eliminar</button></div>
        </div>`).join('') : '<div class="p-3 text-secondary small">Sin ítems.</div>'}
      </section>`).join('') || '<div class="empty-state">No hay secciones.</div>';
      state.activeChecklist = checklist;
    } catch (e) { console.error(e); }
    finally { loading(false); }
  }

  function openSectionModal(section = null) {
    el('sectionModalTitle').textContent = section ? 'Editar sección' : 'Nueva sección';
    el('sectionId').value = section?.id || '';
    el('sectionTitle').value = section?.title || '';
    el('sectionDescription').value = section?.description || '';
    el('sectionOrder').value = section?.sort_order ?? 10;
    el('sectionActive').checked = section?.is_active ?? true;
    state.modals.section.show();
  }

  function editSection(id) {
    const s = state.activeChecklist.find(x => x.id === id);
    if (s) openSectionModal(s);
  }

  async function saveSection(ev) {
    ev.preventDefault();
    const id = el('sectionId').value;
    const payload = {
      title: el('sectionTitle').value.trim(), description: el('sectionDescription').value.trim() || null,
      sort_order: Number(el('sectionOrder').value || 0), is_active: el('sectionActive').checked
    };
    loading(true);
    try {
      const q = id ? client.from('audit_sections').update(payload).eq('id', id) : client.from('audit_sections').insert(payload);
      const { error } = await q;
      if (error) throw error;
      state.modals.section.hide(); toast('Sección guardada.', 'success'); await loadChecklistAdmin();
    } finally { loading(false); }
  }

  function openItemModal(sectionId, item = null) {
    el('itemModalTitle').textContent = item ? 'Editar ítem' : 'Nuevo ítem';
    el('itemId').value = item?.id || '';
    el('itemSectionId').value = sectionId;
    el('itemCode').value = item?.code || '';
    el('itemTitle').value = item?.title || '';
    el('itemCriterion').value = item?.criterion || '';
    el('itemOrder').value = item?.sort_order ?? 10;
    el('itemCritical').checked = item?.is_critical ?? false;
    el('itemActive').checked = item?.is_active ?? true;
    state.modals.item.show();
  }

  function editItem(id) {
    for (const s of state.activeChecklist) {
      const i = s.items.find(x => x.id === id);
      if (i) return openItemModal(s.id, i);
    }
  }

  async function saveItem(ev) {
    ev.preventDefault();
    const id = el('itemId').value;
    const payload = {
      section_id: el('itemSectionId').value, code: el('itemCode').value.trim() || null,
      title: el('itemTitle').value.trim(), criterion: el('itemCriterion').value.trim(),
      sort_order: Number(el('itemOrder').value || 0), is_critical: el('itemCritical').checked, is_active: el('itemActive').checked
    };
    loading(true);
    try {
      const q = id ? client.from('audit_items').update(payload).eq('id', id) : client.from('audit_items').insert(payload);
      const { error } = await q;
      if (error) throw error;
      state.modals.item.hide(); toast('Ítem guardado.', 'success'); await loadChecklistAdmin();
    } finally { loading(false); }
  }

  async function deleteItem(id) {
    if (!confirm('¿Eliminar este ítem? Las auditorías históricas conservarán su texto y resultado, pero el ítem dejará de existir para auditorías nuevas.')) return;
    loading(true);
    try {
      const { error } = await client.from('audit_items').delete().eq('id', id);
      if (error) throw error;
      toast('Ítem eliminado.', 'success'); await loadChecklistAdmin();
    } finally { loading(false); }
  }

  async function deleteSection(id) {
    if (!confirm('¿Eliminar esta sección y sus ítems? El historial conservará las capturas de las auditorías previas.')) return;
    loading(true);
    try {
      const { error } = await client.from('audit_sections').delete().eq('id', id);
      if (error) throw error;
      toast('Sección eliminada.', 'success'); await loadChecklistAdmin();
    } finally { loading(false); }
  }

  // ============================================================
  // USERS ADMIN
  // ============================================================
  async function loadUsersAdmin() {
    loading(true);
    try {
      const { data, error } = await client.from('profiles').select('*').order('created_at');
      if (error) throw error;
      el('usersBody').innerHTML = data.map(p => `<tr>
        <td class="fw-semibold">${esc(p.full_name || '—')}</td><td>${esc(p.email)}</td>
        <td><select class="form-select form-select-sm" style="max-width:160px" onchange="CleanItApp.changeRole('${p.id}', this.value)" ${p.id === state.profile.id ? 'disabled title="No se permite cambiar el propio rol desde la aplicación."' : ''}><option value="auditor" ${p.role === 'auditor' ? 'selected' : ''}>Auditor</option><option value="admin" ${p.role === 'admin' ? 'selected' : ''}>Admin</option></select></td>
        <td>${fmtDateTime(p.created_at)}</td>
      </tr>`).join('');
    } catch (e) { console.error(e); }
    finally { loading(false); }
  }

  async function changeRole(id, role) {
    if (!['auditor','admin'].includes(role)) return;
    if (id === state.profile.id) return loadUsersAdmin();
    const { error } = await client.from('profiles').update({ role }).eq('id', id);
    if (error) { toast(error.message, 'danger'); return loadUsersAdmin(); }
    toast('Rol actualizado.', 'success');
    if (id === state.profile.id) {
      state.profile.role = role;
      $$('.admin-only').forEach(n => n.classList.toggle('d-none', role !== 'admin'));
      el('sidebarUserRole').textContent = roleLabel(role);
      el('topbarRoleBadge').textContent = roleLabel(role);
      if (role !== 'admin') setView('dashboard');
    }
  }

  // Public methods for inline actions
  window.CleanItApp = {
    openAudit,
    continueDraft,
    downloadPdf,
    goHistory: () => setView('history'),
    editSection,
    addItem: (sectionId) => openItemModal(sectionId),
    editItem,
    deleteItem,
    deleteSection,
    changeRole
  };

  document.addEventListener('DOMContentLoaded', init);
})();
