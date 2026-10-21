-- ============================================================
-- Clean It Auditorías · Migración V3
-- Tipos de auditoría + trazabilidad de vehículo + eliminación múltiple
-- Ejecutar UNA VEZ en Supabase > SQL Editor sobre una instalación V2.
-- Es idempotente y puede volver a ejecutarse.
-- ============================================================

-- 1) Diferenciar las secciones del checklist.
alter table public.audit_sections
  add column if not exists audit_type text;

update public.audit_sections
set audit_type = case when sort_order <= 40 then 'local' else 'vehicle' end
where audit_type is null;

alter table public.audit_sections alter column audit_type set default 'local';
alter table public.audit_sections alter column audit_type set not null;

do $$ begin
  alter table public.audit_sections
    add constraint audit_sections_audit_type_check
    check (audit_type in ('local','vehicle'));
exception when duplicate_object then null;
end $$;

create index if not exists idx_audit_sections_audit_type
  on public.audit_sections(audit_type, sort_order);

-- 2) Diferenciar auditorías y agregar responsables específicos del vehículo.
alter table public.audits add column if not exists audit_type text;
alter table public.audits add column if not exists vehicle_received_by text;
alter table public.audits add column if not exists vehicle_workers_text text;
alter table public.audits add column if not exists vehicle_final_control_by text;

-- Las auditorías previas se mantienen explícitamente como formato histórico,
-- porque contienen las 12 secciones y no corresponde reinterpretarlas.
update public.audits
set audit_type = 'legacy'
where audit_type is null;

alter table public.audits alter column audit_type set default 'local';
alter table public.audits alter column audit_type set not null;

do $$ begin
  alter table public.audits
    add constraint audits_audit_type_check
    check (audit_type in ('local','vehicle','legacy'));
exception when duplicate_object then null;
end $$;

create index if not exists idx_audits_audit_type
  on public.audits(audit_type, audit_date desc);

-- 3) Edición registrada de auditorías finalizadas V3.
create or replace function public.update_completed_audit_v3(
  p_audit_id uuid,
  p_audit_date date,
  p_responsible_name text,
  p_operators_text text,
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
  v_response_count integer;
  v_payload_count integer;
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

  if not found then
    raise exception 'La auditoría no existe.';
  end if;

  if v_audit.status <> 'completed' then
    raise exception 'Solo se pueden editar auditorías finalizadas mediante esta función.';
  end if;

  if v_audit.auditor_id <> auth.uid() and not public.is_admin() then
    raise exception 'No tenés permisos para editar esta auditoría.';
  end if;

  if p_audit_date is null then
    raise exception 'La fecha de auditoría es obligatoria.';
  end if;

  if v_audit.audit_type = 'vehicle' then
    if nullif(btrim(coalesce(p_vehicle_plate,'')), '') is null then
      raise exception 'La patente es obligatoria para auditorías de vehículo.';
    end if;
    if nullif(btrim(coalesce(p_vehicle_received_by,'')), '') is null then
      raise exception 'Debe indicarse quién recibió el vehículo.';
    end if;
    if nullif(btrim(coalesce(p_vehicle_workers_text,'')), '') is null then
      raise exception 'Debe indicarse quiénes trabajaron sobre el vehículo.';
    end if;
    if nullif(btrim(coalesce(p_vehicle_final_control_by,'')), '') is null then
      raise exception 'Debe indicarse quién realizó el control final.';
    end if;
  end if;

  if p_responses is null or jsonb_typeof(p_responses) <> 'array' then
    raise exception 'Las respuestas enviadas no son válidas.';
  end if;

  select count(*) into v_response_count
  from public.audit_responses
  where audit_id = p_audit_id;

  v_payload_count := jsonb_array_length(p_responses);
  if v_payload_count <> v_response_count then
    raise exception 'La cantidad de respuestas no coincide con la auditoría.';
  end if;

  if (
    select count(distinct (value ->> 'id'))
    from jsonb_array_elements(p_responses)
  ) <> v_response_count then
    raise exception 'La lista de respuestas contiene IDs duplicados o incompletos.';
  end if;

  v_old_snapshot := jsonb_build_object(
    'audit', to_jsonb(v_audit),
    'responses', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.section_order_snapshot, r.item_order_snapshot)
      from public.audit_responses r
      where r.audit_id = p_audit_id
    ), '[]'::jsonb)
  );

  for v_item in select value from jsonb_array_elements(p_responses)
  loop
    if coalesce(v_item ->> 'answer', '') not in ('complies', 'non_complies', 'na') then
      raise exception 'Todas las respuestas deben ser Cumple, No cumple o N/A.';
    end if;

    update public.audit_responses
    set
      answer = (v_item ->> 'answer')::public.answer_status,
      observation = nullif(btrim(coalesce(v_item ->> 'observation', '')), '')
    where id = (v_item ->> 'id')::uuid
      and audit_id = p_audit_id;

    if not found then
      raise exception 'Se recibió una respuesta que no pertenece a la auditoría.';
    end if;
  end loop;

  if exists (
    select 1 from public.audit_responses
    where audit_id = p_audit_id and answer is null
  ) then
    raise exception 'La auditoría debe quedar completamente respondida.';
  end if;

  select
    count(*) filter (where answer <> 'na'),
    count(*) filter (where answer = 'complies'),
    count(*) filter (where answer = 'non_complies'),
    count(*) filter (where answer = 'non_complies' and is_critical_snapshot)
  into v_applicable, v_compliant, v_noncompliant, v_critical
  from public.audit_responses
  where audit_id = p_audit_id;

  v_score := case
    when v_applicable > 0 then round((v_compliant::numeric / v_applicable::numeric) * 100, 2)
    else 0
  end;

  v_classification := case
    when v_critical > 0 then 'No conforme'
    when v_score >= 95 then 'Conforme'
    when v_score >= 90 then 'Conforme con observaciones'
    else 'No conforme'
  end;

  update public.audits
  set
    audit_date = p_audit_date,
    responsible_name = case when v_audit.audit_type = 'vehicle' then null else nullif(btrim(coalesce(p_responsible_name, '')), '') end,
    operators_text = case when v_audit.audit_type = 'vehicle' then null else nullif(btrim(coalesce(p_operators_text, '')), '') end,
    vehicle_plate = case when v_audit.audit_type = 'local' then null else nullif(upper(btrim(coalesce(p_vehicle_plate, ''))), '') end,
    vehicle_received_by = case when v_audit.audit_type = 'vehicle' then nullif(btrim(coalesce(p_vehicle_received_by, '')), '') else null end,
    vehicle_workers_text = case when v_audit.audit_type = 'vehicle' then nullif(btrim(coalesce(p_vehicle_workers_text, '')), '') else null end,
    vehicle_final_control_by = case when v_audit.audit_type = 'vehicle' then nullif(btrim(coalesce(p_vehicle_final_control_by, '')), '') else null end,
    general_notes = nullif(btrim(coalesce(p_general_notes, '')), ''),
    score = v_score,
    classification = v_classification,
    critical_failures = v_critical,
    applicable_items = v_applicable,
    compliant_items = v_compliant,
    noncompliant_items = v_noncompliant
  where id = p_audit_id
  returning * into v_updated;

  v_new_snapshot := jsonb_build_object(
    'audit', to_jsonb(v_updated),
    'responses', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.section_order_snapshot, r.item_order_snapshot)
      from public.audit_responses r
      where r.audit_id = p_audit_id
    ), '[]'::jsonb)
  );

  select coalesce(full_name, email), email
  into v_actor_name, v_actor_email
  from public.profiles
  where id = auth.uid();

  insert into public.audit_activity_log (
    audit_id, audit_owner_id, actor_id, actor_name, actor_email,
    action, old_snapshot, new_snapshot
  ) values (
    p_audit_id, v_audit.auditor_id, auth.uid(), v_actor_name, v_actor_email,
    'edited', v_old_snapshot, v_new_snapshot
  );

  return true;
