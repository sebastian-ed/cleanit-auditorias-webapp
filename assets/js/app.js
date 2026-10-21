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
    editingCompleted: false,
    deleteAuditId: null,
    deleteAuditIds: [],
    historySelected: new Set(),
    history: [],
    activityLog: [],
    dashboardAudits: [],
    analysisAudits: [],
    analysisResponses: [],
    analysisLoaded: false,
    staffMembers: [],
    charts: { classification: null, sections: null, analysisTrend: null, analysisStaff: null },
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

  const pct = (v) => (v === null || v === undefined || v === '') ? '—' : (Number.isFinite(Number(v)) ? `${Number(v).toFixed(1)}%` : '—');

  const roleLabel = role => role === 'admin' ? 'Administrador' : 'Auditor';
  const statusLabel = status => status === 'completed' ? 'Finalizada' : 'Borrador';
  const auditCoverage = (audit, responses = null) => {
    const storedTotal = Number(audit?.total_items);
    const useResponses = Array.isArray(responses) && (audit?.status !== 'completed' || !Number.isFinite(storedTotal) || storedTotal <= 0);
    const total = useResponses ? responses.length : (Number.isFinite(storedTotal) ? storedTotal : 0);
    const storedAnswered = Number(audit?.answered_items);
    const answered = useResponses
      ? responses.filter(r => r.answer).length
      : (Number.isFinite(storedAnswered) ? storedAnswered : 0);
    const unansweredStored = Number(audit?.unanswered_items);
    const unanswered = useResponses
      ? Math.max(total - answered, 0)
      : (Number.isFinite(unansweredStored) ? unansweredStored : Math.max(total - answered, 0));
    const complete = audit?.is_complete === true || (total > 0 && unanswered === 0);
    return { total, answered, unanswered, complete };
  };
  const coverageBadge = (audit, responses = null) => {
    const c = auditCoverage(audit, responses);
    if (audit?.status !== 'completed') return `<span class="badge badge-soft-neutral">En curso</span>`;
    return c.complete
      ? `<span class="badge badge-soft-success">Checklist completo · ${c.answered}/${c.total}</span>`
      : `<span class="badge badge-soft-warning">Incompleta · ${c.unanswered} pendiente${c.unanswered === 1 ? '' : 's'}</span>`;
  };
  const auditTypeLabel = type => type === 'local' ? 'Estado del local' : type === 'personnel' ? 'Presentación del personal' : type === 'vehicle' ? 'Vehículo' : 'Histórica';
  const auditTypeBadgeClass = type => type === 'vehicle' ? 'badge-soft-warning' : type === 'personnel' ? 'badge-soft-info' : type === 'local' ? 'badge-soft-success' : 'badge-soft-neutral';
  const auditIdentity = audit => audit.audit_type === 'vehicle'
    ? (audit.vehicle_plate || 'Sin patente')
    : audit.audit_type === 'personnel'
      ? (audit.staff_member_name_snapshot || 'Operario sin identificar')
      : audit.audit_type === 'local' ? 'Estado general del local' : (audit.vehicle_plate || 'Auditoría histórica');
  const auditPeopleSummary = audit => audit.audit_type === 'vehicle'
    ? [audit.vehicle_received_by ? `Recibió: ${audit.vehicle_received_by}` : '', audit.vehicle_workers_text ? `Equipo: ${audit.vehicle_workers_text}` : '', audit.vehicle_final_control_by ? `Control: ${audit.vehicle_final_control_by}` : ''].filter(Boolean).join(' · ') || '—'
    : audit.audit_type === 'personnel'
      ? (audit.staff_member_name_snapshot ? `Operario: ${audit.staff_member_name_snapshot}` : '—')
      : [audit.responsible_name ? `Responsable: ${audit.responsible_name}` : '', audit.operators_text ? `Presentes: ${audit.operators_text}` : ''].filter(Boolean).join(' · ') || '—';

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
    if ((name === 'checklistAdmin' || name === 'staffAdmin' || name === 'usersAdmin') && state.profile?.role !== 'admin') name = 'dashboard';
    state.currentView = name;
    $$('.app-view').forEach(v => v.classList.add('d-none'));
    el(`view-${name}`)?.classList.remove('d-none');
    $$('#mainNav .nav-link').forEach(b => b.classList.toggle('active', b.dataset.view === name));
    el('sidebar').classList.remove('open');

    const titles = {
      dashboard: ['Panel', 'Resumen de desempeño de auditorías.'],
      analysis: ['Análisis', 'Patrones, recurrencias y desempeño operativo.'],
      newAudit: ['Nueva auditoría', 'Registro digital y guardado automático.'],
      history: ['Historial', 'Trazabilidad y consulta de resultados.'],
      checklistAdmin: ['Checklist', 'Administración de secciones e ítems.'],
      staffAdmin: ['Operarios', 'Maestro de operarios para presencia y auditorías individuales.'],
      usersAdmin: ['Usuarios', 'Roles de acceso.'],
      auditDetail: ['Detalle de auditoría', 'Resultado, evidencia y descarga.']
    };
    const [title, sub] = titles[name] || ['', ''];
    el('pageTitle').textContent = title;
    el('pageSubtitle').textContent = sub;

    if (!load) return;
    if (name === 'dashboard') loadDashboard();
    if (name === 'analysis') loadAnalysis();
    if (name === 'history') loadHistory();
    if (name === 'checklistAdmin') loadChecklistAdmin();
    if (name === 'staffAdmin') loadStaffAdmin();
    if (name === 'usersAdmin') loadUsersAdmin();
    if (name === 'newAudit' && !state.activeAudit) prepareNewAuditStart();
  }

  async function init() {
    el('auditDate').value = todayISO();
    bindGlobalEvents();
    state.modals.section = new bootstrap.Modal(el('sectionModal'));
    state.modals.item = new bootstrap.Modal(el('itemModal'));
    state.modals.deleteAudit = new bootstrap.Modal(el('deleteAuditModal'));

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
    $$('input[name="auditType"]').forEach(r => r.addEventListener('change', toggleAuditStartFields));
    el('finalizeAuditBtn').addEventListener('click', async () => {
      if (state.editingCompleted) await saveCompletedAuditEdit();
      else await finalizeAudit();
    });
    el('exitDraftBtn').addEventListener('click', async () => {
      if (state.editingCompleted) {
        state.activeAudit = null;
        state.activeResponses = [];
        state.editingCompleted = false;
        setView('history');
        return;
      }
      await saveDraftMetadata();
      await saveGeneralNotes();
      state.activeAudit = null;
      state.activeResponses = [];
      setView('history');
    });
    el('executionGeneralNotes').addEventListener('change', saveGeneralNotes);
    ['editAuditDate','editResponsibleName','editStaffMember','editVehiclePlate','editVehicleReceivedBy','editVehicleWorkersText','editVehicleFinalControlBy'].forEach(id => {
      el(id)?.addEventListener('change', saveDraftMetadata);
    });

    el('deleteAuditConfirmInput').addEventListener('input', () => {
      const valid = el('deleteAuditConfirmInput').value.trim() === 'ELIMINAR';
      el('confirmDeleteAuditBtn').disabled = !valid;
    });
    el('confirmDeleteAuditBtn').addEventListener('click', confirmDeleteAudit);
    el('deleteAuditModal').addEventListener('hidden.bs.modal', () => {
      state.deleteAuditId = null;
      state.deleteAuditIds = [];
      el('deleteAuditConfirmInput').value = '';
      el('confirmDeleteAuditBtn').disabled = true;
    });

    ['historyFrom', 'historyTo', 'historyType', 'historyStatus', 'historySearch'].forEach(id => {
      el(id).addEventListener(id === 'historySearch' ? 'input' : 'change', () => {
        state.historySelected.clear();
        renderHistory();
      });
    });
    el('historySelectAllCheckbox').addEventListener('change', (ev) => selectAllVisibleHistory(ev.target.checked));
    el('selectAllHistoryBtn').addEventListener('click', () => selectAllVisibleHistory(true));
    el('clearHistorySelectionBtn').addEventListener('click', clearHistorySelection);
    el('deleteSelectedAuditsBtn').addEventListener('click', () => openDeleteAuditsModal([...state.historySelected]));
    el('downloadSelectedAuditsBtn').addEventListener('click', () => downloadAuditsPdf([...state.historySelected], 'selected'));
    el('downloadAllAuditsBtn').addEventListener('click', () => downloadAuditsPdf(state.history.map(a => a.id), 'all'));

    el('analysisPeriod').addEventListener('change', () => {
      toggleAnalysisCustomDates();
      renderAnalysis();
    });
    el('analysisFrom').addEventListener('change', renderAnalysis);
    el('analysisTo').addEventListener('change', renderAnalysis);
    el('analysisRefreshBtn').addEventListener('click', () => loadAnalysis(true));
    el('analysisPdfBtn').addEventListener('click', downloadAnalysisPdf);
    el('analysisXlsxBtn').addEventListener('click', downloadAnalysisXlsx);
    el('analysisDocxBtn').addEventListener('click', downloadAnalysisDocx);
    el('analysisStaffDetail').addEventListener('change', () => renderAnalysisStaffDetail(el('analysisStaffDetail').value));

    el('dashboardTypeFilter').addEventListener('change', () => {
      if (el('dashboardTypeFilter').value !== 'personnel') el('dashboardStaffFilter').value = '';
      renderDashboard();
    });
    el('dashboardStaffFilter').addEventListener('change', renderDashboard);

    el('addSectionBtn').addEventListener('click', () => openSectionModal());
    el('sectionForm').addEventListener('submit', saveSection);
    el('itemForm').addEventListener('submit', saveItem);
    el('staffAddForm').addEventListener('submit', addStaffMember);
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
    state.editingCompleted = false;
    showLogin();
  }

  // ============================================================
  // CHECKLIST DATA
  // ============================================================
  async function fetchChecklist(activeOnly = true, auditType = null) {
    let sectionQuery = client.from('audit_sections').select('*').order('sort_order');
    if (activeOnly) sectionQuery = sectionQuery.eq('is_active', true);
    if (auditType && ['local','personnel','vehicle'].includes(auditType)) sectionQuery = sectionQuery.eq('audit_type', auditType);
    const { data: sections, error: sectionError } = await sectionQuery;
    if (sectionError) throw sectionError;

    let itemQuery = client.from('audit_items').select('*').order('sort_order');
    if (activeOnly) itemQuery = itemQuery.eq('is_active', true);
    const { data: items, error: itemError } = await itemQuery;
    if (itemError) throw itemError;

    return sections.map(section => ({ ...section, items: items.filter(item => item.section_id === section.id) }));
  }

  async function loadStaffMembers(includeInactive = false) {
    let query = client.from('staff_members').select('*').order('full_name');
    if (!includeInactive) query = query.eq('is_active', true);
    const { data, error } = await query;
    if (error) {
      const hint = String(error.message || '').includes('staff_members') ? ' Ejecutá supabase/migration_v5_three_audit_types_staff.sql en Supabase.' : '';
      throw new Error(`${error.message || 'No se pudo cargar el maestro de operarios.'}${hint}`);
    }
    state.staffMembers = data || [];
    return state.staffMembers;
  }

  function renderStaffChecks(containerId, selectedIds = [], className = '') {
    const node = el(containerId);
    if (!node) return;
    const selected = new Set((selectedIds || []).map(String));
    if (!state.staffMembers.length) {
      node.innerHTML = '<div class="staff-empty">No hay operarios activos cargados. Un administrador debe agregarlos desde <strong>Operarios</strong>.</div>';
      return;
    }
    node.innerHTML = state.staffMembers.map(staff => `<label class="staff-check"><input class="form-check-input ${className}" type="checkbox" value="${staff.id}" ${selected.has(String(staff.id)) ? 'checked' : ''}><span>${esc(staff.full_name)}${staff.is_active ? '' : ' <small class="text-secondary">(inactivo)</small>'}</span></label>`).join('');
  }

  function renderStaffSelect(selectId, selectedId = '') {
    const node = el(selectId);
    if (!node) return;
    const current = selectedId || node.value || '';
    node.innerHTML = '<option value="">Seleccionar operario…</option>' + state.staffMembers.map(staff => `<option value="${staff.id}" ${String(staff.id) === String(current) ? 'selected' : ''}>${esc(staff.full_name)}</option>`).join('');
  }

  function selectedStaffFrom(selector) {
    const ids = $$(selector).filter(x => x.checked).map(x => x.value);
    const members = ids.map(id => state.staffMembers.find(s => String(s.id) === String(id))).filter(Boolean);
    return { ids, names: members.map(x => x.full_name) };
  }

  async function prepareNewAuditStart() {
    try {
      await loadStaffMembers(false);
      resetNewAuditView();
    } catch (e) {
      console.error(e);
      toast(e.message || 'No se pudieron cargar los operarios.', 'danger');
      resetNewAuditView();
    }
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
      state.dashboardAudits = audits || [];
      await renderDashboard();
    } catch (e) { console.error(e); }
    finally { loading(false); }
  }

  async function renderDashboard() {
    const type = el('dashboardTypeFilter')?.value || '';
    const staffFilter = el('dashboardStaffFilter')?.value || '';
    const staffWrap = el('dashboardStaffFilterWrap');
    staffWrap?.classList.toggle('d-none', type !== 'personnel');
    const personnelNames = [...new Set(state.dashboardAudits.filter(a => a.audit_type === 'personnel' && a.staff_member_name_snapshot).map(a => a.staff_member_name_snapshot))].sort((a,b) => a.localeCompare(b, 'es'));
    const staffSelect = el('dashboardStaffFilter');
    if (staffSelect) {
      const keep = staffSelect.value;
      staffSelect.innerHTML = '<option value="">Todos</option>' + personnelNames.map(name => `<option value="${esc(name)}">${esc(name)}</option>`).join('');
      if (personnelNames.includes(keep)) staffSelect.value = keep;
    }
    const audits = state.dashboardAudits.filter(a => (!type || a.audit_type === type) && (!staffFilter || a.staff_member_name_snapshot === staffFilter));
    const total = audits.length;
    const scored = audits.filter(x => x.score !== null && x.score !== undefined && x.score !== '');
    const avg = scored.length ? scored.reduce((sum, x) => sum + Number(x.score), 0) / scored.length : null;
    const non = audits.filter(x => x.classification === 'No conforme').length;
    const critical = audits.reduce((sum, x) => sum + Number(x.critical_failures || 0), 0);
    const incomplete = audits.filter(x => !auditCoverage(x).complete).length;
    el('kpiTotal').textContent = total;
    el('kpiAverage').textContent = avg === null ? '—' : pct(avg);
    el('kpiNonConform').textContent = non;
    el('kpiCritical').textContent = critical;
    el('kpiIncomplete').textContent = incomplete;
    const base = state.profile.role === 'admin' ? 'Resultados consolidados de todos los auditores.' : 'Resultados de tus auditorías.';
    el('dashboardScope').textContent = `${base} ${type ? `Filtro: ${auditTypeLabel(type)}${staffFilter ? ` · ${staffFilter}` : ''}.` : 'Podés filtrar por tipo de auditoría.'}`;

    renderRecentAudits(audits.slice(0, 7));
    renderClassificationChart(audits);
    await renderSectionsChart(audits);
  }

  function renderRecentAudits(audits) {
    const body = el('recentAuditsBody');
    if (!audits.length) {
      body.innerHTML = `<tr><td colspan="8"><div class="empty-state">Todavía no hay auditorías finalizadas para este filtro.</div></td></tr>`;
      return;
    }
    body.innerHTML = audits.map(a => `<tr>
      <td>${fmtDate(a.audit_date)}</td>
      <td><span class="badge ${auditTypeBadgeClass(a.audit_type)}">${esc(auditTypeLabel(a.audit_type))}</span></td>
      <td class="fw-semibold">${esc(auditIdentity(a))}</td>
      <td>${esc(a.auditor?.full_name || a.auditor?.email || '—')}</td>
      <td><strong>${pct(a.score)}</strong></td>
      <td><span class="badge ${classificationClass(a.classification)}">${esc(a.classification || 'Sin evaluación')}</span></td>
      <td>${coverageBadge(a)}</td>
      <td class="text-end"><button class="btn btn-sm btn-outline-secondary" onclick="CleanItApp.openAudit('${a.id}')">Ver</button></td>
    </tr>`).join('');
  }

  function renderClassificationChart(audits) {
    const counts = {
      'Conforme': audits.filter(a => a.classification === 'Conforme').length,
      'Conforme con observaciones': audits.filter(a => a.classification === 'Conforme con observaciones').length,
      'No conforme': audits.filter(a => a.classification === 'No conforme').length,
      'Sin evaluación': audits.filter(a => !a.classification || a.classification === 'Sin evaluación').length
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
  // ANALYSIS
  // ============================================================
  function analysisDateRange() {
    const mode = el('analysisPeriod')?.value || '90';
    const now = new Date();
    const toIso = d => {
      const x = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
      return x.toISOString().slice(0, 10);
    };
    if (mode === 'all') return { from: '', to: '', label: 'Todo el historial' };
    if (mode === 'custom') return { from: el('analysisFrom')?.value || '', to: el('analysisTo')?.value || '', label: 'Período personalizado' };
    if (mode === 'month') {
      const from = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from: toIso(from), to: toIso(now), label: 'Mes actual' };
    }
    const days = Number(mode) || 90;
    const from = new Date(now);
    from.setDate(from.getDate() - (days - 1));
    return { from: toIso(from), to: toIso(now), label: `Últimos ${days} días` };
  }

  function toggleAnalysisCustomDates() {
    const custom = el('analysisPeriod')?.value === 'custom';
    el('analysisCustomFromWrap')?.classList.toggle('d-none', !custom);
    el('analysisCustomToWrap')?.classList.toggle('d-none', !custom);
  }

  async function fetchAnalysisAudits() {
    const pageSize = 500;
    let from = 0;
    const rows = [];
    while (true) {
      const { data, error } = await client
        .from('audits')
        .select('*, auditor:profiles(full_name,email)')
        .eq('status', 'completed')
        .order('audit_date', { ascending: false })
        .range(from, from + pageSize - 1);
      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < pageSize) break;
      from += pageSize;
      if (rows.length >= 10000) break;
    }
    return rows;
  }

  async function fetchAnalysisResponses(auditIds) {
    if (!auditIds.length) return [];
    const result = [];
    const batchSize = 40;
    const pageSize = 1000;
    for (let i = 0; i < auditIds.length; i += batchSize) {
      const ids = auditIds.slice(i, i + batchSize);
      let from = 0;
      while (true) {
        const { data, error } = await client
          .from('audit_responses')
          .select('audit_id,section_order_snapshot,section_title_snapshot,item_code_snapshot,item_title_snapshot,is_critical_snapshot,answer,observation')
          .in('audit_id', ids)
          .range(from, from + pageSize - 1);
        if (error) throw error;
        result.push(...(data || []));
        if (!data || data.length < pageSize) break;
        from += pageSize;
      }
    }
    return result;
  }

  async function loadAnalysis(force = false) {
    toggleAnalysisCustomDates();
    if (state.analysisLoaded && !force) {
      renderAnalysis();
      return;
    }
    loading(true);
    try {
      const audits = await fetchAnalysisAudits();
      const responses = await fetchAnalysisResponses(audits.map(a => a.id));
      state.analysisAudits = audits;
      state.analysisResponses = responses;
      state.analysisLoaded = true;
      renderAnalysis();
    } catch (e) {
      console.error(e);
      toast(e?.message || 'No se pudieron cargar los datos de análisis.', 'danger');
    } finally { loading(false); }
  }

  function getAnalysisDataset() {
    const range = analysisDateRange();
    const audits = state.analysisAudits.filter(a => {
      const date = String(a.audit_date || '').slice(0, 10);
      if (range.from && date < range.from) return false;
      if (range.to && date > range.to) return false;
      return true;
    });
    const byId = new Map(audits.map(a => [a.id, a]));
    const responses = state.analysisResponses.filter(r => byId.has(r.audit_id));
    return { range, audits, responses, byId };
  }

  function evaluatedAnswer(answer) { return answer === 'complies' || answer === 'non_complies'; }
  function rateText(n, d) { return d ? `${(n / d * 100).toFixed(1)}%` : '—'; }
  function normalizeCode(v='') { return String(v || '').trim().toLowerCase(); }
  function responseMetricKey(audit, r) {
    const stable = normalizeCode(r.item_code_snapshot) || String(r.item_title_snapshot || '').trim().toLowerCase();
    return `${audit.audit_type}|${r.section_order_snapshot || ''}|${stable}`;
  }

  function buildFailureMetrics(audits, responses) {
    const byId = new Map(audits.map(a => [a.id, a]));
    const map = new Map();
    // Audits arrive newest first, so the first label kept is the most recent snapshot.
    responses.forEach(r => {
      const audit = byId.get(r.audit_id);
      if (!audit || !evaluatedAnswer(r.answer)) return;
      const key = responseMetricKey(audit, r);
      const acc = map.get(key) || {
        key, auditType: audit.audit_type, sectionOrder: Number(r.section_order_snapshot || 0),
        section: r.section_title_snapshot || 'Sin sección', code: r.item_code_snapshot || '',
        title: r.item_title_snapshot || 'Ítem', critical: !!r.is_critical_snapshot,
        evaluated: 0, failures: 0, complies: 0, criticalFailures: 0, lastFailure: '', lastAuditId: ''
      };
      acc.evaluated += 1;
      if (r.answer === 'non_complies') {
        acc.failures += 1;
        if (r.is_critical_snapshot) acc.criticalFailures += 1;
        const date = String(audit.audit_date || '').slice(0, 10);
        if (!acc.lastFailure || date > acc.lastFailure) { acc.lastFailure = date; acc.lastAuditId = audit.id; }
      } else acc.complies += 1;
      map.set(key, acc);
    });
    return [...map.values()].map(x => ({ ...x, failureRate: x.evaluated ? x.failures / x.evaluated * 100 : 0 }))
      .sort((a,b) => b.criticalFailures - a.criticalFailures || b.failures - a.failures || b.failureRate - a.failureRate || b.evaluated - a.evaluated);
  }

  function buildStaffMetrics(audits, responses) {
    const personnel = audits.filter(a => a.audit_type === 'personnel' && a.staff_member_name_snapshot);
    const personnelIds = new Set(personnel.map(a => a.id));
    const auditById = new Map(personnel.map(a => [a.id, a]));
    const byStaff = new Map();
    personnel.forEach(a => {
      const name = a.staff_member_name_snapshot || 'Sin identificar';
      const key = a.staff_member_id || name.toLowerCase();
      const acc = byStaff.get(key) || { key: String(key), name, auditIds: new Set(), evaluated: 0, complies: 0, failures: 0, critical: 0, itemMap: new Map(), observations: [] };
      acc.auditIds.add(a.id);
      byStaff.set(key, acc);
    });
    responses.forEach(r => {
      if (!personnelIds.has(r.audit_id) || !evaluatedAnswer(r.answer)) return;
      const audit = auditById.get(r.audit_id);
      if (!audit) return;
      const key = audit.staff_member_id || String(audit.staff_member_name_snapshot || '').toLowerCase();
      const acc = byStaff.get(key);
      if (!acc) return;
      acc.evaluated += 1;
      if (r.answer === 'complies') acc.complies += 1;
      if (r.answer === 'non_complies') {
        acc.failures += 1;
        if (r.is_critical_snapshot) acc.critical += 1;
        const ikey = normalizeCode(r.item_code_snapshot) || String(r.item_title_snapshot || '').trim().toLowerCase();
        const item = acc.itemMap.get(ikey) || { code: r.item_code_snapshot || '', title: r.item_title_snapshot || 'Ítem', evaluated: 0, failures: 0, critical: !!r.is_critical_snapshot, lastFailure: '' };
        item.failures += 1;
        item.lastFailure = !item.lastFailure || audit.audit_date > item.lastFailure ? audit.audit_date : item.lastFailure;
        acc.itemMap.set(ikey, item);
        if (r.observation) acc.observations.push({ date: audit.audit_date, title: r.item_title_snapshot, observation: r.observation });
      }
    });
    // Add evaluated denominators per item for each staff.
    responses.forEach(r => {
      if (!personnelIds.has(r.audit_id) || !evaluatedAnswer(r.answer)) return;
      const audit = auditById.get(r.audit_id);
      if (!audit) return;
      const key = audit.staff_member_id || String(audit.staff_member_name_snapshot || '').toLowerCase();
      const acc = byStaff.get(key);
      if (!acc) return;
      const ikey = normalizeCode(r.item_code_snapshot) || String(r.item_title_snapshot || '').trim().toLowerCase();
      const item = acc.itemMap.get(ikey);
      if (item) item.evaluated += 1;
    });
    return [...byStaff.values()].map(s => {
      const items = [...s.itemMap.values()].map(i => ({ ...i, failureRate: i.evaluated ? i.failures / i.evaluated * 100 : 0 }))
        .sort((a,b) => b.failures - a.failures || b.failureRate - a.failureRate);
      return {
        ...s, audits: s.auditIds.size, compliance: s.evaluated ? s.complies / s.evaluated * 100 : null,
        failureRate: s.evaluated ? s.failures / s.evaluated * 100 : null,
        items, topFailure: items[0] || null,
        observations: s.observations.sort((a,b) => String(b.date).localeCompare(String(a.date)))
      };
    }).sort((a,b) => {
      if (a.compliance === null) return 1;
      if (b.compliance === null) return -1;
      return a.compliance - b.compliance || b.failures - a.failures || b.audits - a.audits;
    });
  }

  function analysisPriorityBadge(metric) {
    if (metric.criticalFailures > 0 || (metric.failures >= 2 && metric.failureRate >= 30)) return '<span class="badge badge-soft-danger">Alta</span>';
    if (metric.failures >= 2 || metric.failureRate >= 15) return '<span class="badge badge-soft-warning">Media</span>';
    return '<span class="badge badge-soft-neutral">Baja</span>';
  }

  function renderAnalysis() {
    if (!state.analysisLoaded) return;
    const { range, audits, responses, byId } = getAnalysisDataset();
    const evaluated = responses.filter(r => evaluatedAnswer(r.answer));
    const complies = evaluated.filter(r => r.answer === 'complies').length;
    const failures = evaluated.filter(r => r.answer === 'non_complies').length;
    const critical = evaluated.filter(r => r.answer === 'non_complies' && r.is_critical_snapshot).length;
    const metrics = buildFailureMetrics(audits, responses);
    const recurring = metrics.filter(m => m.failures >= 2).length;
    const incomplete = audits.filter(a => !auditCoverage(a).complete).length;
    const staff = buildStaffMetrics(audits, responses);

    el('analysisKpiAudits').textContent = audits.length;
    el('analysisKpiCompliance').textContent = evaluated.length ? rateText(complies, evaluated.length) : '—';
    el('analysisKpiFailures').textContent = failures;
    el('analysisKpiCritical').textContent = critical;
    el('analysisKpiRecurring').textContent = recurring;
    el('analysisKpiIncomplete').textContent = incomplete;
    el('analysisScopeText').textContent = `${range.label} · ${audits.length} auditoría${audits.length === 1 ? '' : 's'} finalizada${audits.length === 1 ? '' : 's'} · ${evaluated.length} ítems evaluados.`;

    renderAnalysisInsights(audits, responses, metrics, staff);
    renderAnalysisTrend(audits, responses);
    renderAnalysisStaff(staff);
    renderFailureTable('analysisLocalFailuresBody', metrics.filter(m => m.auditType === 'local'), 10, false);
    renderFailureTable('analysisVehicleFailuresBody', metrics.filter(m => m.auditType === 'vehicle'), 10, false);
    renderGeneralFailureTable(metrics.filter(m => m.failures > 0).slice(0, 15));
    renderAnalysisObservations(audits, responses, byId);
  }

  function buildAnalysisInsightsData(audits, responses, metrics, staff) {
    const insights = [];
    const evaluated = responses.filter(r => evaluatedAnswer(r.answer));
    const failures = evaluated.filter(r => r.answer === 'non_complies');
    const compliance = evaluated.length ? (evaluated.length - failures.length) / evaluated.length * 100 : null;
    const incomplete = audits.filter(a => !auditCoverage(a).complete).length;
    const topMetric = metrics.find(m => m.failures > 0);
    const recurrentCritical = metrics.find(m => m.criticalFailures >= 2);
    const staffWithSample = staff.filter(s => s.evaluated >= 4 && s.audits >= 2 && s.compliance !== null);
    const worst = staffWithSample[0];
    const best = [...staffWithSample].sort((a,b) => b.compliance - a.compliance || b.audits - a.audits)[0];

    if (!audits.length) {
      insights.push({ level:'neutral', title:'Sin muestra para el período', text:'No hay auditorías finalizadas dentro del rango seleccionado. Ampliá el período para obtener conclusiones.' });
    } else {
      if (compliance !== null) {
        if (compliance >= 95) insights.push({ level:'success', title:'Cumplimiento general sólido', text:`El ${compliance.toFixed(1)}% de los ítems evaluados cumple el estándar (${evaluated.length} evaluaciones).` });
        else if (compliance < 90) insights.push({ level:'danger', title:'Cumplimiento general por debajo del objetivo', text:`El cumplimiento es ${compliance.toFixed(1)}%. Conviene priorizar los incumplimientos recurrentes antes de aumentar la muestra.` });
        else insights.push({ level:'warning', title:'Cumplimiento general con margen de mejora', text:`El cumplimiento es ${compliance.toFixed(1)}%. Está en una zona intermedia y las recurrencias muestran dónde intervenir primero.` });
      }
      if (worst) {
        const top = worst.topFailure;
        insights.push({ level: worst.compliance < 90 ? 'danger' : 'warning', title:`Operario con menor cumplimiento: ${worst.name}`, text:`Registra ${worst.compliance.toFixed(1)}% de cumplimiento en ${worst.audits} auditorías y ${worst.evaluated} evaluaciones.${top ? ` Su incumplimiento más frecuente es “${top.title}” (${top.failures}/${top.evaluated}, ${top.failureRate.toFixed(1)}%).` : ''}` });
      } else if (staff.length) {
        insights.push({ level:'neutral', title:'Muestra individual todavía limitada', text:'Hay auditorías de personal, pero todavía no alcanza una muestra mínima de 2 auditorías y 4 ítems evaluados por operario para ordenar desempeño con confianza.' });
      }
      if (best && (!worst || best.key !== worst.key)) insights.push({ level:'success', title:`Mejor desempeño individual: ${best.name}`, text:`Alcanza ${best.compliance.toFixed(1)}% de cumplimiento en ${best.audits} auditorías (${best.evaluated} evaluaciones). Puede usarse como referencia operativa si la muestra se sostiene.` });
      if (recurrentCritical) insights.push({ level:'danger', title:'Falla crítica recurrente', text:`“${recurrentCritical.title}” acumuló ${recurrentCritical.criticalFailures} incumplimientos críticos sobre ${recurrentCritical.evaluated} evaluaciones. Requiere acción correctiva y seguimiento específico.` });
      else if (topMetric && topMetric.failures >= 2) insights.push({ level:'warning', title:'Principal recurrencia detectada', text:`“${topMetric.title}” falló ${topMetric.failures} veces sobre ${topMetric.evaluated} evaluaciones (${topMetric.failureRate.toFixed(1)}%).` });
      if (audits.length && incomplete / audits.length >= .15) insights.push({ level:'warning', title:'Calidad de registro a mejorar', text:`${incomplete} de ${audits.length} auditorías (${(incomplete / audits.length * 100).toFixed(1)}%) se finalizaron con preguntas pendientes. Esto reduce la comparabilidad del análisis.` });
      else if (audits.length && incomplete === 0) insights.push({ level:'success', title:'Buena calidad de captura', text:'Todas las auditorías finalizadas del período tienen el checklist completo.' });
      const trend = calculateRecentTrend(audits, responses);
      if (trend && Math.abs(trend.delta) >= 5) insights.push({ level: trend.delta > 0 ? 'success' : 'danger', title: trend.delta > 0 ? 'Tendencia reciente favorable' : 'Deterioro reciente del cumplimiento', text:`Los últimos 30 días muestran ${trend.current.toFixed(1)}% frente a ${trend.previous.toFixed(1)}% en los 30 días anteriores (${trend.delta > 0 ? '+' : ''}${trend.delta.toFixed(1)} puntos).` });
    }
    return insights;
  }

  function renderAnalysisInsights(audits, responses, metrics, staff) {
    const insights = buildAnalysisInsightsData(audits, responses, metrics, staff);
    const levelClass = { success:'analysis-insight-success', warning:'analysis-insight-warning', danger:'analysis-insight-danger', neutral:'analysis-insight-neutral' };
    el('analysisInsights').innerHTML = insights.map(i => `<div class="analysis-insight ${levelClass[i.level] || levelClass.neutral}"><div class="analysis-insight-title">${esc(i.title)}</div><div class="analysis-insight-text">${esc(i.text)}</div></div>`).join('');
  }

  function calculateRecentTrend(audits, responses) {
    if (!audits.length) return null;
    const today = new Date();
    const startCurrent = new Date(today); startCurrent.setDate(startCurrent.getDate() - 29);
    const startPrevious = new Date(today); startPrevious.setDate(startPrevious.getDate() - 59);
    const endPrevious = new Date(today); endPrevious.setDate(endPrevious.getDate() - 30);
    const iso = d => new Date(d.getTime() - d.getTimezoneOffset()*60000).toISOString().slice(0,10);
    const currentIds = new Set(audits.filter(a => a.audit_date >= iso(startCurrent) && a.audit_date <= iso(today)).map(a => a.id));
    const previousIds = new Set(audits.filter(a => a.audit_date >= iso(startPrevious) && a.audit_date <= iso(endPrevious)).map(a => a.id));
    const calc = ids => {
      const rows = responses.filter(r => ids.has(r.audit_id) && evaluatedAnswer(r.answer));
      if (rows.length < 5) return null;
      return rows.filter(r => r.answer === 'complies').length / rows.length * 100;
    };
    const current = calc(currentIds), previous = calc(previousIds);
    if (current === null || previous === null) return null;
    return { current, previous, delta: current - previous };
  }

  function renderAnalysisTrend(audits, responses) {
    const auditById = new Map(audits.map(a => [a.id, a]));
    const map = new Map();
    responses.forEach(r => {
      if (!evaluatedAnswer(r.answer)) return;
      const a = auditById.get(r.audit_id); if (!a) return;
      const month = String(a.audit_date || '').slice(0,7);
      if (!month) return;
      const key = `${month}|${a.audit_type}`;
      const acc = map.get(key) || { month, type:a.audit_type, total:0, complies:0 };
      acc.total++; if (r.answer === 'complies') acc.complies++;
      map.set(key, acc);
    });
    const months = [...new Set([...map.values()].map(x => x.month))].sort();
    const types = ['local','personnel','vehicle'];
    const datasets = types.map(type => ({
      label: auditTypeLabel(type),
      data: months.map(month => {
        const x = map.get(`${month}|${type}`);
        return x?.total ? Number((x.complies / x.total * 100).toFixed(1)) : null;
      }),
      tension: .25,
      spanGaps: true
    })).filter(ds => ds.data.some(v => v !== null));
    state.charts.analysisTrend?.destroy();
    state.charts.analysisTrend = new Chart(el('analysisTrendChart'), {
      type:'line', data:{ labels:months.map(m => { const [y,mo]=m.split('-'); return `${mo}/${y}`; }), datasets },
      options:{ responsive:true, maintainAspectRatio:false, scales:{ y:{ min:0, max:100, ticks:{ callback:v=>`${v}%` } } }, plugins:{ legend:{ position:'bottom' } } }
    });
  }

  function renderAnalysisStaff(staff) {
    const select = el('analysisStaffDetail');
    const keep = select.value;
    select.innerHTML = '<option value="">Seleccionar…</option>' + staff.map(s => `<option value="${esc(s.key)}">${esc(s.name)}</option>`).join('');
    if (staff.some(s => String(s.key) === String(keep))) select.value = keep;

    const body = el('analysisStaffBody');
    body.innerHTML = staff.length ? staff.map((s,idx) => `<tr class="${idx === 0 && s.compliance !== null ? 'analysis-worst-row' : ''}">
      <td class="fw-semibold">${esc(s.name)}</td><td>${s.audits}</td><td>${s.evaluated}</td>
      <td><strong>${s.compliance === null ? '—' : `${s.compliance.toFixed(1)}%`}</strong></td><td>${s.failures}</td><td>${s.critical}</td>
      <td>${s.topFailure ? `${esc(s.topFailure.code ? `${s.topFailure.code} · ` : '')}${esc(s.topFailure.title)}` : '—'}</td>
      <td>${s.topFailure ? `${s.topFailure.failures}/${s.topFailure.evaluated} (${s.topFailure.failureRate.toFixed(1)}%)` : '—'}</td>
    </tr>`).join('') : '<tr><td colspan="8"><div class="empty-state">No hay auditorías individuales de personal en este período.</div></td></tr>';

    const chartRows = staff.filter(s => s.compliance !== null).slice(0, 12).reverse();
    state.charts.analysisStaff?.destroy();
    state.charts.analysisStaff = new Chart(el('analysisStaffChart'), {
      type:'bar', data:{ labels:chartRows.map(s => s.name), datasets:[{ label:'Cumplimiento %', data:chartRows.map(s => Number(s.compliance.toFixed(1))) }] },
      options:{ responsive:true, maintainAspectRatio:false, indexAxis:'y', scales:{ x:{ min:0, max:100, ticks:{ callback:v=>`${v}%` } } }, plugins:{ legend:{ display:false } } }
    });
    renderAnalysisStaffDetail(select.value, staff);
  }

  function renderAnalysisStaffDetail(key, suppliedStaff = null) {
    const panel = el('analysisStaffDetailPanel');
    if (!key) { panel.classList.add('d-none'); panel.innerHTML=''; return; }
    const dataset = getAnalysisDataset();
    const staff = suppliedStaff || buildStaffMetrics(dataset.audits, dataset.responses);
    const s = staff.find(x => String(x.key) === String(key));
    if (!s) { panel.classList.add('d-none'); return; }
    panel.classList.remove('d-none');
    panel.innerHTML = `<div class="p-3 p-lg-4">
      <div class="d-flex flex-wrap justify-content-between gap-2 align-items-start mb-3"><div><h4 class="h6 mb-1">Detalle · ${esc(s.name)}</h4><div class="small text-secondary">${s.audits} auditorías · ${s.evaluated} evaluaciones · ${s.failures} incumplimientos</div></div><span class="badge ${s.compliance !== null && s.compliance >= 95 ? 'badge-soft-success' : s.compliance !== null && s.compliance >= 90 ? 'badge-soft-warning' : 'badge-soft-danger'}">${s.compliance === null ? 'Sin evaluación' : `${s.compliance.toFixed(1)}% cumplimiento`}</span></div>
      <div class="row g-3">
        <div class="col-xl-7"><div class="table-responsive"><table class="table table-sm align-middle mb-0"><thead><tr><th>Incumplimiento</th><th>Fallas</th><th>Evaluado</th><th>Frecuencia</th><th>Última</th></tr></thead><tbody>${s.items.length ? s.items.map(i=>`<tr><td>${esc(i.code ? `${i.code} · ` : '')}${esc(i.title)}${i.critical ? ' <span class="critical-pill">Crítico</span>' : ''}</td><td>${i.failures}</td><td>${i.evaluated}</td><td><strong>${i.failureRate.toFixed(1)}%</strong></td><td>${fmtDate(i.lastFailure)}</td></tr>`).join('') : '<tr><td colspan="5" class="text-secondary">Sin incumplimientos registrados.</td></tr>'}</tbody></table></div></div>
        <div class="col-xl-5"><div class="small text-uppercase fw-bold text-secondary mb-2">Observaciones recientes</div>${s.observations.length ? s.observations.slice(0,6).map(o=>`<div class="analysis-note"><div class="small fw-semibold">${fmtDate(o.date)} · ${esc(o.title)}</div><div class="small text-secondary mt-1">${esc(o.observation)}</div></div>`).join('') : '<div class="text-secondary small">No hay observaciones escritas asociadas a incumplimientos.</div>'}</div>
      </div>
    </div>`;
  }

  function renderFailureTable(bodyId, metrics, limit = 10, showType = false) {
    const rows = metrics.filter(m => m.failures > 0).slice(0, limit);
    el(bodyId).innerHTML = rows.length ? rows.map(m => `<tr>
      ${showType ? `<td><span class="badge ${auditTypeBadgeClass(m.auditType)}">${esc(auditTypeLabel(m.auditType))}</span></td>` : ''}
      <td><div class="fw-semibold">${esc(m.code ? `${m.code} · ` : '')}${esc(m.title)}</div><div class="small text-secondary">${esc(m.section.replace(/^\d+\.\s*/, ''))}</div></td>
      <td><strong>${m.failures}</strong></td><td>${m.evaluated}</td><td><strong>${m.failureRate.toFixed(1)}%</strong></td><td>${fmtDate(m.lastFailure)}</td>
    </tr>`).join('') : `<tr><td colspan="${showType ? 6 : 5}"><div class="empty-state">No hay incumplimientos registrados en este período.</div></td></tr>`;
  }

  function renderGeneralFailureTable(metrics) {
    const body = el('analysisGeneralFailuresBody');
    body.innerHTML = metrics.length ? metrics.map(m => `<tr>
      <td><span class="badge ${auditTypeBadgeClass(m.auditType)}">${esc(auditTypeLabel(m.auditType))}</span></td>
      <td><div class="fw-semibold">${esc(m.code ? `${m.code} · ` : '')}${esc(m.title)}</div><div class="small text-secondary">${esc(m.section.replace(/^\d+\.\s*/, ''))}</div></td>
      <td><strong>${m.failures}</strong></td><td>${m.evaluated}</td><td><strong>${m.failureRate.toFixed(1)}%</strong></td><td>${analysisPriorityBadge(m)}</td>
    </tr>`).join('') : '<tr><td colspan="6"><div class="empty-state">No hay incumplimientos registrados en este período.</div></td></tr>';
  }

  function renderAnalysisObservations(audits, responses, byId) {
    const rows = responses.filter(r => r.answer === 'non_complies' && r.observation).map(r => {
      const a = byId.get(r.audit_id);
      return a ? { audit:a, response:r } : null;
    }).filter(Boolean).sort((a,b) => String(b.audit.audit_date).localeCompare(String(a.audit.audit_date))).slice(0,12);
    el('analysisObservations').innerHTML = rows.length ? rows.map(x => `<div class="analysis-observation-entry">
      <div class="d-flex flex-wrap justify-content-between gap-2"><div class="fw-semibold small">${esc(x.response.item_title_snapshot)}</div><span class="badge ${auditTypeBadgeClass(x.audit.audit_type)}">${esc(auditTypeLabel(x.audit.audit_type))}</span></div>
      <div class="small text-secondary mt-1">${fmtDate(x.audit.audit_date)} · ${esc(auditIdentity(x.audit))}</div>
      <div class="small mt-2">${esc(x.response.observation)}</div>
    </div>`).join('') : '<div class="empty-state">No hay observaciones escritas asociadas a incumplimientos en este período.</div>';
  }


  // ============================================================
  // ANALYSIS EXPORTS
  // ============================================================
  function buildAnalysisTrendRows(audits, responses) {
    const auditById = new Map(audits.map(a => [a.id, a]));
    const map = new Map();
    responses.forEach(r => {
      if (!evaluatedAnswer(r.answer)) return;
      const audit = auditById.get(r.audit_id);
      if (!audit) return;
      const month = String(audit.audit_date || '').slice(0, 7);
      if (!month) return;
      const key = `${month}|${audit.audit_type}`;
      const acc = map.get(key) || { total: 0, complies: 0 };
      acc.total += 1;
      if (r.answer === 'complies') acc.complies += 1;
      map.set(key, acc);
    });
    const months = [...new Set([...map.keys()].map(k => k.split('|')[0]))].sort();
    const value = (month, type) => {
      const x = map.get(`${month}|${type}`);
      return x?.total ? x.complies / x.total : null;
    };
    return months.map(month => ({
      month,
      label: `${month.slice(5,7)}/${month.slice(0,4)}`,
      local: value(month, 'local'),
      personnel: value(month, 'personnel'),
      vehicle: value(month, 'vehicle')
    }));
  }

  function getAnalysisExportData() {
    if (!state.analysisLoaded) throw new Error('Primero cargá la sección Análisis.');
    const { range, audits, responses, byId } = getAnalysisDataset();
    const evaluated = responses.filter(r => evaluatedAnswer(r.answer));
    const complies = evaluated.filter(r => r.answer === 'complies').length;
    const failures = evaluated.filter(r => r.answer === 'non_complies').length;
    const critical = evaluated.filter(r => r.answer === 'non_complies' && r.is_critical_snapshot).length;
    const metrics = buildFailureMetrics(audits, responses);
    const staff = buildStaffMetrics(audits, responses);
    const incomplete = audits.filter(a => !auditCoverage(a).complete).length;
    const recurring = metrics.filter(m => m.failures >= 2).length;
    const observations = responses
      .filter(r => r.answer === 'non_complies' && r.observation)
      .map(r => {
        const audit = byId.get(r.audit_id);
        return audit ? {
          date: audit.audit_date,
          type: audit.audit_type,
          identity: auditIdentity(audit),
          staff: audit.audit_type === 'personnel' ? (audit.staff_member_name_snapshot || '') : '',
          section: r.section_title_snapshot || '',
          item: r.item_title_snapshot || '',
          critical: !!r.is_critical_snapshot,
          observation: r.observation
        } : null;
      })
      .filter(Boolean)
      .sort((a,b) => String(b.date).localeCompare(String(a.date)));
    return {
      range, audits, responses, evaluated, metrics, staff, observations,
      insights: buildAnalysisInsightsData(audits, responses, metrics, staff),
      trendRows: buildAnalysisTrendRows(audits, responses),
      kpis: {
        audits: audits.length,
        evaluated: evaluated.length,
        complies,
        failures,
        compliance: evaluated.length ? complies / evaluated.length : null,
        critical,
        recurring,
        incomplete
      }
    };
  }

  function analysisFilename(ext, range) {
    const clean = v => String(v || '').replace(/[^0-9-]/g, '');
    const suffix = range.from || range.to
      ? `${clean(range.from) || 'inicio'}_a_${clean(range.to) || 'hoy'}`
      : 'todo_el_historial';
    return `Analisis_CleanIt_${suffix}.${ext}`;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function analysisPriorityText(metric) {
    if (metric.criticalFailures > 0 || (metric.failures >= 2 && metric.failureRate >= 30)) return 'Alta';
    if (metric.failures >= 2 || metric.failureRate >= 15) return 'Media';
    return 'Baja';
  }

  function analysisPdfSectionTitle(doc, text, y) {
    const pageHeight = doc.internal.pageSize.getHeight();
    if (y > pageHeight - 28) { doc.addPage(); y = 18; }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(0);
    doc.text(text, 14, y);
    return y + 3;
  }

  async function downloadAnalysisPdf() {
    loading(true);
    try {
      const data = getAnalysisExportData();
      const { jsPDF } = window.jspdf || {};
      if (!jsPDF) throw new Error('No se pudo cargar el generador de PDF.');
      const doc = new jsPDF({ unit: 'mm', format: 'a4' });
      const margin = 14;
      doc.setFont('helvetica', 'bold'); doc.setFontSize(18); doc.text('CLEAN IT', margin, 16);
      doc.setFontSize(14); doc.text('Análisis de auditorías', margin, 24);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
      doc.text(`Período: ${data.range.label}${data.range.from ? ` · ${fmtDate(data.range.from)} a ${fmtDate(data.range.to || todayISO())}` : ''}`, margin, 31);
      doc.text(`Generado: ${fmtDateTime(new Date().toISOString())}`, margin, 36);

      doc.autoTable({
        startY: 42,
        head: [['Auditorías','Cumplimiento','Evaluaciones','Incumplimientos','Críticas','Recurrencias','Incompletas']],
        body: [[data.kpis.audits, data.kpis.compliance === null ? '—' : `${(data.kpis.compliance*100).toFixed(1)}%`, data.kpis.evaluated, data.kpis.failures, data.kpis.critical, data.kpis.recurring, data.kpis.incomplete]],
        theme:'grid', styles:{fontSize:7.5, cellPadding:1.8}, headStyles:{fillColor:[17,24,39]}, margin:{left:margin,right:margin}
      });
      let y = doc.lastAutoTable.finalY + 8;

      y = analysisPdfSectionTitle(doc, 'Lectura ejecutiva', y);
      doc.autoTable({ startY:y, head:[['Hallazgo','Interpretación']], body:data.insights.length ? data.insights.map(i => [i.title, i.text]) : [['Sin hallazgos','No hay datos suficientes.']], theme:'grid', styles:{fontSize:8,cellPadding:2,overflow:'linebreak'}, headStyles:{fillColor:[17,24,39]}, columnStyles:{0:{cellWidth:55}}, margin:{left:margin,right:margin} });
      y = doc.lastAutoTable.finalY + 8;

      y = analysisPdfSectionTitle(doc, 'Ranking de operarios', y);
      doc.autoTable({ startY:y, head:[['Operario','Aud.','Eval.','Cumpl.','No cumple','Críticas','Principal incumplimiento','Frecuencia']], body:data.staff.length ? data.staff.map(s => [s.name,s.audits,s.evaluated,s.compliance===null?'—':`${s.compliance.toFixed(1)}%`,s.failures,s.critical,s.topFailure?.title||'—',s.topFailure?`${s.topFailure.failures}/${s.topFailure.evaluated} (${s.topFailure.failureRate.toFixed(1)}%)`:'—']) : [['Sin datos','','','','','','','']], theme:'grid', styles:{fontSize:6.8,cellPadding:1.4,overflow:'linebreak'}, headStyles:{fillColor:[17,24,39]}, margin:{left:margin,right:margin} });
      y = doc.lastAutoTable.finalY + 8;

      const staffDetailRows = [];
      data.staff.forEach(s => s.items.forEach(i => staffDetailRows.push([s.name, `${i.code ? `${i.code} · ` : ''}${i.title}`, i.failures, i.evaluated, `${i.failureRate.toFixed(1)}%`, i.critical ? 'Sí' : 'No', fmtDate(i.lastFailure)])));
      y = analysisPdfSectionTitle(doc, 'Detalle de incumplimientos por operario', y);
      doc.autoTable({ startY:y, head:[['Operario','Incumplimiento','Fallas','Evaluado','Frecuencia','Crítico','Última']], body:staffDetailRows.length ? staffDetailRows : [['Sin incumplimientos individuales','','','','','','']], theme:'grid', styles:{fontSize:6.8,cellPadding:1.4,overflow:'linebreak'}, headStyles:{fillColor:[17,24,39]}, margin:{left:margin,right:margin} });
      y = doc.lastAutoTable.finalY + 8;

      const addFailureTable = (title, rows) => {
        y = analysisPdfSectionTitle(doc, title, y);
        doc.autoTable({ startY:y, head:[['Ítem','Sección','Fallas','Evaluado','Frecuencia','Críticas','Última','Prioridad']], body:rows.length ? rows.map(m => [`${m.code ? `${m.code} · ` : ''}${m.title}`,m.section,m.failures,m.evaluated,`${m.failureRate.toFixed(1)}%`,m.criticalFailures,fmtDate(m.lastFailure),analysisPriorityText(m)]) : [['Sin incumplimientos','','','','','','','']], theme:'grid', styles:{fontSize:6.8,cellPadding:1.4,overflow:'linebreak'}, headStyles:{fillColor:[17,24,39]}, margin:{left:margin,right:margin} });
        y = doc.lastAutoTable.finalY + 8;
      };
      addFailureTable('Estado del local · incumplimientos', data.metrics.filter(m => m.auditType === 'local' && m.failures > 0));
      addFailureTable('Vehículos · incumplimientos', data.metrics.filter(m => m.auditType === 'vehicle' && m.failures > 0));
      addFailureTable('Incumplimientos generales', data.metrics.filter(m => m.failures > 0));

      y = analysisPdfSectionTitle(doc, 'Evolución mensual del cumplimiento', y);
      doc.autoTable({ startY:y, head:[['Mes','Estado del local','Presentación del personal','Vehículo']], body:data.trendRows.length ? data.trendRows.map(r => [r.label,r.local===null?'—':`${(r.local*100).toFixed(1)}%`,r.personnel===null?'—':`${(r.personnel*100).toFixed(1)}%`,r.vehicle===null?'—':`${(r.vehicle*100).toFixed(1)}%`]) : [['Sin datos','','','']], theme:'grid', styles:{fontSize:7.5,cellPadding:1.7}, headStyles:{fillColor:[17,24,39]}, margin:{left:margin,right:margin} });
      y = doc.lastAutoTable.finalY + 8;

      y = analysisPdfSectionTitle(doc, 'Evidencia cualitativa · observaciones de incumplimientos', y);
      doc.autoTable({ startY:y, head:[['Fecha','Tipo','Identificación','Ítem','Crítica','Observación']], body:data.observations.length ? data.observations.map(o => [fmtDate(o.date),auditTypeLabel(o.type),o.identity,o.item,o.critical?'Sí':'No',o.observation]) : [['Sin observaciones','','','','','']], theme:'grid', styles:{fontSize:6.8,cellPadding:1.5,overflow:'linebreak'}, headStyles:{fillColor:[17,24,39]}, margin:{left:margin,right:margin} });

      const pages = doc.getNumberOfPages();
      for (let p=1; p<=pages; p++) { doc.setPage(p); doc.setFont('helvetica','normal'); doc.setFontSize(7); doc.setTextColor(110); doc.text(`Clean It · Análisis · Página ${p}/${pages}`, 14, 292); }
      doc.save(analysisFilename('pdf', data.range));
      toast('Análisis descargado en PDF.', 'success');
    } catch (e) { console.error(e); toast(e?.message || 'No se pudo generar el PDF de análisis.', 'danger'); }
    finally { loading(false); }
  }

  function setSheetWidths(ws, widths) {
    ws['!cols'] = widths.map(w => ({ wch: w }));
    if (ws['!ref']) ws['!autofilter'] = { ref: ws['!ref'] };
  }

  function formatPercentColumns(ws, headerNames = []) {
    if (!ws?.['!ref'] || !headerNames.length) return;
    const range = window.XLSX.utils.decode_range(ws['!ref']);
    const headers = {};
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = ws[window.XLSX.utils.encode_cell({ r: range.s.r, c })];
      if (cell?.v !== undefined) headers[String(cell.v)] = c;
    }
    headerNames.forEach(name => {
      const c = headers[name];
      if (c === undefined) return;
      for (let r = range.s.r + 1; r <= range.e.r; r++) {
        const cell = ws[window.XLSX.utils.encode_cell({ r, c })];
        if (cell && typeof cell.v === 'number') cell.z = '0.0%';
      }
    });
  }

  async function downloadAnalysisXlsx() {
    loading(true);
    try {
      const data = getAnalysisExportData();
      const XLSX = window.XLSX;
      if (!XLSX) throw new Error('No se pudo cargar el generador de Excel.');
      const wb = XLSX.utils.book_new();

      const summary = [
        ['CLEAN IT · ANÁLISIS DE AUDITORÍAS'],
        ['Período', data.range.label],
        ['Desde', data.range.from ? fmtDate(data.range.from) : 'Inicio'],
        ['Hasta', data.range.to ? fmtDate(data.range.to) : 'Actualidad'],
        ['Generado', fmtDateTime(new Date().toISOString())],
        [],
        ['Indicador','Valor'],
        ['Auditorías analizadas', data.kpis.audits],
        ['Ítems evaluados', data.kpis.evaluated],
        ['Cumplimiento', data.kpis.compliance],
        ['Incumplimientos', data.kpis.failures],
        ['Fallas críticas', data.kpis.critical],
        ['Recurrencias', data.kpis.recurring],
        ['Auditorías incompletas', data.kpis.incomplete],
        [],
        ['LECTURA EJECUTIVA'],
        ['Hallazgo','Interpretación'],
        ...data.insights.map(i => [i.title, i.text])
      ];
      const wsSummary = XLSX.utils.aoa_to_sheet(summary);
      setSheetWidths(wsSummary, [34, 100]);
      if (wsSummary['B10']) wsSummary['B10'].z = '0.0%';
      XLSX.utils.book_append_sheet(wb, wsSummary, 'Resumen');

      const staffRows = data.staff.map(s => ({
        Operario:s.name, Auditorías:s.audits, Evaluaciones:s.evaluated, Cumple:s.complies, 'No cumple':s.failures,
        'Fallas críticas':s.critical, 'Cumplimiento %':s.compliance === null ? null : s.compliance/100,
        'Principal incumplimiento':s.topFailure?.title || '', 'Fallas principal':s.topFailure?.failures || 0,
        'Evaluado principal':s.topFailure?.evaluated || 0, 'Frecuencia principal %':s.topFailure ? s.topFailure.failureRate/100 : null
      }));
      const wsStaff = XLSX.utils.json_to_sheet(staffRows.length ? staffRows : [{Operario:'Sin datos'}]);
      setSheetWidths(wsStaff, [28,12,14,10,12,14,16,42,16,18,20]);
      formatPercentColumns(wsStaff, ['Cumplimiento %','Frecuencia principal %']);
      XLSX.utils.book_append_sheet(wb, wsStaff, 'Operarios');

      const staffDetail = [];
      data.staff.forEach(s => s.items.forEach(i => staffDetail.push({
        Operario:s.name, Ítem:i.title, Código:i.code || '', Crítico:i.critical?'Sí':'No', Fallas:i.failures,
        Evaluado:i.evaluated, 'Frecuencia %':i.failureRate/100, 'Última falla':i.lastFailure ? fmtDate(i.lastFailure) : ''
      })));
      const wsStaffDetail = XLSX.utils.json_to_sheet(staffDetail.length ? staffDetail : [{Operario:'Sin incumplimientos individuales'}]);
      setSheetWidths(wsStaffDetail, [28,48,12,10,10,12,14,16]);
      formatPercentColumns(wsStaffDetail, ['Frecuencia %']);
      XLSX.utils.book_append_sheet(wb, wsStaffDetail, 'Detalle operarios');

      const failureRows = data.metrics.filter(m => m.failures > 0).map(m => ({
        Tipo:auditTypeLabel(m.auditType), Sección:m.section, Código:m.code || '', Ítem:m.title, Crítico:m.critical?'Sí':'No',
        Fallas:m.failures, Evaluado:m.evaluated, 'Frecuencia %':m.failureRate/100, 'Fallas críticas':m.criticalFailures,
        'Última falla':m.lastFailure ? fmtDate(m.lastFailure) : '', Prioridad:analysisPriorityText(m)
      }));
      const wsFailures = XLSX.utils.json_to_sheet(failureRows.length ? failureRows : [{Tipo:'Sin incumplimientos'}]);
      setSheetWidths(wsFailures, [24,38,12,48,10,10,12,14,16,16,12]);
      formatPercentColumns(wsFailures, ['Frecuencia %']);
      XLSX.utils.book_append_sheet(wb, wsFailures, 'Incumplimientos');

      const processSheet = (type, name) => {
        const rows = data.metrics.filter(m => m.auditType === type && m.failures > 0).map(m => ({
          Sección:m.section, Código:m.code || '', Ítem:m.title, Crítico:m.critical?'Sí':'No', Fallas:m.failures,
          Evaluado:m.evaluated, 'Frecuencia %':m.failureRate/100, 'Fallas críticas':m.criticalFailures,
          'Última falla':m.lastFailure ? fmtDate(m.lastFailure) : '', Prioridad:analysisPriorityText(m)
        }));
        const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{Sección:'Sin incumplimientos'}]);
        setSheetWidths(ws, [38,12,50,10,10,12,14,16,16,12]);
        formatPercentColumns(ws, ['Frecuencia %']);
        XLSX.utils.book_append_sheet(wb, ws, name);
      };
      processSheet('local', 'Estado local');
      processSheet('vehicle', 'Vehículos');

      const trendRows = data.trendRows.map(r => ({
        Mes:r.label, 'Estado del local':r.local, 'Presentación del personal':r.personnel, Vehículo:r.vehicle
      }));
      const wsTrend = XLSX.utils.json_to_sheet(trendRows.length ? trendRows : [{Mes:'Sin datos'}]);
      setSheetWidths(wsTrend, [14,22,28,18]);
      formatPercentColumns(wsTrend, ['Estado del local','Presentación del personal','Vehículo']);
      XLSX.utils.book_append_sheet(wb, wsTrend, 'Tendencia');

      const observationRows = data.observations.map(o => ({
        Fecha:fmtDate(o.date), Tipo:auditTypeLabel(o.type), Identificación:o.identity, Operario:o.staff || '', Sección:o.section,
        Ítem:o.item, Crítico:o.critical?'Sí':'No', Observación:o.observation
      }));
      const wsObs = XLSX.utils.json_to_sheet(observationRows.length ? observationRows : [{Fecha:'Sin observaciones'}]);
      setSheetWidths(wsObs, [14,24,28,28,38,48,10,70]);
      XLSX.utils.book_append_sheet(wb, wsObs, 'Observaciones');

      const auditRows = data.audits.map(a => ({
        Fecha:fmtDate(a.audit_date), Tipo:auditTypeLabel(a.audit_type), Identificación:auditIdentity(a), Responsables:auditPeopleSummary(a),
        Auditor:a.auditor?.full_name || a.auditor?.email || '', Puntaje:a.score === null || a.score === undefined ? null : Number(a.score)/100,
        Resultado:a.classification || '', Completa:auditCoverage(a).complete?'Sí':'No', 'Ítems respondidos':auditCoverage(a).answered,
        'Ítems totales':auditCoverage(a).total, 'Pendientes':auditCoverage(a).unanswered
      }));
      const wsAudits = XLSX.utils.json_to_sheet(auditRows.length ? auditRows : [{Fecha:'Sin auditorías'}]);
      setSheetWidths(wsAudits, [14,24,28,60,30,12,28,12,18,14,12]);
      formatPercentColumns(wsAudits, ['Puntaje']);
      XLSX.utils.book_append_sheet(wb, wsAudits, 'Auditorías');

      XLSX.writeFile(wb, analysisFilename('xlsx', data.range));
      toast('Análisis descargado en Excel.', 'success');
    } catch (e) { console.error(e); toast(e?.message || 'No se pudo generar el Excel de análisis.', 'danger'); }
    finally { loading(false); }
  }

  function docxCell(text, bold = false) {
    const d = window.docx;
    return new d.TableCell({ children:[new d.Paragraph({ children:[new d.TextRun({ text:String(text ?? '—'), bold })] })] });
  }

  function docxTable(headers, rows) {
    const d = window.docx;
    return new d.Table({
      width:{ size:100, type:d.WidthType.PERCENTAGE },
      rows:[
        new d.TableRow({ tableHeader:true, children:headers.map(h => docxCell(h, true)) }),
        ...rows.map(row => new d.TableRow({ children:row.map(v => docxCell(v, false)) }))
      ]
    });
  }

  async function downloadAnalysisDocx() {
    loading(true);
    try {
      const data = getAnalysisExportData();
      const d = window.docx;
      if (!d?.Document || !d?.Packer) throw new Error('No se pudo cargar el generador de Word.');
      const children = [
        new d.Paragraph({ heading:d.HeadingLevel.TITLE, children:[new d.TextRun('CLEAN IT · Análisis de auditorías')] }),
        new d.Paragraph({ children:[new d.TextRun({ text:`Período: ${data.range.label}${data.range.from ? ` · ${fmtDate(data.range.from)} a ${fmtDate(data.range.to || todayISO())}` : ''}`, bold:true })] }),
        new d.Paragraph({ children:[new d.TextRun(`Generado: ${fmtDateTime(new Date().toISOString())}`)] }),
        new d.Paragraph({ heading:d.HeadingLevel.HEADING_1, children:[new d.TextRun('Resumen ejecutivo')] }),
        docxTable(['Indicador','Valor'], [
          ['Auditorías analizadas', data.kpis.audits],
          ['Ítems evaluados', data.kpis.evaluated],
          ['Cumplimiento', data.kpis.compliance === null ? '—' : `${(data.kpis.compliance*100).toFixed(1)}%`],
          ['Incumplimientos', data.kpis.failures], ['Fallas críticas', data.kpis.critical],
          ['Recurrencias', data.kpis.recurring], ['Auditorías incompletas', data.kpis.incomplete]
        ]),
        new d.Paragraph({ heading:d.HeadingLevel.HEADING_1, children:[new d.TextRun('Lectura ejecutiva')] }),
        ...data.insights.flatMap(i => [
          new d.Paragraph({ children:[new d.TextRun({ text:i.title, bold:true })] }),
          new d.Paragraph({ children:[new d.TextRun(i.text)] })
        ]),
        new d.Paragraph({ heading:d.HeadingLevel.HEADING_1, children:[new d.TextRun('Ranking de operarios')] }),
        docxTable(['Operario','Aud.','Eval.','Cumpl.','No cumple','Críticas','Principal incumplimiento','Frecuencia'], data.staff.length ? data.staff.map(s => [s.name,s.audits,s.evaluated,s.compliance===null?'—':`${s.compliance.toFixed(1)}%`,s.failures,s.critical,s.topFailure?.title||'—',s.topFailure?`${s.topFailure.failures}/${s.topFailure.evaluated} (${s.topFailure.failureRate.toFixed(1)}%)`:'—']) : [['Sin datos','','','','','','','']]),
        new d.Paragraph({ heading:d.HeadingLevel.HEADING_1, children:[new d.TextRun('Detalle de incumplimientos por operario')] }),
        docxTable(['Operario','Incumplimiento','Fallas','Evaluado','Frecuencia','Crítico','Última'], (() => { const rows=[]; data.staff.forEach(s => s.items.forEach(i => rows.push([s.name,`${i.code?`${i.code} · `:''}${i.title}`,i.failures,i.evaluated,`${i.failureRate.toFixed(1)}%`,i.critical?'Sí':'No',fmtDate(i.lastFailure)]))); return rows.length ? rows : [['Sin incumplimientos individuales','','','','','','']]; })()),
        new d.Paragraph({ heading:d.HeadingLevel.HEADING_1, children:[new d.TextRun('Estado del local · incumplimientos')] }),
        docxTable(['Ítem','Fallas','Evaluado','Frecuencia','Críticas','Última','Prioridad'], data.metrics.filter(m=>m.auditType==='local'&&m.failures>0).length ? data.metrics.filter(m=>m.auditType==='local'&&m.failures>0).map(m => [`${m.code?`${m.code} · `:''}${m.title}`,m.failures,m.evaluated,`${m.failureRate.toFixed(1)}%`,m.criticalFailures,fmtDate(m.lastFailure),analysisPriorityText(m)]) : [['Sin incumplimientos','','','','','','']]),
        new d.Paragraph({ heading:d.HeadingLevel.HEADING_1, children:[new d.TextRun('Vehículos · incumplimientos')] }),
        docxTable(['Ítem','Fallas','Evaluado','Frecuencia','Críticas','Última','Prioridad'], data.metrics.filter(m=>m.auditType==='vehicle'&&m.failures>0).length ? data.metrics.filter(m=>m.auditType==='vehicle'&&m.failures>0).map(m => [`${m.code?`${m.code} · `:''}${m.title}`,m.failures,m.evaluated,`${m.failureRate.toFixed(1)}%`,m.criticalFailures,fmtDate(m.lastFailure),analysisPriorityText(m)]) : [['Sin incumplimientos','','','','','','']]),
        new d.Paragraph({ heading:d.HeadingLevel.HEADING_1, children:[new d.TextRun('Incumplimientos generales')] }),
        docxTable(['Tipo','Ítem','Fallas','Evaluado','Frecuencia','Críticas','Última','Prioridad'], data.metrics.filter(m=>m.failures>0).length ? data.metrics.filter(m=>m.failures>0).map(m => [auditTypeLabel(m.auditType),`${m.code?`${m.code} · `:''}${m.title}`,m.failures,m.evaluated,`${m.failureRate.toFixed(1)}%`,m.criticalFailures,fmtDate(m.lastFailure),analysisPriorityText(m)]) : [['Sin incumplimientos','','','','','','','']]),
        new d.Paragraph({ heading:d.HeadingLevel.HEADING_1, children:[new d.TextRun('Evolución mensual')] }),
        docxTable(['Mes','Estado del local','Presentación del personal','Vehículo'], data.trendRows.length ? data.trendRows.map(r => [r.label,r.local===null?'—':`${(r.local*100).toFixed(1)}%`,r.personnel===null?'—':`${(r.personnel*100).toFixed(1)}%`,r.vehicle===null?'—':`${(r.vehicle*100).toFixed(1)}%`]) : [['Sin datos','','','']]),
        new d.Paragraph({ heading:d.HeadingLevel.HEADING_1, children:[new d.TextRun('Evidencia cualitativa')] }),
        docxTable(['Fecha','Tipo','Identificación','Ítem','Crítica','Observación'], data.observations.length ? data.observations.map(o => [fmtDate(o.date),auditTypeLabel(o.type),o.identity,o.item,o.critical?'Sí':'No',o.observation]) : [['Sin observaciones','','','','','']]),
        new d.Paragraph({ children:[new d.TextRun({ text:'Criterio: los porcentajes excluyen respuestas N/A y preguntas sin responder. El ranking individual utiliza únicamente auditorías de Presentación del personal.', italics:true })] })
      ];
      const doc = new d.Document({ sections:[{ properties:{}, children }] });
      const blob = await d.Packer.toBlob(doc);
      downloadBlob(blob, analysisFilename('docx', data.range));
      toast('Análisis descargado en Word.', 'success');
    } catch (e) { console.error(e); toast(e?.message || 'No se pudo generar el Word de análisis.', 'danger'); }
    finally { loading(false); }
  }

  // ============================================================
  // AUDIT EXECUTION
  // ============================================================
  function toggleAuditStartFields() {
    const type = document.querySelector('input[name="auditType"]:checked')?.value || 'local';
    el('startLocalFields').classList.toggle('d-none', type !== 'local');
    el('startPersonnelFields').classList.toggle('d-none', type !== 'personnel');
    el('startVehicleFields').classList.toggle('d-none', type !== 'vehicle');
    el('vehiclePlate').required = type === 'vehicle';
    if (type === 'local') renderStaffChecks('startPresentStaffList', [], 'start-staff-check');
    if (type === 'personnel') renderStaffSelect('personnelStaffMember');
  }

  function resetNewAuditView() {
    state.editingCompleted = false;
    el('auditStartPanel').classList.remove('d-none');
    el('auditExecutionPanel').classList.add('d-none');
    el('editAuditMetaPanel').classList.add('d-none');
    el('auditStartForm').reset();
    const localRadio = document.querySelector('input[name="auditType"][value="local"]');
    if (localRadio) localRadio.checked = true;
    el('auditDate').value = todayISO();
    toggleAuditStartFields();
  }

  async function startAudit(ev) {
    ev.preventDefault();
    loading(true);
    try {
      const auditType = document.querySelector('input[name="auditType"]:checked')?.value || 'local';
      if (!['local','personnel','vehicle'].includes(auditType)) throw new Error('Seleccioná un tipo de auditoría válido.');
      if (auditType === 'vehicle' && !el('vehiclePlate').value.trim()) throw new Error('La patente es obligatoria para una auditoría de vehículo.');

      if (!state.staffMembers.length && auditType !== 'vehicle') await loadStaffMembers(false);
      const localStaff = selectedStaffFrom('.start-staff-check');
      const personnelId = el('personnelStaffMember')?.value || '';
      const personnel = state.staffMembers.find(x => String(x.id) === String(personnelId));
      if (auditType === 'local' && !localStaff.ids.length) throw new Error('Marcá al menos un operario presente en el local.');
      if (auditType === 'personnel' && !personnel) throw new Error('Seleccioná el operario que vas a auditar.');

      const checklist = await fetchChecklist(true, auditType);
      const activeItems = checklist.flatMap(section => section.items);
      if (!activeItems.length) throw new Error(`No hay ítems activos para la auditoría de ${auditTypeLabel(auditType).toLowerCase()}.`);

      state.editingCompleted = false;
      const meta = {
        audit_date: el('auditDate').value || todayISO(),
        auditor_id: state.profile.id,
        audit_type: auditType,
        responsible_name: auditType === 'local' ? (el('responsibleName').value.trim() || null) : null,
        operators_text: auditType === 'local' ? localStaff.names.join(', ') : null,
        present_staff_ids: auditType === 'local' ? localStaff.ids : [],
        staff_member_id: auditType === 'personnel' ? personnel.id : null,
        staff_member_name_snapshot: auditType === 'personnel' ? personnel.full_name : null,
        vehicle_plate: auditType === 'vehicle' ? (el('vehiclePlate').value.trim().toUpperCase() || null) : null,
        vehicle_received_by: auditType === 'vehicle' ? (el('vehicleReceivedBy').value.trim() || null) : null,
        vehicle_workers_text: auditType === 'vehicle' ? (el('vehicleWorkersText').value.trim() || null) : null,
        vehicle_final_control_by: auditType === 'vehicle' ? (el('vehicleFinalControlBy').value.trim() || null) : null,
        general_notes: el('auditGeneralNotes').value.trim() || null,
        status: 'draft'
      };
      const { data: audit, error } = await client.from('audits').insert(meta).select().single();
      if (error) throw error;

      const snapshots = [];
      checklist.forEach(section => section.items.forEach(item => snapshots.push({
        audit_id: audit.id, section_id: section.id, item_id: item.id,
        section_title_snapshot: section.title, section_order_snapshot: section.sort_order, item_code_snapshot: item.code,
        item_title_snapshot: item.title, criterion_snapshot: item.criterion, is_critical_snapshot: item.is_critical,
        item_order_snapshot: item.sort_order, answer: null, observation: null
      })));
      const { data: responses, error: responseError } = await client.from('audit_responses').insert(snapshots).select();
      if (responseError) throw responseError;

      state.activeAudit = audit;
      state.activeResponses = responses;
      state.activeChecklist = checklist;
      showAuditExecution();
      toast('Auditoría iniciada. Las respuestas se guardan automáticamente.', 'success');
    } catch (e) {
      console.error(e);
      const hint = String(e?.message || '').includes('audit_type') || String(e?.message || '').includes('staff_member') || String(e?.message || '').includes('present_staff')
        ? ' Ejecutá supabase/migration_v5_three_audit_types_staff.sql en Supabase.' : '';
      toast(`${e?.message || 'No se pudo iniciar la auditoría.'}${hint}`, 'danger');
    } finally { loading(false); }
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
    const audit = state.activeAudit;
    const editing = state.editingCompleted;
    const type = audit.audit_type || 'legacy';

    const title = type === 'vehicle'
      ? `Vehículo ${audit.vehicle_plate || 'sin patente'}`
      : type === 'personnel' ? `Presentación · ${audit.staff_member_name_snapshot || 'operario'}`
      : type === 'local' ? 'Estado general del local' : (audit.vehicle_plate ? `Auditoría histórica · ${audit.vehicle_plate}` : 'Auditoría histórica');
    el('activeAuditTitle').textContent = editing ? `Editando · ${title}` : title;
    el('activeAuditMeta').textContent = `${auditTypeLabel(type)} · ${fmtDate(audit.audit_date)} · Auditor: ${audit.auditor?.full_name || audit.auditor?.email || state.profile.full_name || state.profile.email}${editing ? ' · Edición registrada' : ''}`;
    el('executionGeneralNotes').value = audit.general_notes || '';

    // Los metadatos quedan visibles también en borrador para poder completar, por ejemplo, quién hizo el control final.
    el('editAuditMetaPanel').classList.remove('d-none');
    el('editMetaHelp').textContent = editing ? 'La edición quedará registrada en la trazabilidad de cambios.' : 'Podés completar o corregir estos datos durante la auditoría; se guardan en el borrador.';
    el('editAuditDate').value = audit.audit_date || todayISO();
    el('editAuditTypeLabel').value = auditTypeLabel(type);
    el('editResponsibleName').value = audit.responsible_name || '';
    renderStaffChecks('editPresentStaffList', audit.present_staff_ids || [], 'edit-staff-check');
    renderStaffSelect('editStaffMember', audit.staff_member_id || '');
    el('editVehiclePlate').value = audit.vehicle_plate || '';
    el('editVehicleReceivedBy').value = audit.vehicle_received_by || '';
    el('editVehicleWorkersText').value = audit.vehicle_workers_text || '';
    el('editVehicleFinalControlBy').value = audit.vehicle_final_control_by || '';
    el('editLocalFields').classList.toggle('d-none', type !== 'local');
    el('editPersonnelFields').classList.toggle('d-none', type !== 'personnel');
    el('editVehicleFields').classList.toggle('d-none', type !== 'vehicle');
    $$('.edit-staff-check').forEach(ch => ch.addEventListener('change', saveDraftMetadata));

    const badge = el('editModeBadge');
    if (badge) {
      badge.textContent = editing ? 'Modo edición' : 'Datos editables';
      badge.className = editing ? 'badge text-bg-warning' : 'badge text-bg-light border';
    }

    if (editing) {
      el('exitDraftBtn').textContent = 'Cancelar edición';
      el('finalizeAuditBtn').textContent = 'Guardar cambios';
      el('finalizeAuditBtn').className = 'btn btn-dark btn-lg';
    } else {
      el('exitDraftBtn').textContent = 'Guardar y salir';
      el('finalizeAuditBtn').textContent = 'Finalizar auditoría';
      el('finalizeAuditBtn').className = 'btn btn-success btn-lg';
    }

    renderAuditChecklist();
    updateAuditProgress();
  }

  function collectExecutionMeta() {
    const type = state.activeAudit?.audit_type || 'legacy';
    const localStaff = selectedStaffFrom('.edit-staff-check');
    const personnelId = el('editStaffMember')?.value || state.activeAudit?.staff_member_id || '';
    const personnel = state.staffMembers.find(x => String(x.id) === String(personnelId));
    return {
      audit_date: el('editAuditDate').value || state.activeAudit?.audit_date || todayISO(),
      responsible_name: type === 'local' ? (el('editResponsibleName').value.trim() || null) : type === 'legacy' ? (state.activeAudit?.responsible_name || null) : null,
      operators_text: type === 'local' ? localStaff.names.join(', ') : type === 'legacy' ? (state.activeAudit?.operators_text || null) : null,
      present_staff_ids: type === 'local' ? localStaff.ids : type === 'legacy' ? (state.activeAudit?.present_staff_ids || []) : [],
      staff_member_id: type === 'personnel' ? (personnel?.id || personnelId || null) : type === 'legacy' ? (state.activeAudit?.staff_member_id || null) : null,
      staff_member_name_snapshot: type === 'personnel' ? (personnel?.full_name || state.activeAudit?.staff_member_name_snapshot || null) : type === 'legacy' ? (state.activeAudit?.staff_member_name_snapshot || null) : null,
      vehicle_plate: type === 'vehicle' ? (el('editVehiclePlate').value.trim().toUpperCase() || null) : type === 'legacy' ? (state.activeAudit?.vehicle_plate || null) : null,
      vehicle_received_by: type === 'vehicle' ? (el('editVehicleReceivedBy').value.trim() || null) : type === 'legacy' ? (state.activeAudit?.vehicle_received_by || null) : null,
      vehicle_workers_text: type === 'vehicle' ? (el('editVehicleWorkersText').value.trim() || null) : type === 'legacy' ? (state.activeAudit?.vehicle_workers_text || null) : null,
      vehicle_final_control_by: type === 'vehicle' ? (el('editVehicleFinalControlBy').value.trim() || null) : type === 'legacy' ? (state.activeAudit?.vehicle_final_control_by || null) : null
    };
  }

  function validateAuditIdentity(meta) {
    const type = state.activeAudit?.audit_type;
    if (type === 'local' && !(meta.present_staff_ids || []).length) return ['al menos un operario presente'];
    if (type === 'personnel' && !meta.staff_member_id) return ['operario auditado'];
    return [];
  }

  function validateVehicleTraceability(meta) {
    if (state.activeAudit?.audit_type !== 'vehicle') return [];
    const missing = [];
    if (!meta.vehicle_plate) missing.push('patente');
    if (!meta.vehicle_received_by) missing.push('quién recibió el vehículo');
    if (!meta.vehicle_workers_text) missing.push('quiénes trabajaron sobre el vehículo');
    if (!meta.vehicle_final_control_by) missing.push('quién realizó el control final');
    return missing;
  }

  async function saveDraftMetadata() {
    if (!state.activeAudit || state.editingCompleted) return;
    const meta = collectExecutionMeta();
    Object.assign(state.activeAudit, meta);
    const { error } = await client.from('audits').update(meta).eq('id', state.activeAudit.id);
    if (error) toast(error.message, 'danger');
  }

  function renderAuditChecklist() {
    const container = el('auditChecklistContainer');
    container.innerHTML = groupResponses(state.activeResponses).map(group => {
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

    $$('.answer-btn', container).forEach(btn => btn.addEventListener('click', () => answerResponse(btn.dataset.id, btn.dataset.answer)));
    $$('.response-observation', container).forEach(inp => inp.addEventListener('change', () => saveObservation(inp.dataset.id, inp.value)));
  }

  function answerButton(r, value, label) {
    return `<button type="button" class="answer-btn ${r.answer === value ? 'selected' : ''}" data-id="${r.id}" data-answer="${value}">${label}</button>`;
  }

  async function answerResponse(id, answer) {
    const response = state.activeResponses.find(x => x.id === id);
    if (!response) return;
    const old = response.answer;
    response.answer = answer;
    const row = document.querySelector(`[data-response-id="${id}"]`);
    $$('.answer-btn', row).forEach(button => button.classList.toggle('selected', button.dataset.answer === answer));
    updateAuditProgress();
    const indicator = document.querySelector(`[data-save-for="${id}"]`);
    if (state.editingCompleted) {
      if (indicator) indicator.textContent = 'Cambio pendiente';
      return;
    }
    if (indicator) indicator.textContent = 'Guardando…';
    const { error } = await client.from('audit_responses').update({ answer }).eq('id', id);
    if (error) {
      response.answer = old;
      renderAuditChecklist();
      updateAuditProgress();
      toast(error.message, 'danger');
    } else if (indicator) {
      indicator.textContent = 'Guardado';
      setTimeout(() => { if (indicator) indicator.textContent = ''; }, 1000);
    }
  }

  async function saveObservation(id, observation) {
    const response = state.activeResponses.find(x => x.id === id);
    if (response) response.observation = observation.trim() || null;
    const indicator = document.querySelector(`[data-save-for="${id}"]`);
    if (state.editingCompleted) {
      if (indicator) indicator.textContent = 'Cambio pendiente';
      return;
    }
    if (indicator) indicator.textContent = 'Guardando…';
    const { error } = await client.from('audit_responses').update({ observation: observation.trim() || null }).eq('id', id);
    if (error) toast(error.message, 'danger');
    else if (indicator) { indicator.textContent = 'Guardado'; setTimeout(() => { if (indicator) indicator.textContent = ''; }, 1000); }
  }

  async function saveGeneralNotes() {
    if (!state.activeAudit) return;
    const value = el('executionGeneralNotes').value.trim() || null;
    state.activeAudit.general_notes = value;
    if (state.editingCompleted) return;
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
    const total = responses.length;
    const answered = responses.filter(r => r.answer).length;
    const unanswered = total - answered;
    const applicable = responses.filter(r => r.answer && r.answer !== 'na');
    const compliant = applicable.filter(r => r.answer === 'complies').length;
    const noncompliant = applicable.filter(r => r.answer === 'non_complies').length;
    const critical = responses.filter(r => r.answer === 'non_complies' && r.is_critical_snapshot).length;
    const score = applicable.length ? compliant / applicable.length * 100 : null;
    let classification = 'Sin evaluación';
    if (score !== null) {
      classification = score >= 95 ? 'Conforme' : score >= 90 ? 'Conforme con observaciones' : 'No conforme';
      if (critical > 0) classification = 'No conforme';
    }
    return { total, answered, unanswered, complete: unanswered === 0 && total > 0, applicable: applicable.length, compliant, noncompliant, critical, score, classification };
  }

  async function finalizeAudit() {
    const meta = collectExecutionMeta();
    const identityMissing = validateAuditIdentity(meta);
    if (identityMissing.length) {
      toast(`Completá los datos requeridos: ${identityMissing.join(', ')}.`, 'warning');
      el('editAuditMetaPanel').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const traceMissing = validateVehicleTraceability(meta);
    if (traceMissing.length) {
      toast(`Completá la trazabilidad del vehículo: ${traceMissing.join(', ')}.`, 'warning');
      el('editAuditMetaPanel').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    const calc = calculateAudit(state.activeResponses);
    const scoreText = calc.score === null ? 'Sin evaluación' : `${calc.score.toFixed(1)}% · ${calc.classification}`;
    const warning = calc.unanswered > 0
      ? `ATENCIÓN: hay ${calc.unanswered} ítem${calc.unanswered === 1 ? '' : 's'} sin responder.\n\nPodés finalizar igualmente, pero la auditoría quedará identificada como INCOMPLETA. El puntaje se calculará únicamente sobre los ítems respondidos y aplicables.\n\nResultado preliminar: ${scoreText}.\n\n¿Finalizar de todas formas?`
      : `Resultado preliminar: ${scoreText}.\n\n¿Finalizar la auditoría? Quedará registrada en el historial y podrá editarse posteriormente con trazabilidad de cambios.`;
    if (!confirm(warning)) return;

    loading(true);
    try {
      await saveDraftMetadata();
      await saveGeneralNotes();
      const payload = {
        ...meta,
        status: 'completed', completed_at: new Date().toISOString(), score: calc.score === null ? null : Number(calc.score.toFixed(2)),
        classification: calc.classification, critical_failures: calc.critical,
        applicable_items: calc.applicable, compliant_items: calc.compliant, noncompliant_items: calc.noncompliant,
        total_items: calc.total, answered_items: calc.answered, unanswered_items: calc.unanswered, is_complete: calc.complete,
        general_notes: el('executionGeneralNotes').value.trim() || null
      };
      const { data, error } = await client.from('audits').update(payload).eq('id', state.activeAudit.id).select().single();
      if (error) throw error;
      state.activeAudit = null;
      state.activeResponses = [];
      state.analysisLoaded = false;
      toast(calc.complete ? 'Auditoría finalizada y registrada.' : `Auditoría finalizada con ${calc.unanswered} ítem(s) pendiente(s).`, calc.complete ? 'success' : 'warning');
      await openAudit(data.id);
    } catch (e) {
      console.error(e);
      const msg = String(e?.message || '');
      const hint = (msg.includes('total_items') || msg.includes('answered_items') || msg.includes('unanswered_items') || msg.includes('is_complete') || msg.includes('schema cache'))
        ? ' Ejecutá supabase/migration_v5_three_audit_types_staff.sql en Supabase.'
        : '';
      toast(`${e?.message || 'No se pudo finalizar la auditoría.'}${hint}`, 'danger');
    }
    finally { loading(false); }
  }

  async function continueDraft(id) {
    loading(true);
    try {
      const { data: audit, error } = await client.from('audits').select('*, auditor:profiles(full_name,email)').eq('id', id).single();
      if (error) throw error;
      if (audit.status !== 'draft') return openAudit(id);
      const { data: responses, error: responseError } = await client.from('audit_responses').select('*').eq('audit_id', id).order('section_order_snapshot').order('item_order_snapshot');
      if (responseError) throw responseError;
      await loadStaffMembers(true);
      state.activeAudit = audit;
      state.activeResponses = responses;
      state.editingCompleted = false;
      setView('newAudit', { load: false });
      showAuditExecution();
    } finally { loading(false); }
  }

  async function editCompletedAudit(id) {
    loading(true);
    try {
      const { data: audit, error } = await client.from('audits').select('*, auditor:profiles(full_name,email)').eq('id', id).single();
      if (error) throw error;
      if (audit.status !== 'completed') return continueDraft(id);
      const { data: responses, error: responseError } = await client.from('audit_responses').select('*').eq('audit_id', id).order('section_order_snapshot').order('item_order_snapshot');
      if (responseError) throw responseError;
      await loadStaffMembers(true);
      state.activeAudit = audit;
      state.activeResponses = responses;
      state.editingCompleted = true;
      setView('newAudit', { load: false });
      showAuditExecution();
    } catch (e) {
      console.error(e);
      toast(e?.message || 'No se pudo abrir la auditoría para editar.', 'danger');
    } finally { loading(false); }
  }

  async function saveCompletedAuditEdit() {
    if (!state.activeAudit || !state.editingCompleted) return;
    const meta = collectExecutionMeta();
    const identityMissing = validateAuditIdentity(meta);
    if (identityMissing.length) { toast(`Completá los datos requeridos: ${identityMissing.join(', ')}.`, 'warning'); return; }
    const traceMissing = validateVehicleTraceability(meta);
    if (traceMissing.length) {
      toast(`Completá la trazabilidad del vehículo: ${traceMissing.join(', ')}.`, 'warning');
      return;
    }

    const calc = calculateAudit(state.activeResponses);
    const warning = calc.unanswered > 0
      ? `Esta auditoría quedará finalizada con ${calc.unanswered} ítem${calc.unanswered === 1 ? '' : 's'} sin responder y figurará como INCOMPLETA.\n\n¿Guardar los cambios igualmente? La modificación quedará registrada en la trazabilidad.`
      : '¿Guardar los cambios de esta auditoría? La modificación quedará registrada en la trazabilidad.';
    if (!confirm(warning)) return;

    loading(true);
    try {
      const params = {
        p_audit_id: state.activeAudit.id,
        p_audit_date: meta.audit_date,
        p_responsible_name: meta.responsible_name,
        p_operators_text: meta.operators_text,
        p_present_staff_ids: meta.present_staff_ids,
        p_staff_member_id: meta.staff_member_id,
        p_staff_member_name_snapshot: meta.staff_member_name_snapshot,
        p_vehicle_plate: meta.vehicle_plate,
        p_vehicle_received_by: meta.vehicle_received_by,
        p_vehicle_workers_text: meta.vehicle_workers_text,
        p_vehicle_final_control_by: meta.vehicle_final_control_by,
        p_general_notes: el('executionGeneralNotes').value.trim() || null,
        p_responses: state.activeResponses.map(r => ({ id: r.id, answer: r.answer, observation: r.observation || null }))
      };
      const { error } = await client.rpc('update_completed_audit_v5', params);
      if (error) throw error;
      const id = state.activeAudit.id;
      state.activeAudit = null;
      state.activeResponses = [];
      state.editingCompleted = false;
      state.analysisLoaded = false;
      toast(calc.complete ? 'Auditoría actualizada. El cambio quedó registrado.' : `Auditoría actualizada e identificada como incompleta (${calc.unanswered} pendiente(s)).`, calc.complete ? 'success' : 'warning');
      await openAudit(id);
    } catch (e) {
      console.error(e);
      const msg = String(e?.message || '');
      const hint = msg.includes('update_completed_audit_v5') || msg.includes('does not exist')
        ? ' Ejecutá supabase/migration_v5_three_audit_types_staff.sql en Supabase.'
        : '';
      toast(`${e?.message || 'No se pudieron guardar los cambios.'}${hint}`, 'danger');
    } finally { loading(false); }
  }

  function openDeleteAuditModal(id) {
    const selected = [...state.historySelected];
    if (selected.length > 1 && state.historySelected.has(id)) openDeleteAuditsModal(selected);
    else openDeleteAuditsModal([id]);
  }

  function openDeleteAuditsModal(ids) {
    const unique = [...new Set((ids || []).filter(Boolean))];
    if (!unique.length) {
      toast('Seleccioná al menos una auditoría.', 'warning');
      return;
    }
    state.deleteAuditIds = unique;
    state.deleteAuditId = unique.length === 1 ? unique[0] : null;
    const found = unique.map(id => state.history.find(a => a.id === id)).filter(Boolean);
    const preview = found.slice(0, 5).map(a => `${fmtDate(a.audit_date)} · ${auditTypeLabel(a.audit_type)} · ${auditIdentity(a)}`);
    const more = unique.length > 5 ? `<div class="mt-1">… y ${unique.length - 5} auditoría(s) más.</div>` : '';
    el('deleteAuditSummary').innerHTML = `<strong>${unique.length} auditoría(s) seleccionada(s).</strong>${preview.length ? `<div class="mt-2">${preview.map(x => esc(x)).join('<br>')}</div>` : ''}${more}`;
    el('deleteAuditConfirmInput').value = '';
    el('confirmDeleteAuditBtn').disabled = true;
    state.modals.deleteAudit.show();
    setTimeout(() => el('deleteAuditConfirmInput').focus(), 250);
  }

  async function confirmDeleteAudit() {
    const ids = state.deleteAuditIds;
    if (!ids.length || el('deleteAuditConfirmInput').value.trim() !== 'ELIMINAR') return;
    el('confirmDeleteAuditBtn').disabled = true;
    el('confirmDeleteAuditBtn').textContent = 'Eliminando…';
    try {
      const { error } = await client.rpc('delete_audits_secure', { p_audit_ids: ids, p_confirmation: 'ELIMINAR' });
      if (error) throw error;
      state.modals.deleteAudit.hide();
      ids.forEach(id => state.historySelected.delete(id));
      state.history = state.history.filter(a => !ids.includes(a.id));
      state.analysisLoaded = false;
      toast(`${ids.length} auditoría(s) eliminada(s) definitivamente. La acción quedó registrada.`, 'success');
      if (state.currentView === 'auditDetail') setView('history');
      else if (state.currentView === 'history') await loadHistory();
      else await loadDashboard();
    } catch (e) {
      console.error(e);
      const msg = String(e?.message || '');
      const hint = (msg.includes('audit_activity_log') || msg.includes('delete_audits_secure') || msg.includes('does not exist'))
        ? ' Ejecutá supabase/migration_v5_three_audit_types_staff.sql en Supabase.'
        : '';
      toast(`${e?.message || 'No se pudieron eliminar las auditorías.'}${hint}`, 'danger');
    } finally {
      el('confirmDeleteAuditBtn').textContent = 'Eliminar definitivamente';
      el('confirmDeleteAuditBtn').disabled = el('deleteAuditConfirmInput').value.trim() !== 'ELIMINAR';
    }
  }

  // ============================================================
  // HISTORY
  // ============================================================
  async function loadHistory() {
    loading(true);
    try {
      const [{ data: audits, error }, { data: activity, error: activityError }] = await Promise.all([
        client.from('audits').select('*, auditor:profiles(full_name,email)').order('audit_date', { ascending: false }).order('created_at', { ascending: false }).limit(1000),
        client.from('audit_activity_log').select('*').order('created_at', { ascending: false }).limit(100)
      ]);
      if (error) throw error;
      if (activityError && !String(activityError.message || '').includes('audit_activity_log')) throw activityError;
      state.history = audits || [];
      state.activityLog = activity || [];
      // Limpia selecciones que ya no existan o no sean visibles por RLS.
      state.historySelected = new Set([...state.historySelected].filter(id => state.history.some(a => a.id === id)));
      renderHistory();
      renderHistoryActivity();
    } catch (e) { console.error(e); }
    finally { loading(false); }
  }

  function getFilteredHistoryRows() {
    const from = el('historyFrom').value;
    const to = el('historyTo').value;
    const type = el('historyType').value;
    const status = el('historyStatus').value;
    const search = el('historySearch').value.trim().toLowerCase();
    return state.history.filter(a => {
      if (from && a.audit_date < from) return false;
      if (to && a.audit_date > to) return false;
      if (type && a.audit_type !== type) return false;
      if (status && a.status !== status) return false;
      if (search) {
        const haystack = [
          a.vehicle_plate, a.responsible_name, a.operators_text, a.vehicle_received_by,
          a.vehicle_workers_text, a.vehicle_final_control_by, a.staff_member_name_snapshot, a.auditor?.full_name, a.auditor?.email,
          auditTypeLabel(a.audit_type), auditIdentity(a)
        ].filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      return true;
    });
  }

  function renderHistory() {
    const rows = getFilteredHistoryRows();
    el('historyBody').innerHTML = rows.length ? rows.map(a => `<tr>
      <td><input class="form-check-input history-row-check" type="checkbox" ${state.historySelected.has(a.id) ? 'checked' : ''} onchange="CleanItApp.toggleHistorySelection('${a.id}', this.checked)" aria-label="Seleccionar auditoría"></td>
      <td>${fmtDate(a.audit_date)}</td>
      <td><span class="badge ${auditTypeBadgeClass(a.audit_type)}">${esc(auditTypeLabel(a.audit_type))}</span></td>
      <td class="fw-semibold">${esc(auditIdentity(a))}</td>
      <td><div class="small">${esc(auditPeopleSummary(a))}</div></td>
      <td>${esc(a.auditor?.full_name || a.auditor?.email || '—')}</td>
      <td>${a.status === 'completed' ? `<strong>${pct(a.score)}</strong>` : '—'}</td>
      <td><span class="badge ${a.status === 'completed' ? 'badge-soft-success' : 'badge-soft-neutral'}">${statusLabel(a.status)}</span></td>
      <td>${coverageBadge(a)}</td>
      <td>${a.classification ? `<span class="badge ${classificationClass(a.classification)}">${esc(a.classification)}</span>` : '—'}</td>
      <td class="text-end">
        <div class="d-inline-flex flex-wrap gap-1 justify-content-end">
          ${a.status === 'draft'
            ? `<button class="btn btn-sm btn-dark" onclick="CleanItApp.continueDraft('${a.id}')">Continuar</button>`
            : `<button class="btn btn-sm btn-outline-secondary" onclick="CleanItApp.openAudit('${a.id}')">Ver</button><button class="btn btn-sm btn-outline-dark" onclick="CleanItApp.editCompletedAudit('${a.id}')">Editar</button>`}
          <button class="btn btn-sm btn-outline-dark" onclick="CleanItApp.downloadPdf('${a.id}')">PDF</button>
          <button class="btn btn-sm btn-outline-danger" onclick="CleanItApp.openDeleteAuditModal('${a.id}')">Eliminar</button>
        </div>
      </td>
    </tr>`).join('') : `<tr><td colspan="11"><div class="empty-state">No hay auditorías para los filtros seleccionados.</div></td></tr>`;

    const allVisibleSelected = rows.length > 0 && rows.every(a => state.historySelected.has(a.id));
    const someVisibleSelected = rows.some(a => state.historySelected.has(a.id));
    const headerCheck = el('historySelectAllCheckbox');
    headerCheck.checked = allVisibleSelected;
    headerCheck.indeterminate = someVisibleSelected && !allVisibleSelected;
    const allPdfBtn = el('downloadAllAuditsBtn');
    allPdfBtn.disabled = state.history.length === 0;
    allPdfBtn.textContent = `PDF todas (${state.history.length})`;
    updateHistorySelectionBar();
  }

  function toggleHistorySelection(id, checked) {
    if (checked) state.historySelected.add(id);
    else state.historySelected.delete(id);
    renderHistory();
  }

  function selectAllVisibleHistory(checked = true) {
    const rows = getFilteredHistoryRows();
    rows.forEach(a => checked ? state.historySelected.add(a.id) : state.historySelected.delete(a.id));
    renderHistory();
  }

  function clearHistorySelection() {
    state.historySelected.clear();
    renderHistory();
  }

  function updateHistorySelectionBar() {
    const count = state.historySelected.size;
    el('selectedAuditCount').textContent = count;
    el('deleteSelectedAuditsBtn').disabled = count === 0;
    el('downloadSelectedAuditsBtn').disabled = count === 0;
    el('downloadSelectedAuditsBtn').textContent = count ? `PDF seleccionadas (${count})` : 'PDF seleccionadas';
    el('clearHistorySelectionBtn').disabled = count === 0;
  }

  function activityAuditLabel(log) {
    const snapshot = log.old_snapshot?.audit || log.new_snapshot?.audit || null;
    if (!snapshot) return `ID ${String(log.audit_id || '').slice(0, 8)}`;
    return `${auditTypeLabel(snapshot.audit_type)} · ${auditIdentity(snapshot)} · ${fmtDate(snapshot.audit_date)}`;
  }

  function renderHistoryActivity() {
    const body = el('historyActivityBody');
    if (!state.activityLog.length) {
      body.innerHTML = '<tr><td colspan="4"><div class="empty-state">Todavía no hay ediciones o eliminaciones registradas.</div></td></tr>';
      return;
    }
    body.innerHTML = state.activityLog.map(log => `<tr>
      <td>${fmtDateTime(log.created_at)}</td>
      <td><span class="badge ${log.action === 'deleted' ? 'badge-soft-danger' : 'badge-soft-warning'}">${log.action === 'deleted' ? 'Eliminada' : 'Editada'}</span></td>
      <td>${esc(activityAuditLabel(log))}</td>
      <td>${esc(log.actor_name || log.actor_email || 'Usuario')}</td>
    </tr>`).join('');
  }

  // ============================================================
  // DETAIL + PDF
  // ============================================================
  async function openAudit(id) {
    loading(true);
    try {
      const { data: audit, error } = await client.from('audits').select('*, auditor:profiles(full_name,email)').eq('id', id).single();
      if (error) throw error;
      const { data: responses, error: responseError } = await client.from('audit_responses').select('*').eq('audit_id', id).order('section_order_snapshot').order('item_order_snapshot');
      if (responseError) throw responseError;
      const { data: activity, error: activityError } = await client.from('audit_activity_log').select('*').eq('audit_id', id).order('created_at', { ascending: false });
      if (activityError && !String(activityError.message || '').includes('audit_activity_log')) throw activityError;
      setView('auditDetail', { load: false });
      renderAuditDetail(audit, responses, activity || []);
    } catch (e) { console.error(e); toast(e?.message || 'No se pudo abrir la auditoría.', 'danger'); }
    finally { loading(false); }
  }

  function auditOperationCard(audit) {
    if (audit.audit_type === 'vehicle') {
      return `<div class="mt-3"><strong>Patente:</strong> ${esc(audit.vehicle_plate || '—')}</div>
        <div class="mt-1"><strong>Recibió:</strong> ${esc(audit.vehicle_received_by || '—')}</div>
        <div class="mt-1"><strong>Trabajaron:</strong> ${esc(audit.vehicle_workers_text || '—')}</div>
        <div class="mt-1"><strong>Control final:</strong> ${esc(audit.vehicle_final_control_by || '—')}</div>`;
    }
    if (audit.audit_type === 'local') {
      return `<div class="mt-3"><strong>Responsable:</strong> ${esc(audit.responsible_name || '—')}</div><div class="mt-1"><strong>Operarios presentes:</strong> ${esc(audit.operators_text || '—')}</div>`;
    }
    if (audit.audit_type === 'personnel') {
      return `<div class="mt-3"><strong>Operario auditado:</strong> ${esc(audit.staff_member_name_snapshot || '—')}</div>`;
    }
    return `<div class="mt-3"><strong>Responsable:</strong> ${esc(audit.responsible_name || '—')}</div><div class="mt-1"><strong>Operarios:</strong> ${esc(audit.operators_text || '—')}</div><div class="mt-1"><strong>Patente:</strong> ${esc(audit.vehicle_plate || '—')}</div>`;
  }

  function renderAuditDetail(audit, responses, activity = []) {
    const groups = groupResponses(responses);
    const container = el('auditDetailContainer');
    const completed = audit.status === 'completed';
    const coverage = auditCoverage(audit, responses);
    container.innerHTML = `
      <div class="d-flex flex-wrap gap-2 justify-content-between align-items-start mb-4">
        <div>
          <button class="btn btn-link px-0 text-secondary text-decoration-none no-print" onclick="CleanItApp.goHistory()">← Volver al historial</button>
          <div class="mb-2"><span class="badge ${auditTypeBadgeClass(audit.audit_type)}">${esc(auditTypeLabel(audit.audit_type))}</span></div>
          <h1 class="h3 mb-1">${esc(auditIdentity(audit))}</h1>
          <div class="text-secondary">${fmtDate(audit.audit_date)} · ${esc(audit.auditor?.full_name || audit.auditor?.email || '—')}</div>
        </div>
        <div class="d-flex flex-wrap gap-2 no-print">
          ${completed
            ? `<button class="btn btn-outline-dark" onclick="CleanItApp.editCompletedAudit('${audit.id}')">Editar auditoría</button><button class="btn btn-dark" onclick="CleanItApp.downloadPdf('${audit.id}')">Descargar informe PDF</button>`
            : `<button class="btn btn-dark" onclick="CleanItApp.continueDraft('${audit.id}')">Continuar borrador</button><button class="btn btn-outline-dark" onclick="CleanItApp.downloadPdf('${audit.id}')">Descargar PDF</button>`}
          <button class="btn btn-outline-danger" onclick="CleanItApp.openDeleteAuditModal('${audit.id}')">Eliminar</button>
        </div>
      </div>

      ${completed && !coverage.complete ? `<div class="alert alert-warning border-warning mb-4"><strong>Auditoría finalizada incompleta.</strong> Quedaron <strong>${coverage.unanswered}</strong> ítem${coverage.unanswered === 1 ? '' : 's'} sin responder (${coverage.answered}/${coverage.total} respondidos). El puntaje y la clasificación se calculan únicamente sobre los ítems respondidos y aplicables.</div>` : ''}

      <div class="row g-3 mb-4">
        <div class="col-md-6 col-xl-3"><div class="audit-summary-card h-100"><div class="text-secondary small text-uppercase fw-bold">Puntaje</div><div class="score-big mt-2">${completed ? pct(audit.score) : '—'}</div><div class="mt-2">${audit.classification ? `<span class="badge ${classificationClass(audit.classification)}">${esc(audit.classification)}</span>` : '<span class="badge badge-soft-neutral">Borrador</span>'}</div></div></div>
        <div class="col-md-6 col-xl-3"><div class="audit-summary-card h-100"><div class="text-secondary small text-uppercase fw-bold">Cobertura del checklist</div><div class="score-big mt-2">${coverage.answered}/${coverage.total}</div><div class="mt-2">${coverageBadge(audit, responses)}</div></div></div>
        <div class="col-md-6 col-xl-3"><div class="audit-summary-card h-100"><div class="text-secondary small text-uppercase fw-bold">Control</div><div class="mt-3"><strong>${audit.compliant_items || 0}</strong> cumple · <strong>${audit.noncompliant_items || 0}</strong> no cumple</div><div class="mt-2"><strong>${audit.critical_failures || 0}</strong> fallas críticas</div></div></div>
        <div class="col-md-6 col-xl-3"><div class="audit-summary-card h-100"><div class="text-secondary small text-uppercase fw-bold">Trazabilidad operativa</div>${auditOperationCard(audit)}</div></div>
      </div>

      ${groups.map(group => `<section class="audit-section">
        <div class="audit-section-head"><h3 class="h6 mb-0">${esc(group.title)}</h3><div class="small text-secondary">${sectionScore(group.rows)}</div></div>
        ${group.rows.map(r => `<div class="audit-item">
          <div class="d-flex gap-3 align-items-start">
            <div class="audit-item-code">${esc(r.item_code_snapshot || '')}</div>
            <div class="flex-grow-1"><div class="d-flex flex-wrap gap-2"><span class="audit-item-title">${esc(r.item_title_snapshot)}</span>${r.is_critical_snapshot ? '<span class="critical-pill">Crítico</span>' : ''}</div><div class="audit-criterion">${esc(r.criterion_snapshot)}</div>${r.observation ? `<div class="mt-2 small"><strong>Observación:</strong> ${esc(r.observation)}</div>` : ''}</div>
            <div class="detail-answer ${answerTextClass(r.answer)}">${answerText(r.answer)}</div>
          </div>
        </div>`).join('')}
      </section>`).join('')}

      <div class="panel-card p-4 mt-3"><h3 class="h6">Observaciones generales</h3><div class="text-secondary">${esc(audit.general_notes || 'Sin observaciones generales.')}</div><div class="small text-secondary mt-3">Inicio: ${fmtDateTime(audit.started_at)}${audit.completed_at ? ` · Cierre original: ${fmtDateTime(audit.completed_at)}` : ''} · Última actualización: ${fmtDateTime(audit.updated_at)}</div></div>

      <div class="panel-card p-4 mt-3 mb-5">
        <h3 class="h6 mb-3">Trazabilidad de cambios</h3>
        ${activity.length ? `<div class="audit-timeline">${activity.map(log => `<div class="timeline-entry"><div class="timeline-dot"></div><div><div class="fw-semibold">${log.action === 'edited' ? 'Auditoría editada' : log.action === 'deleted' ? 'Auditoría eliminada' : esc(log.action)}</div><div class="small text-secondary">${fmtDateTime(log.created_at)} · ${esc(log.actor_name || log.actor_email || 'Usuario')}</div></div></div>`).join('')}</div>` : '<div class="text-secondary small">No hay ediciones posteriores registradas para esta auditoría.</div>'}
      </div>
    `;
    container.dataset.audit = JSON.stringify(audit);
    container.dataset.responses = JSON.stringify(responses);
  }

  function sectionScore(rows) {
    const answered = rows.filter(r => r.answer).length;
    const pending = rows.length - answered;
    const applicable = rows.filter(r => r.answer && r.answer !== 'na');
    const coverageText = `${answered}/${rows.length} respondidos${pending ? ` · ${pending} pendiente${pending === 1 ? '' : 's'}` : ''}`;
    if (!applicable.length) return `Sin puntaje · ${coverageText}`;
    const yes = applicable.filter(r => r.answer === 'complies').length;
    return `${(yes / applicable.length * 100).toFixed(1)}% · ${coverageText}`;
  }
  const answerText = a => a === 'complies' ? 'CUMPLE' : a === 'non_complies' ? 'NO CUMPLE' : a === 'na' ? 'N/A' : 'SIN RESPUESTA';
  const answerTextClass = a => a === 'complies' ? 'text-success' : a === 'non_complies' ? 'text-danger' : 'text-secondary';

  async function downloadPdf(id) {
    await downloadAuditsPdf([id], 'single');
  }

  async function fetchAuditsForPdf(ids) {
    const uniqueIds = [...new Set((ids || []).filter(Boolean))];
    if (!uniqueIds.length) return [];

    const chunkSize = 80;
    const audits = [];
    const responses = [];

    for (let i = 0; i < uniqueIds.length; i += chunkSize) {
      const chunk = uniqueIds.slice(i, i + chunkSize);
      const { data: auditRows, error: auditError } = await client
        .from('audits')
        .select('*, auditor:profiles(full_name,email)')
        .in('id', chunk);
      if (auditError) throw auditError;
      audits.push(...(auditRows || []));

      const { data: responseRows, error: responseError } = await client
        .from('audit_responses')
        .select('*')
        .in('audit_id', chunk);
      if (responseError) throw responseError;
      responses.push(...(responseRows || []));
    }

    const auditMap = new Map(audits.map(a => [a.id, a]));
    const responseMap = new Map();
    responses.forEach(r => {
      if (!responseMap.has(r.audit_id)) responseMap.set(r.audit_id, []);
      responseMap.get(r.audit_id).push(r);
    });

    return uniqueIds
      .map(id => auditMap.get(id))
      .filter(Boolean)
      .map(audit => ({
        audit,
        responses: (responseMap.get(audit.id) || []).sort((a,b) =>
          Number(a.section_order_snapshot || 0) - Number(b.section_order_snapshot || 0) ||
          Number(a.item_order_snapshot || 0) - Number(b.item_order_snapshot || 0)
        )
      }));
  }

  async function downloadAuditsPdf(ids, mode = 'selected') {
    const uniqueIds = [...new Set((ids || []).filter(Boolean))];
    if (!uniqueIds.length) {
      toast('No hay auditorías para descargar.', 'warning');
      return;
    }

    loading(true);
    try {
      const reports = await fetchAuditsForPdf(uniqueIds);
      if (!reports.length) {
        toast('No se encontraron auditorías accesibles para generar el PDF.', 'warning');
        return;
      }
      makeAuditsPdf(reports, mode);
      toast(`${reports.length} auditoría(s) incluidas en el PDF.`, 'success');
    } catch (e) {
      console.error(e);
      toast(e?.message || 'No se pudo generar el PDF.', 'danger');
    } finally {
      loading(false);
    }
  }

  function renderAuditIntoPdf(doc, audit, responses, reportIndex, totalReports, addNewPage) {
    if (addNewPage) doc.addPage();

    const margin = 14;
    const typeLabel = auditTypeLabel(audit.audit_type);
    const coverage = auditCoverage(audit, responses);
    const startPage = doc.getNumberOfPages();

    doc.setTextColor(0);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(18);
    doc.text('CLEAN IT', margin, 16);
    doc.setFontSize(13);
    doc.text(`Informe de Auditoría · ${typeLabel}`, margin, 24);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    if (totalReports > 1) doc.text(`Auditoría ${reportIndex + 1} de ${totalReports}`, 196, 16, { align: 'right' });
    doc.setFontSize(9);
    doc.text(`Fecha: ${fmtDate(audit.audit_date)}    Auditor: ${audit.auditor?.full_name || audit.auditor?.email || '—'}`, margin, 31);

    let yMeta = 36;
    if (audit.audit_type === 'vehicle') {
      doc.text(`Patente: ${audit.vehicle_plate || '—'}    Recibió: ${audit.vehicle_received_by || '—'}`, margin, yMeta); yMeta += 5;
      doc.text(`Trabajaron: ${audit.vehicle_workers_text || '—'}`, margin, yMeta); yMeta += 5;
      doc.text(`Control final: ${audit.vehicle_final_control_by || '—'}`, margin, yMeta); yMeta += 5;
    } else if (audit.audit_type === 'personnel') {
      doc.text(`Operario auditado: ${audit.staff_member_name_snapshot || '—'}`, margin, yMeta); yMeta += 5;
    } else {
      doc.text(`Responsable: ${audit.responsible_name || '—'}`, margin, yMeta); yMeta += 5;
      doc.text(`Operarios presentes: ${audit.operators_text || '—'}`, margin, yMeta); yMeta += 5;
      if (audit.audit_type === 'legacy' && audit.vehicle_plate) { doc.text(`Patente histórica: ${audit.vehicle_plate}`, margin, yMeta); yMeta += 5; }
    }

    doc.autoTable({
      startY: yMeta + 1,
      head: [['Puntaje', 'Resultado', 'Estado', 'Cobertura', 'Pendientes', 'Cumple', 'No cumple', 'Fallas críticas']],
      body: [[
        audit.status === 'completed' ? pct(audit.score) : '—',
        audit.classification || (audit.status === 'draft' ? 'Borrador' : '—'),
        statusLabel(audit.status),
        `${coverage.answered}/${coverage.total}`,
        coverage.unanswered,
        audit.compliant_items || 0,
        audit.noncompliant_items || 0,
        audit.critical_failures || 0
      ]],
      theme: 'grid',
      styles: { fontSize: 7.2, cellPadding: 1.7 },
      headStyles: { fillColor: [17, 24, 39] },
      margin: { left: margin, right: margin }
    });

    let cursorY = doc.lastAutoTable.finalY + 5;
    if (audit.status === 'completed' && !coverage.complete) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.text(`AUDITORÍA FINALIZADA INCOMPLETA: ${coverage.unanswered} ítem(s) sin responder.`, margin, cursorY);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.text('El puntaje se calcula únicamente sobre los ítems respondidos y aplicables.', margin, cursorY + 4);
      cursorY += 9;
    } else if (audit.status === 'draft') {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.text(`BORRADOR: ${coverage.unanswered} ítem(s) pendiente(s) de respuesta.`, margin, cursorY);
      doc.setFont('helvetica', 'normal');
      cursorY += 6;
    }

    const groups = groupResponses(responses);
    if (!groups.length) {
      doc.autoTable({
        startY: cursorY,
        head: [['Checklist']],
        body: [['Esta auditoría no tiene respuestas registradas.']],
        theme: 'grid',
        styles: { fontSize: 8 },
        headStyles: { fillColor: [17, 24, 39] },
        margin: { left: margin, right: margin }
      });
      cursorY = doc.lastAutoTable.finalY + 7;
    } else {
      groups.forEach(group => {
        doc.autoTable({
          startY: cursorY,
          head: [[group.title, 'Criterio / evidencia', 'Resultado']],
          body: group.rows.map(r => [
            `${r.item_code_snapshot || ''} ${r.item_title_snapshot}${r.is_critical_snapshot ? ' [CRÍTICO]' : ''}`,
            `${r.criterion_snapshot || ''}${r.observation ? `\nObs.: ${r.observation}` : ''}`,
            answerText(r.answer)
          ]),
          theme: 'grid',
          styles: { fontSize: 7.5, cellPadding: 2.2, overflow: 'linebreak' },
          headStyles: { fillColor: [17, 24, 39] },
          columnStyles: { 0: { cellWidth: 52 }, 1: { cellWidth: 103 }, 2: { cellWidth: 27 } },
          margin: { left: margin, right: margin },
          showHead: 'everyPage'
        });
        cursorY = doc.lastAutoTable.finalY + 7;
      });
    }

    doc.autoTable({
      startY: cursorY,
      head: [['Observaciones generales']],
      body: [[audit.general_notes || 'Sin observaciones generales.']],
      theme: 'grid',
      styles: { fontSize: 8, overflow: 'linebreak' },
      headStyles: { fillColor: [17, 24, 39] },
      margin: { left: margin, right: margin }
    });

    const endPage = doc.getNumberOfPages();
    return { audit, startPage, endPage, reportIndex, totalReports };
  }

  function makeAuditsPdf(reports, mode = 'selected') {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const pageRanges = [];

    reports.forEach((report, index) => {
      pageRanges.push(renderAuditIntoPdf(doc, report.audit, report.responses, index, reports.length, index > 0));
    });

    pageRanges.forEach(range => {
      const pageCount = range.endPage - range.startPage + 1;
      for (let page = range.startPage; page <= range.endPage; page++) {
        doc.setPage(page);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7);
        doc.setTextColor(110);
        const localPage = page - range.startPage + 1;
        const identity = auditIdentity(range.audit);
        doc.text(
          `Clean It · ${identity} · Auditoría ${range.reportIndex + 1}/${range.totalReports} · Página ${localPage}/${pageCount}`,
          14,
          292
        );
      }
    });

    doc.setTextColor(0);
    if (reports.length === 1) {
      const audit = reports[0].audit;
      const identity = audit.audit_type === 'vehicle'
        ? (audit.vehicle_plate || 'SIN-PATENTE')
        : audit.audit_type === 'personnel'
          ? (audit.staff_member_name_snapshot || 'OPERARIO')
          : audit.audit_type === 'local' ? 'LOCAL' : 'HISTORICA';
      const safeIdentity = String(identity).replace(/[^a-z0-9-]/gi, '_');
      doc.save(`Auditoria_CleanIt_${audit.audit_type || 'legacy'}_${fmtDate(audit.audit_date).replaceAll('/','-')}_${safeIdentity}.pdf`);
      return;
    }

    const fromDate = reports.map(r => r.audit.audit_date).filter(Boolean).sort()[0] || todayISO();
    const toDate = reports.map(r => r.audit.audit_date).filter(Boolean).sort().slice(-1)[0] || todayISO();
    const suffix = mode === 'all' ? 'Todas' : 'Seleccionadas';
    doc.save(`Auditorias_CleanIt_${suffix}_${reports.length}_${fromDate}_a_${toDate}.pdf`);
  }

  function makePdf(audit, responses) {
    makeAuditsPdf([{ audit, responses }], 'single');
  }

  // ============================================================
  // CHECKLIST ADMIN
  // ============================================================
  async function loadChecklistAdmin() {
    loading(true);
    try {
      const checklist = await fetchChecklist(false);
      const renderType = (type) => {
        const sections = checklist.filter(s => s.audit_type === type);
        const description = type === 'local' ? 'Secciones 1 a 3: estado general del local.' : type === 'personnel' ? 'Sección 4: evaluación individual de cada operario.' : 'Secciones 5 a 12: proceso y trazabilidad de cada vehículo.';
        return `<div class="audit-type-heading"><div><h2 class="h5 mb-1">${auditTypeLabel(type)}</h2><div class="small text-secondary">${description}</div></div><span class="type-pill">${sections.length} secciones</span></div>
          ${sections.length ? sections.map(s => `<section class="admin-section ${s.is_active ? '' : 'inactive-row'}">
            <div class="admin-section-head">
              <div><div class="d-flex gap-2 align-items-center"><strong>${esc(s.title)}</strong>${s.is_active ? '' : '<span class="badge badge-soft-neutral">Inactiva</span>'}</div><div class="small text-secondary">${esc(s.description || '')}</div></div>
              <div class="admin-actions"><button class="btn btn-sm btn-outline-secondary" onclick="CleanItApp.editSection('${s.id}')">Editar</button><button class="btn btn-sm btn-dark" onclick="CleanItApp.addItem('${s.id}')">+ Ítem</button><button class="btn btn-sm btn-outline-danger" onclick="CleanItApp.deleteSection('${s.id}')">Eliminar</button></div>
            </div>
            ${s.items.length ? s.items.map(i => `<div class="admin-item ${i.is_active ? '' : 'inactive-row'}">
              <div class="fw-bold text-secondary">${esc(i.code || '')}</div>
              <div><div class="d-flex flex-wrap gap-2 align-items-center"><strong>${esc(i.title)}</strong>${i.is_critical ? '<span class="critical-pill">Crítico</span>' : ''}${i.is_active ? '' : '<span class="badge badge-soft-neutral">Inactivo</span>'}</div><div class="small text-secondary mt-1">${esc(i.criterion)}</div></div>
              <div class="admin-actions"><button class="btn btn-sm btn-outline-secondary" onclick="CleanItApp.editItem('${i.id}')">Editar</button><button class="btn btn-sm btn-outline-danger" onclick="CleanItApp.deleteItem('${i.id}')">Eliminar</button></div>
            </div>`).join('') : '<div class="p-3 text-secondary small">Sin ítems.</div>'}
          </section>`).join('') : '<div class="panel-card p-4 text-secondary">No hay secciones para este tipo.</div>'}`;
      };
      el('checklistAdminContainer').innerHTML = renderType('local') + renderType('personnel') + renderType('vehicle');
      state.activeChecklist = checklist;
    } catch (e) { console.error(e); }
    finally { loading(false); }
  }

  function openSectionModal(section = null) {
    el('sectionModalTitle').textContent = section ? 'Editar sección' : 'Nueva sección';
    el('sectionId').value = section?.id || '';
    el('sectionAuditType').value = section?.audit_type || 'local';
    el('sectionTitle').value = section?.title || '';
    el('sectionDescription').value = section?.description || '';
    el('sectionOrder').value = section?.sort_order ?? 10;
    el('sectionActive').checked = section?.is_active ?? true;
    state.modals.section.show();
  }

  function editSection(id) {
    const section = state.activeChecklist.find(x => x.id === id);
    if (section) openSectionModal(section);
  }

  async function saveSection(ev) {
    ev.preventDefault();
    const id = el('sectionId').value;
    const payload = {
      audit_type: el('sectionAuditType').value,
      title: el('sectionTitle').value.trim(),
      description: el('sectionDescription').value.trim() || null,
      sort_order: Number(el('sectionOrder').value || 0),
      is_active: el('sectionActive').checked
    };
    loading(true);
    try {
      const query = id ? client.from('audit_sections').update(payload).eq('id', id) : client.from('audit_sections').insert(payload);
      const { error } = await query;
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
    for (const section of state.activeChecklist) {
      const item = section.items.find(x => x.id === id);
      if (item) return openItemModal(section.id, item);
    }
  }

  async function saveItem(ev) {
    ev.preventDefault();
    const id = el('itemId').value;
    const payload = {
      section_id: el('itemSectionId').value,
      code: el('itemCode').value.trim() || null,
      title: el('itemTitle').value.trim(),
      criterion: el('itemCriterion').value.trim(),
      sort_order: Number(el('itemOrder').value || 0),
      is_critical: el('itemCritical').checked,
      is_active: el('itemActive').checked
    };
    loading(true);
    try {
      const query = id ? client.from('audit_items').update(payload).eq('id', id) : client.from('audit_items').insert(payload);
      const { error } = await query;
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
  // STAFF ADMIN
  // ============================================================
  async function loadStaffAdmin() {
    loading(true);
    try {
      await loadStaffMembers(true);
      const body = el('staffBody');
      body.innerHTML = state.staffMembers.length ? state.staffMembers.map(staff => `<tr class="${staff.is_active ? '' : 'inactive-row'}">
        <td class="fw-semibold">${esc(staff.full_name)}</td>
        <td><span class="badge ${staff.is_active ? 'badge-soft-success' : 'badge-soft-neutral'}">${staff.is_active ? 'Activo' : 'Inactivo'}</span></td>
        <td>${fmtDate(staff.created_at)}</td>
        <td class="text-end"><div class="d-inline-flex gap-1"><button class="btn btn-sm btn-outline-secondary" onclick="CleanItApp.editStaffMember('${staff.id}')">Editar</button><button class="btn btn-sm ${staff.is_active ? 'btn-outline-danger' : 'btn-outline-success'}" onclick="CleanItApp.toggleStaffMember('${staff.id}', ${!staff.is_active})">${staff.is_active ? 'Desactivar' : 'Activar'}</button></div></td>
      </tr>`).join('') : '<tr><td colspan="4"><div class="empty-state">Todavía no hay operarios cargados.</div></td></tr>';
    } catch (e) { console.error(e); toast(e.message || 'No se pudieron cargar los operarios.', 'danger'); }
    finally { loading(false); }
  }

  async function addStaffMember(ev) {
    ev.preventDefault();
    const fullName = el('staffNewName').value.trim();
    if (!fullName) return;
    loading(true);
    try {
      const { error } = await client.from('staff_members').insert({ full_name: fullName, created_by: state.profile.id });
      if (error) throw error;
      el('staffNewName').value = '';
      toast('Operario agregado.', 'success');
      await loadStaffAdmin();
    } catch (e) { console.error(e); toast(e.message || 'No se pudo agregar el operario.', 'danger'); }
    finally { loading(false); }
  }

  async function editStaffMember(id) {
    const staff = state.staffMembers.find(x => x.id === id);
    if (!staff) return;
    const fullName = prompt('Nombre y apellido del operario:', staff.full_name);
    if (fullName === null) return;
    if (!fullName.trim()) return toast('El nombre no puede quedar vacío.', 'warning');
    const { error } = await client.from('staff_members').update({ full_name: fullName.trim() }).eq('id', id);
    if (error) return toast(error.message, 'danger');
    toast('Operario actualizado.', 'success');
    await loadStaffAdmin();
  }

  async function toggleStaffMember(id, isActive) {
    const { error } = await client.from('staff_members').update({ is_active: isActive }).eq('id', id);
    if (error) return toast(error.message, 'danger');
    toast(isActive ? 'Operario activado.' : 'Operario desactivado.', 'success');
    await loadStaffAdmin();
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
    editCompletedAudit,
    openDeleteAuditModal,
    openDeleteAuditsModal,
    toggleHistorySelection,
    downloadPdf,
    downloadAuditsPdf,
    downloadAnalysisPdf,
    downloadAnalysisXlsx,
    downloadAnalysisDocx,
    goHistory: () => setView('history'),
    editSection,
    addItem: (sectionId) => openItemModal(sectionId),
    editItem,
    deleteItem,
    deleteSection,
    editStaffMember,
    toggleStaffMember,
    changeRole
  };

  document.addEventListener('DOMContentLoaded', init);
})();
