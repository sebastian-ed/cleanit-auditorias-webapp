-- ============================================================
-- Clean It Auditorías · Migración V4
-- Corrección de eliminación + auditorías finalizadas incompletas
-- Ejecutar en Supabase > SQL Editor sobre la instalación actual.
-- Es idempotente: puede volver a ejecutarse.
-- ============================================================

-- 1) Asegurar la bitácora de trazabilidad.
-- audit_id no tiene FK deliberadamente para conservar evidencia de una
-- eliminación aun cuando la auditoría operativa ya no exista.
create table if not exists public.audit_activity_log (
  id uuid primary key default gen_random_uuid(),
  audit_id uuid not null,
  audit_owner_id uuid,
  actor_id uuid references public.profiles(id) on delete set null,
  actor_name text,
  actor_email text,
  action text not null check (action in ('edited', 'deleted')),
  old_snapshot jsonb,
  new_snapshot jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_audit_activity_log_audit_id
  on public.audit_activity_log(audit_id, created_at desc);
create index if not exists idx_audit_activity_log_owner_id
  on public.audit_activity_log(audit_owner_id, created_at desc);

alter table public.audit_activity_log enable row level security;

drop policy if exists "audit_activity_select" on public.audit_activity_log;
create policy "audit_activity_select" on public.audit_activity_log
for select to authenticated
using (
  public.is_admin()
  or audit_owner_id = auth.uid()
  or actor_id = auth.uid()
);

grant select on public.audit_activity_log to authenticated;
revoke insert, update, delete on public.audit_activity_log from authenticated;

-- 2) Métricas de cobertura del checklist.
alter table public.audits add column if not exists total_items integer not null default 0;
alter table public.audits add column if not exists answered_items integer not null default 0;
alter table public.audits add column if not exists unanswered_items integer not null default 0;
alter table public.audits add column if not exists is_complete boolean not null default false;

-- Backfill para auditorías existentes.
with coverage as (
  select
    audit_id,
    count(*)::integer as total_items,
    count(*) filter (where answer is not null)::integer as answered_items,
    count(*) filter (where answer is null)::integer as unanswered_items
  from public.audit_responses
  group by audit_id
)
update public.audits a
set
  total_items = c.total_items,
  answered_items = c.answered_items,
  unanswered_items = c.unanswered_items,
  is_complete = (c.total_items > 0 and c.unanswered_items = 0)
from coverage c
where a.id = c.audit_id;

-- 3) Evitar eliminación directa: toda eliminación debe pasar por el RPC seguro.
drop policy if exists "audits_delete_draft" on public.audits;
revoke delete on public.audits from authenticated;
revoke delete on public.audit_responses from authenticated;

-- 4) Edición de auditorías finalizadas permitiendo ítems sin responder.
create or replace function public.update_completed_audit_v4(
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

  -- La trazabilidad operativa del vehículo sigue siendo obligatoria. Lo que
  -- puede quedar incompleto son los ítems del checklist.
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
    v_answer := nullif(btrim(coalesce(v_item ->> 'answer', '')), '');

    if v_answer is not null and v_answer not in ('complies', 'non_complies', 'na') then
      raise exception 'Las respuestas válidas son Cumple, No cumple, N/A o Sin responder.';
    end if;

    update public.audit_responses
    set
      answer = case when v_answer is null then null else v_answer::public.answer_status end,
      observation = nullif(btrim(coalesce(v_item ->> 'observation', '')), '')
    where id = (v_item ->> 'id')::uuid
      and audit_id = p_audit_id;

    if not found then
      raise exception 'Se recibió una respuesta que no pertenece a la auditoría.';
    end if;
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
  from public.audit_responses
  where audit_id = p_audit_id;

  v_score := case
    when v_applicable > 0 then round((v_compliant::numeric / v_applicable::numeric) * 100, 2)
    else null
  end;

  v_classification := case
    when v_applicable = 0 then 'Sin evaluación'
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
    noncompliant_items = v_noncompliant,
    total_items = v_total,
    answered_items = v_answered,
    unanswered_items = v_unanswered,
    is_complete = (v_total > 0 and v_unanswered = 0)
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

revoke all on function public.update_completed_audit_v4(uuid,date,text,text,text,text,text,text,text,jsonb) from public;
grant execute on function public.update_completed_audit_v4(uuid,date,text,text,text,text,text,text,text,jsonb) to authenticated;

-- 5) Eliminación múltiple segura y registrada.
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

    insert into public.audit_activity_log (
      audit_id, audit_owner_id, actor_id, actor_name, actor_email,
      action, old_snapshot, new_snapshot
    ) values (
      v_id, v_audit.auditor_id, auth.uid(), v_actor_name, v_actor_email,
      'deleted', jsonb_build_object(
        'audit', jsonb_build_object(
          'id', v_audit.id,
          'audit_date', v_audit.audit_date,
          'audit_type', v_audit.audit_type,
          'vehicle_plate', v_audit.vehicle_plate,
          'responsible_name', v_audit.responsible_name,
          'auditor_id', v_audit.auditor_id,
          'status', v_audit.status,
          'score', v_audit.score,
          'classification', v_audit.classification,
          'is_complete', v_audit.is_complete,
          'unanswered_items', v_audit.unanswered_items
        )
      ),
      null
    );

    delete from public.audits where id = v_id;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.delete_audits_secure(uuid[],text) from public;
grant execute on function public.delete_audits_secure(uuid[],text) to authenticated;

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