end;
$$;

revoke all on function public.update_completed_audit_v3(uuid,date,text,text,text,text,text,text,text,jsonb) from public;
grant execute on function public.update_completed_audit_v3(uuid,date,text,text,text,text,text,text,text,jsonb) to authenticated;

-- 4) Eliminación múltiple segura. Es atómica: si una auditoría no puede
--    eliminarse, no se elimina ninguna del lote.
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
  if auth.uid() is null then
    raise exception 'Sesión no válida.';
  end if;

  if p_confirmation <> 'ELIMINAR' then
    raise exception 'Confirmación de eliminación incorrecta.';
  end if;

  if p_audit_ids is null or coalesce(array_length(p_audit_ids, 1), 0) = 0 then
    raise exception 'No se seleccionaron auditorías.';
  end if;

  if array_length(p_audit_ids, 1) > 1000 then
    raise exception 'No se pueden eliminar más de 1000 auditorías por operación.';
  end if;

  select coalesce(full_name, email), email
  into v_actor_name, v_actor_email
  from public.profiles
  where id = auth.uid();

  foreach v_id in array p_audit_ids
  loop
    select * into v_audit
    from public.audits
    where id = v_id
    for update;

    if not found then
      raise exception 'La auditoría % no existe.', v_id;
    end if;

    if v_audit.auditor_id <> auth.uid() and not public.is_admin() then
      raise exception 'No tenés permisos para eliminar la auditoría %.', v_id;
    end if;

    -- Se guarda metadata suficiente para saber qué se eliminó, pero no las
    -- respuestas completas. Esto permite trazabilidad sin mantener el registro operativo.
    insert into public.audit_activity_log (
      audit_id, audit_owner_id, actor_id, actor_name, actor_email,
      action, old_snapshot, new_snapshot
    ) values (
      v_id, v_audit.auditor_id, auth.uid(), v_actor_name, v_actor_email,
      'deleted', jsonb_build_object('audit', to_jsonb(v_audit)), null
    );

    delete from public.audits where id = v_id;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.delete_audits_secure(uuid[],text) from public;
grant execute on function public.delete_audits_secure(uuid[],text) to authenticated;

-- Compatibilidad con la eliminación individual de V2.
create or replace function public.delete_audit_secure(
  p_audit_id uuid,
  p_confirmation text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.delete_audits_secure(array[p_audit_id], p_confirmation);
  return true;
end;
$$;

revoke all on function public.delete_audit_secure(uuid,text) from public;
grant execute on function public.delete_audit_secure(uuid,text) to authenticated;
