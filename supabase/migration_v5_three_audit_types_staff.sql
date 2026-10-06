-- ============================================================
-- Clean It Auditorías · Migración V5
-- 3 tipos de auditoría + maestro de operarios
-- Ejecutar UNA VEZ después de migration_v4_incomplete_and_delete_fix.sql
-- Es idempotente y puede volver a ejecutarse.
-- ============================================================

-- 1) Maestro de operarios.
create table if not exists public.staff_members (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  is_active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists staff_members_full_name_unique_ci
  on public.staff_members (lower(btrim(full_name)));

create index if not exists idx_staff_members_active_name
  on public.staff_members(is_active, full_name);

drop trigger if exists trg_staff_members_updated_at on public.staff_members;
create trigger trg_staff_members_updated_at before update on public.staff_members
for each row execute function public.set_updated_at();

alter table public.staff_members enable row level security;

DROP POLICY IF EXISTS "staff_select" ON public.staff_members;
create policy "staff_select" on public.staff_members
for select to authenticated using (true);

DROP POLICY IF EXISTS "staff_admin_insert" ON public.staff_members;
create policy "staff_admin_insert" on public.staff_members
for insert to authenticated with check (public.is_admin());

DROP POLICY IF EXISTS "staff_admin_update" ON public.staff_members;
create policy "staff_admin_update" on public.staff_members
for update to authenticated using (public.is_admin()) with check (public.is_admin());

DROP POLICY IF EXISTS "staff_admin_delete" ON public.staff_members;
create policy "staff_admin_delete" on public.staff_members
for delete to authenticated using (public.is_admin());

grant select on public.staff_members to authenticated;
grant insert, update, delete on public.staff_members to authenticated;

-- Recuperar nombres ya utilizados en auditorías del local para no empezar el maestro vacío.
insert into public.staff_members(full_name)
select distinct btrim(name_part)
from public.audits a,
lateral regexp_split_to_table(coalesce(a.operators_text,''), ',') as parts(name_part)
where btrim(name_part) <> ''
on conflict do nothing;

-- 2) Nuevo tipo "personnel" y movimiento de la sección 4.
alter table public.audit_sections drop constraint if exists audit_sections_audit_type_check;
alter table public.audit_sections
  add constraint audit_sections_audit_type_check
  check (audit_type in ('local','personnel','vehicle'));

-- La sección 4 pasa a ser una auditoría propia e individual por operario.
update public.audit_sections
set audit_type = 'personnel'
where sort_order = 40
   or lower(title) like '4.%presentaci%n del personal%'
   or lower(title) like '%presentaci%n del personal%';

alter table public.audits drop constraint if exists audits_audit_type_check;
alter table public.audits
  add constraint audits_audit_type_check
  check (audit_type in ('local','personnel','vehicle','legacy'));

-- 3) Metadatos de operarios.
alter table public.audits add column if not exists present_staff_ids uuid[] not null default '{}'::uuid[];
alter table public.audits add column if not exists staff_member_id uuid references public.staff_members(id) on delete set null;
alter table public.audits add column if not exists staff_member_name_snapshot text;

create index if not exists idx_audits_staff_member_id on public.audits(staff_member_id);

-- Vincular IDs en auditorías locales cuando el nombre coincide con el maestro.
update public.audits a
set present_staff_ids = coalesce((
  select array_agg(sm.id order by sm.full_name)
  from public.staff_members sm
  where lower(btrim(sm.full_name)) in (
    select lower(btrim(x))
    from regexp_split_to_table(coalesce(a.operators_text,''), ',') as parts(x)
    where btrim(x) <> ''
  )
), '{}'::uuid[])
where a.audit_type = 'local'
  and coalesce(array_length(a.present_staff_ids, 1), 0) = 0;

