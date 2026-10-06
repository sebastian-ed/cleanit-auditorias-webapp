-- ============================================================
-- Clean It Auditorías · Migración V2
-- Edición de auditorías finalizadas + eliminación segura
-- Ejecutar UNA VEZ en Supabase > SQL Editor sobre una instalación existente.
-- Es idempotente: puede volver a ejecutarse sin duplicar estructura.
-- ============================================================

-- 1) Bitácora de trazabilidad. audit_id no tiene FK deliberadamente:
--    si la auditoría se elimina, la constancia de eliminación permanece.
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

-- 2) La eliminación directa queda anulada. Toda eliminación pasa por el RPC
--    delete_audit_secure, que exige la palabra ELIMINAR y deja bitácora.
drop policy if exists "audits_delete_draft" on public.audits;
revoke delete on public.audits from authenticated;
revoke delete on public.audit_responses from authenticated;

-- 3) Editar una auditoría finalizada de forma atómica.
--    El auditor puede editar las propias; Admin puede editar cualquiera.
create or replace function public.update_completed_audit(
  p_audit_id uuid,
  p_audit_date date,
  p_responsible_name text,
  p_operators_text text,
  p_vehicle_plate text,
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
    responsible_name = nullif(btrim(coalesce(p_responsible_name, '')), ''),
    operators_text = nullif(btrim(coalesce(p_operators_text, '')), ''),
    vehicle_plate = nullif(upper(btrim(coalesce(p_vehicle_plate, ''))), ''),
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

revoke all on function public.update_completed_audit(uuid,date,text,text,text,text,jsonb) from public;
grant execute on function public.update_completed_audit(uuid,date,text,text,text,text,jsonb) to authenticated;

-- 4) Eliminación segura y atómica.
create or replace function public.delete_audit_secure(
  p_audit_id uuid,
  p_confirmation text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_audit public.audits%rowtype;
  v_snapshot jsonb;
  v_actor_name text;
  v_actor_email text;
begin
  if auth.uid() is null then
    raise exception 'Sesión no válida.';
  end if;

  if p_confirmation <> 'ELIMINAR' then
    raise exception 'Confirmación de eliminación incorrecta.';
  end if;

  select * into v_audit
  from public.audits
  where id = p_audit_id
  for update;

  if not found then
    raise exception 'La auditoría no existe.';
  end if;

  if v_audit.auditor_id <> auth.uid() and not public.is_admin() then
    raise exception 'No tenés permisos para eliminar esta auditoría.';
  end if;

  -- La eliminación es definitiva: no se conserva el contenido de la auditoría
  -- ni sus respuestas. La bitácora guarda sólo el hecho de que existió una
  -- eliminación, quién la ejecutó y cuándo.
  v_snapshot := null;

  select coalesce(full_name, email), email
  into v_actor_name, v_actor_email
  from public.profiles
  where id = auth.uid();

  insert into public.audit_activity_log (
    audit_id, audit_owner_id, actor_id, actor_name, actor_email,
    action, old_snapshot, new_snapshot
  ) values (
    p_audit_id, v_audit.auditor_id, auth.uid(), v_actor_name, v_actor_email,
    'deleted', v_snapshot, null
  );

  delete from public.audits where id = p_audit_id;
  return true;
end;
$$;

revoke all on function public.delete_audit_secure(uuid,text) from public;
grant execute on function public.delete_audit_secure(uuid,text) to authenticated;
