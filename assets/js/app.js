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
    staffMembers: [],
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
          <button class="btn btn-sm btn-outline-danger" onclick="CleanItApp.openDeleteAuditModal('${a.id}')">Eliminar</button>
        </div>
      </td>
    </tr>`).join('') : `<tr><td colspan="11"><div class="empty-state">No hay auditorías para los filtros seleccionados.</div></td></tr>`;

    const allVisibleSelected = rows.length > 0 && rows.every(a => state.historySelected.has(a.id));
    const someVisibleSelected = rows.some(a => state.historySelected.has(a.id));
    const headerCheck = el('historySelectAllCheckbox');
    headerCheck.checked = allVisibleSelected;
    headerCheck.indeterminate = someVisibleSelected && !allVisibleSelected;
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
            : `<button class="btn btn-dark" onclick="CleanItApp.continueDraft('${audit.id}')">Continuar borrador</button>`}
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
    loading(true);
    try {
      const { data: audit, error } = await client.from('audits').select('*, auditor:profiles(full_name,email)').eq('id', id).single();
      if (error) throw error;
      const { data: responses, error: responseError } = await client.from('audit_responses').select('*').eq('audit_id', id).order('section_order_snapshot').order('item_order_snapshot');
      if (responseError) throw responseError;
      makePdf(audit, responses);
    } catch (e) { console.error(e); }
    finally { loading(false); }
  }

  function makePdf(audit, responses) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const margin = 14;
    const typeLabel = auditTypeLabel(audit.audit_type);
    const coverage = auditCoverage(audit, responses);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(18); doc.text('CLEAN IT', margin, 16);
    doc.setFontSize(13); doc.text(`Informe de Auditoría · ${typeLabel}`, margin, 24);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
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
      head: [['Puntaje', 'Resultado', 'Cobertura', 'Pendientes', 'Cumple', 'No cumple', 'Fallas críticas']],
      body: [[pct(audit.score), audit.classification || '—', `${coverage.answered}/${coverage.total}`, coverage.unanswered, audit.compliant_items || 0, audit.noncompliant_items || 0, audit.critical_failures || 0]],
      theme: 'grid', styles: { fontSize: 8 }, headStyles: { fillColor: [17, 24, 39] }
    });

    if (audit.status === 'completed' && !coverage.complete) {
      const warningY = doc.lastAutoTable.finalY + 5;
      doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
      doc.text(`AUDITORÍA FINALIZADA INCOMPLETA: ${coverage.unanswered} ítem(s) sin responder.`, margin, warningY);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
      doc.text('El puntaje se calcula únicamente sobre los ítems respondidos y aplicables.', margin, warningY + 4);
      doc.lastAutoTable.finalY = warningY + 5;
    }

    groupResponses(responses).forEach(group => {
      const startY = doc.lastAutoTable ? doc.lastAutoTable.finalY + 7 : yMeta + 10;
      doc.autoTable({
        startY,
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

    const notesY = doc.lastAutoTable ? doc.lastAutoTable.finalY + 7 : yMeta + 20;
    doc.autoTable({
      startY: notesY,
      head: [['Observaciones generales']],
      body: [[audit.general_notes || 'Sin observaciones generales.']],
      theme: 'grid', styles: { fontSize: 8 }, headStyles: { fillColor: [17, 24, 39] }, margin: { left: margin, right: margin }
    });

    const pages = doc.getNumberOfPages();
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i); doc.setFontSize(7); doc.setTextColor(110);
      doc.text(`Clean It · Auditoría ${audit.id.slice(0,8)} · Página ${i}/${pages}`, margin, 292);
    }
    const identity = audit.audit_type === 'vehicle' ? (audit.vehicle_plate || 'SIN-PATENTE') : audit.audit_type === 'personnel' ? (audit.staff_member_name_snapshot || 'OPERARIO') : audit.audit_type === 'local' ? 'LOCAL' : 'HISTORICA';
    const safeIdentity = identity.replace(/[^a-z0-9-]/gi, '_');
    doc.save(`Auditoria_CleanIt_${audit.audit_type || 'legacy'}_${fmtDate(audit.audit_date).replaceAll('/','-')}_${safeIdentity}.pdf`);
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