-- 4) Edición segura de auditorías finalizadas con los nuevos metadatos.
create or replace function public.update_completed_audit_v5(
  p_audit_id uuid,
  p_audit_date date,
  p_responsible_name text,
  p_operators_text text,
  p_present_staff_ids uuid[],
  p_staff_member_id uuid,
  p_staff_member_name_snapshot text,
  p_vehicle_plate text,
  p_vehicle_received_by text,
  p_vehicle_workers_text text,
  p_vehicle_final_control_by text,
  p_general_notes text,
  p_responses jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_audit public.audits%rowtype;
  v_updated public.audits%rowtype;
  v_old_snapshot jsonb;
  v_new_snapshot jsonb;
  v_item jsonb;
  v_answer text;
  v_response_count integer;
  v_payload_count integer;
  v_total integer;
  v_answered integer;
  v_unanswered integer;
  v_applicable integer;
  v_compliant integer;
  v_noncompliant integer;
  v_critical integer;
  v_score numeric(5,2);
  v_classification text;
  v_actor_name text;
  v_actor_email text;
begin
  if auth.uid() is null then
    raise exception 'Sesión no válida.';
  end if;

  select * into v_audit
  from public.audits
  where id = p_audit_id
  for update;

  if not found then raise exception 'La auditoría no existe.'; end if;
  if v_audit.status <> 'completed' then raise exception 'Solo se pueden editar auditorías finalizadas mediante esta función.'; end if;
  if v_audit.auditor_id <> auth.uid() and not public.is_admin() then raise exception 'No tenés permisos para editar esta auditoría.'; end if;
  if p_audit_date is null then raise exception 'La fecha de auditoría es obligatoria.'; end if;

  if v_audit.audit_type = 'local' then
    if nullif(btrim(coalesce(p_operators_text,'')), '') is null then
      raise exception 'Debe indicarse al menos un operario presente.';
    end if;
  end if;

  if v_audit.audit_type = 'personnel' then
    if p_staff_member_id is null or nullif(btrim(coalesce(p_staff_member_name_snapshot,'')), '') is null then
      raise exception 'Debe indicarse el operario auditado.';
    end if;
  end if;

  if v_audit.audit_type = 'vehicle' then
    if nullif(btrim(coalesce(p_vehicle_plate,'')), '') is null then raise exception 'La patente es obligatoria para auditorías de vehículo.'; end if;
    if nullif(btrim(coalesce(p_vehicle_received_by,'')), '') is null then raise exception 'Debe indicarse quién recibió el vehículo.'; end if;
    if nullif(btrim(coalesce(p_vehicle_workers_text,'')), '') is null then raise exception 'Debe indicarse quiénes trabajaron sobre el vehículo.'; end if;
    if nullif(btrim(coalesce(p_vehicle_final_control_by,'')), '') is null then raise exception 'Debe indicarse quién realizó el control final.'; end if;
  end if;

  if p_responses is null or jsonb_typeof(p_responses) <> 'array' then
    raise exception 'Las respuestas enviadas no son válidas.';
  end if;

  select count(*) into v_response_count from public.audit_responses where audit_id = p_audit_id;
  v_payload_count := jsonb_array_length(p_responses);
  if v_payload_count <> v_response_count then raise exception 'La cantidad de respuestas no coincide con la auditoría.'; end if;

  if (select count(distinct (value ->> 'id')) from jsonb_array_elements(p_responses)) <> v_response_count then
    raise exception 'La lista de respuestas contiene IDs duplicados o incompletos.';
  end if;

  v_old_snapshot := jsonb_build_object(
    'audit', to_jsonb(v_audit),
    'responses', coalesce((select jsonb_agg(to_jsonb(r) order by r.section_order_snapshot, r.item_order_snapshot) from public.audit_responses r where r.audit_id = p_audit_id), '[]'::jsonb)
  );

  for v_item in select value from jsonb_array_elements(p_responses)
  loop
    v_answer := nullif(btrim(coalesce(v_item ->> 'answer', '')), '');
    if v_answer is not null and v_answer not in ('complies', 'non_complies', 'na') then
      raise exception 'Las respuestas válidas son Cumple, No cumple, N/A o Sin responder.';
    end if;
    update public.audit_responses
    set answer = case when v_answer is null then null else v_answer::public.answer_status end,
        observation = nullif(btrim(coalesce(v_item ->> 'observation', '')), '')
    where id = (v_item ->> 'id')::uuid and audit_id = p_audit_id;
    if not found then raise exception 'Se recibió una respuesta que no pertenece a la auditoría.'; end if;
  end loop;

  select
    count(*)::integer,
    count(*) filter (where answer is not null)::integer,
    count(*) filter (where answer is null)::integer,
    count(*) filter (where answer is not null and answer <> 'na')::integer,
    count(*) filter (where answer = 'complies')::integer,
    count(*) filter (where answer = 'non_complies')::integer,
    count(*) filter (where answer = 'non_complies' and is_critical_snapshot)::integer
  into v_total, v_answered, v_unanswered, v_applicable, v_compliant, v_noncompliant, v_critical
  from public.audit_responses where audit_id = p_audit_id;

  v_score := case when v_applicable > 0 then round((v_compliant::numeric / v_applicable::numeric) * 100, 2) else null end;
  v_classification := case
    when v_applicable = 0 then 'Sin evaluación'
    when v_critical > 0 then 'No conforme'
    when v_score >= 95 then 'Conforme'
    when v_score >= 90 then 'Conforme con observaciones'
    else 'No conforme'
  end;

  update public.audits
  set audit_date = p_audit_date,
      responsible_name = case when v_audit.audit_type = 'local' then nullif(btrim(coalesce(p_responsible_name,'')), '') when v_audit.audit_type = 'legacy' then v_audit.responsible_name else null end,
      operators_text = case when v_audit.audit_type = 'local' then nullif(btrim(coalesce(p_operators_text,'')), '') when v_audit.audit_type = 'legacy' then v_audit.operators_text else null end,
      present_staff_ids = case when v_audit.audit_type = 'local' then coalesce(p_present_staff_ids, '{}'::uuid[]) when v_audit.audit_type = 'legacy' then v_audit.present_staff_ids else '{}'::uuid[] end,
      staff_member_id = case when v_audit.audit_type = 'personnel' then p_staff_member_id when v_audit.audit_type = 'legacy' then v_audit.staff_member_id else null end,
      staff_member_name_snapshot = case when v_audit.audit_type = 'personnel' then nullif(btrim(coalesce(p_staff_member_name_snapshot,'')), '') when v_audit.audit_type = 'legacy' then v_audit.staff_member_name_snapshot else null end,
      vehicle_plate = case when v_audit.audit_type = 'vehicle' then nullif(upper(btrim(coalesce(p_vehicle_plate,''))), '') when v_audit.audit_type = 'legacy' then v_audit.vehicle_plate else null end,
      vehicle_received_by = case when v_audit.audit_type = 'vehicle' then nullif(btrim(coalesce(p_vehicle_received_by,'')), '') when v_audit.audit_type = 'legacy' then v_audit.vehicle_received_by else null end,
      vehicle_workers_text = case when v_audit.audit_type = 'vehicle' then nullif(btrim(coalesce(p_vehicle_workers_text,'')), '') when v_audit.audit_type = 'legacy' then v_audit.vehicle_workers_text else null end,
      vehicle_final_control_by = case when v_audit.audit_type = 'vehicle' then nullif(btrim(coalesce(p_vehicle_final_control_by,'')), '') when v_audit.audit_type = 'legacy' then v_audit.vehicle_final_control_by else null end,
      general_notes = nullif(btrim(coalesce(p_general_notes,'')), ''),
      score = v_score,
      classification = v_classification,
      critical_failures = v_critical,
      applicable_items = v_applicable,
      compliant_items = v_compliant,
      noncompliant_items = v_noncompliant,
      total_items = v_total,
      answered_items = v_answered,
      unanswered_items = v_unanswered,
      is_complete = (v_total > 0 and v_unanswered = 0)
  where id = p_audit_id
  returning * into v_updated;

  v_new_snapshot := jsonb_build_object(
    'audit', to_jsonb(v_updated),
    'responses', coalesce((select jsonb_agg(to_jsonb(r) order by r.section_order_snapshot, r.item_order_snapshot) from public.audit_responses r where r.audit_id = p_audit_id), '[]'::jsonb)
  );

  select coalesce(full_name, email), email into v_actor_name, v_actor_email from public.profiles where id = auth.uid();
  insert into public.audit_activity_log(audit_id, audit_owner_id, actor_id, actor_name, actor_email, action, old_snapshot, new_snapshot)
  values (p_audit_id, v_audit.auditor_id, auth.uid(), v_actor_name, v_actor_email, 'edited', v_old_snapshot, v_new_snapshot);

  return true;
end;
$$;

revoke all on function public.update_completed_audit_v5(uuid,date,text,text,uuid[],uuid,text,text,text,text,text,text,jsonb) from public;
grant execute on function public.update_completed_audit_v5(uuid,date,text,text,uuid[],uuid,text,text,text,text,text,text,jsonb) to authenticated;

-- 5) Mejorar el snapshot de eliminación con identidad de operario (sin cambiar la firma usada por la app).
create or replace function public.delete_audits_secure(
  p_audit_ids uuid[],
  p_confirmation text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_audit public.audits%rowtype;
  v_actor_name text;
  v_actor_email text;
  v_count integer := 0;
begin
  if auth.uid() is null then raise exception 'Sesión no válida.'; end if;
  if p_confirmation <> 'ELIMINAR' then raise exception 'Confirmación de eliminación incorrecta.'; end if;
  if p_audit_ids is null or coalesce(array_length(p_audit_ids, 1), 0) = 0 then raise exception 'No se seleccionaron auditorías.'; end if;
  if array_length(p_audit_ids, 1) > 1000 then raise exception 'No se pueden eliminar más de 1000 auditorías por operación.'; end if;

  select coalesce(full_name, email), email into v_actor_name, v_actor_email from public.profiles where id = auth.uid();

  foreach v_id in array p_audit_ids
  loop
    select * into v_audit from public.audits where id = v_id for update;
    if not found then raise exception 'La auditoría % no existe.', v_id; end if;
    if v_audit.auditor_id <> auth.uid() and not public.is_admin() then raise exception 'No tenés permisos para eliminar la auditoría %.', v_id; end if;

    insert into public.audit_activity_log(audit_id, audit_owner_id, actor_id, actor_name, actor_email, action, old_snapshot, new_snapshot)
    values (
      v_id, v_audit.auditor_id, auth.uid(), v_actor_name, v_actor_email, 'deleted',
      jsonb_build_object('audit', jsonb_build_object(
        'id', v_audit.id,
        'audit_date', v_audit.audit_date,
        'audit_type', v_audit.audit_type,
        'vehicle_plate', v_audit.vehicle_plate,
        'responsible_name', v_audit.responsible_name,
        'operators_text', v_audit.operators_text,
        'staff_member_name_snapshot', v_audit.staff_member_name_snapshot,
        'auditor_id', v_audit.auditor_id,
        'status', v_audit.status,
        'score', v_audit.score,
        'classification', v_audit.classification,
        'is_complete', v_audit.is_complete,
        'unanswered_items', v_audit.unanswered_items
      )), null
    );

    delete from public.audits where id = v_id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.delete_audits_secure(uuid[],text) from public;
grant execute on function public.delete_audits_secure(uuid[],text) to authenticated;
