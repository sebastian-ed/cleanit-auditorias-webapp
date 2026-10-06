-- Clean It | Auditorías Operativas Naón
-- Ejecutar completo en Supabase > SQL Editor.
-- Luego crear usuarios desde Authentication > Users y promover al primer admin:
-- update public.profiles set role = 'admin' where email = 'TU_EMAIL@EMPRESA.COM';

create extension if not exists pgcrypto;

-- ============================================================
-- TYPES
-- ============================================================
do $$ begin
  create type public.user_role as enum ('auditor', 'admin');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.audit_status as enum ('draft', 'completed');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.answer_status as enum ('complies', 'non_complies', 'na');
exception when duplicate_object then null;
end $$;

-- ============================================================
-- TABLES
-- ============================================================
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  role public.user_role not null default 'auditor',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.audit_sections (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.audit_items (
  id uuid primary key default gen_random_uuid(),
  section_id uuid not null references public.audit_sections(id) on delete cascade,
  code text,
  title text not null,
  criterion text not null,
  is_critical boolean not null default false,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.audits (
  id uuid primary key default gen_random_uuid(),
  audit_date date not null default current_date,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  auditor_id uuid not null references public.profiles(id) on delete restrict,
  responsible_name text,
  operators_text text,
  vehicle_plate text,
  status public.audit_status not null default 'draft',
  score numeric(5,2),
  classification text,
  critical_failures integer not null default 0,
  applicable_items integer not null default 0,
  compliant_items integer not null default 0,
  noncompliant_items integer not null default 0,
  general_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.audit_responses (
  id uuid primary key default gen_random_uuid(),
  audit_id uuid not null references public.audits(id) on delete cascade,
  section_id uuid references public.audit_sections(id) on delete set null,
  item_id uuid references public.audit_items(id) on delete set null,
  section_title_snapshot text not null,
  section_order_snapshot integer not null default 0,
  item_code_snapshot text,
  item_title_snapshot text not null,
  criterion_snapshot text not null,
  is_critical_snapshot boolean not null default false,
  item_order_snapshot integer not null default 0,
  answer public.answer_status,
  observation text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(audit_id, item_id)
);

create index if not exists idx_audits_auditor_id on public.audits(auditor_id);
create index if not exists idx_audits_audit_date on public.audits(audit_date desc);
create index if not exists idx_audits_status on public.audits(status);
create index if not exists idx_responses_audit_id on public.audit_responses(audit_id);
create index if not exists idx_items_section_id on public.audit_items(section_id);

-- ============================================================
-- UPDATED_AT
-- ============================================================
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_profiles_updated_at on public.profiles;
create trigger trg_profiles_updated_at before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists trg_sections_updated_at on public.audit_sections;
create trigger trg_sections_updated_at before update on public.audit_sections
for each row execute function public.set_updated_at();

drop trigger if exists trg_items_updated_at on public.audit_items;
create trigger trg_items_updated_at before update on public.audit_items
for each row execute function public.set_updated_at();

drop trigger if exists trg_audits_updated_at on public.audits;
create trigger trg_audits_updated_at before update on public.audits
for each row execute function public.set_updated_at();

drop trigger if exists trg_responses_updated_at on public.audit_responses;
create trigger trg_responses_updated_at before update on public.audit_responses
for each row execute function public.set_updated_at();

-- ============================================================
-- PROFILE AUTO-CREATION
-- ============================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(coalesce(new.email,''), '@', 1)),
    'auditor'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Backfill existing auth users if any
insert into public.profiles (id, email, full_name, role)
select id, coalesce(email,''), coalesce(raw_user_meta_data ->> 'full_name', split_part(coalesce(email,''), '@',1)), 'auditor'
from auth.users
on conflict (id) do nothing;

-- ============================================================
-- AUTH HELPERS
-- ============================================================
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- ============================================================
-- RLS
-- ============================================================
alter table public.profiles enable row level security;
alter table public.audit_sections enable row level security;
alter table public.audit_items enable row level security;
alter table public.audits enable row level security;
alter table public.audit_responses enable row level security;

-- PROFILES
DROP POLICY IF EXISTS "profiles_select" ON public.profiles;
create policy "profiles_select" on public.profiles
for select to authenticated
using (id = auth.uid() or public.is_admin());

DROP POLICY IF EXISTS "profiles_admin_update" ON public.profiles;
create policy "profiles_admin_update" on public.profiles
for update to authenticated
using (public.is_admin())
with check (public.is_admin());

-- SECTIONS
DROP POLICY IF EXISTS "sections_select" ON public.audit_sections;
create policy "sections_select" on public.audit_sections
for select to authenticated using (true);

DROP POLICY IF EXISTS "sections_admin_insert" ON public.audit_sections;
create policy "sections_admin_insert" on public.audit_sections
for insert to authenticated with check (public.is_admin());

DROP POLICY IF EXISTS "sections_admin_update" ON public.audit_sections;
create policy "sections_admin_update" on public.audit_sections
for update to authenticated using (public.is_admin()) with check (public.is_admin());

DROP POLICY IF EXISTS "sections_admin_delete" ON public.audit_sections;
create policy "sections_admin_delete" on public.audit_sections
for delete to authenticated using (public.is_admin());

-- ITEMS
DROP POLICY IF EXISTS "items_select" ON public.audit_items;
create policy "items_select" on public.audit_items
for select to authenticated using (true);

DROP POLICY IF EXISTS "items_admin_insert" ON public.audit_items;
create policy "items_admin_insert" on public.audit_items
for insert to authenticated with check (public.is_admin());

DROP POLICY IF EXISTS "items_admin_update" ON public.audit_items;
create policy "items_admin_update" on public.audit_items
for update to authenticated using (public.is_admin()) with check (public.is_admin());

DROP POLICY IF EXISTS "items_admin_delete" ON public.audit_items;
create policy "items_admin_delete" on public.audit_items
for delete to authenticated using (public.is_admin());

-- AUDITS
DROP POLICY IF EXISTS "audits_select" ON public.audits;
create policy "audits_select" on public.audits
for select to authenticated
using (auditor_id = auth.uid() or public.is_admin());

DROP POLICY IF EXISTS "audits_insert" ON public.audits;
create policy "audits_insert" on public.audits
for insert to authenticated
with check (auditor_id = auth.uid() or public.is_admin());

DROP POLICY IF EXISTS "audits_update_draft" ON public.audits;
create policy "audits_update_draft" on public.audits
for update to authenticated
using ((auditor_id = auth.uid() or public.is_admin()) and status = 'draft')
with check ((auditor_id = auth.uid() or public.is_admin()) and status in ('draft','completed'));

DROP POLICY IF EXISTS "audits_delete_draft" ON public.audits;
create policy "audits_delete_draft" on public.audits
for delete to authenticated
using ((auditor_id = auth.uid() or public.is_admin()) and status = 'draft');

-- RESPONSES
DROP POLICY IF EXISTS "responses_select" ON public.audit_responses;
create policy "responses_select" on public.audit_responses
for select to authenticated
using (exists (
  select 1 from public.audits a
  where a.id = audit_id and (a.auditor_id = auth.uid() or public.is_admin())
));

DROP POLICY IF EXISTS "responses_insert_draft" ON public.audit_responses;
create policy "responses_insert_draft" on public.audit_responses
for insert to authenticated
with check (exists (
  select 1 from public.audits a
  where a.id = audit_id and a.status = 'draft' and (a.auditor_id = auth.uid() or public.is_admin())
));

DROP POLICY IF EXISTS "responses_update_draft" ON public.audit_responses;
create policy "responses_update_draft" on public.audit_responses
for update to authenticated
using (exists (
  select 1 from public.audits a
  where a.id = audit_id and a.status = 'draft' and (a.auditor_id = auth.uid() or public.is_admin())
))
with check (exists (
  select 1 from public.audits a
  where a.id = audit_id and a.status = 'draft' and (a.auditor_id = auth.uid() or public.is_admin())
));

DROP POLICY IF EXISTS "responses_delete_draft" ON public.audit_responses;
create policy "responses_delete_draft" on public.audit_responses
for delete to authenticated
using (exists (
  select 1 from public.audits a
  where a.id = audit_id and a.status = 'draft' and (a.auditor_id = auth.uid() or public.is_admin())
));

-- Grants (RLS sigue siendo la capa efectiva de seguridad)
grant usage on schema public to authenticated;
grant select on public.profiles, public.audit_sections, public.audit_items, public.audits, public.audit_responses to authenticated;
grant insert, update, delete on public.audit_sections, public.audit_items, public.audits, public.audit_responses to authenticated;
grant update on public.profiles to authenticated;

-- ============================================================
-- SEED CHECKLIST
-- Idempotente: sólo se carga si no hay secciones.
-- ============================================================
do $$
declare
  s uuid;
begin
  if not exists (select 1 from public.audit_sections) then

    insert into public.audit_sections(title, description, sort_order) values
    ('1. Orden y limpieza del galpón','Estado general del espacio operativo y administrativo.',10)
    returning id into s;
    insert into public.audit_items(section_id,code,title,criterion,is_critical,sort_order) values
    (s,'1.1','Piso general','Sin residuos, papeles, productos derramados ni obstáculos innecesarios.',false,10),
    (s,'1.2','Estaciones de trabajo','Cada estación se encuentra despejada y con los elementos correspondientes.',false,20),
    (s,'1.3','Pasillos y circulación','Libres de máquinas, baldes, cables u objetos que dificulten el paso.',true,30),
    (s,'1.4','Bacha principal','Limpia, sin acumulación de residuos y operativa.',false,40),
    (s,'1.5','Bacha a cloaca','Limpia, descargada correctamente y sin obstrucciones visibles.',false,50),
    (s,'1.6','Tachos de basura','Limpios, descargados y con bolsa colocada.',false,60),
    (s,'1.7','Escritorio','Superficie limpia, sin acumulación de papeles u objetos innecesarios.',false,70),
    (s,'1.8','Mueble / área administrativa','Documentación y materiales guardados y ordenados.',false,80),
    (s,'1.9','Productos químicos','Guardados en el sector correspondiente y correctamente identificados.',true,90),
    (s,'1.10','Canastos y materiales','Guardados en el lugar definido cuando no están siendo utilizados.',false,100),
    (s,'1.11','Estado general visual','No existen elementos fuera de lugar luego de recorrer completamente el galpón.',false,110);

    insert into public.audit_sections(title, description, sort_order) values
    ('2. Preparación para la operación','Documentación, insumos y elementos listos antes del inicio.',20)
    returning id into s;
    insert into public.audit_items(section_id,code,title,criterion,is_critical,sort_order) values
    (s,'2.1','Checklist disponibles','Hay cantidad suficiente de hojas o soporte digital disponible para la jornada.',false,10),
    (s,'2.2','Planilla Recibo de Autos','Hay formularios disponibles antes del ingreso del primer vehículo.',true,20),
    (s,'2.3','Planillas de insumos','Se encuentran preparadas y disponibles.',false,30),
    (s,'2.4','Microfibras','Limpias, secas, ordenadas y en cantidad suficiente.',false,40),
    (s,'2.5','Trapos','Limpios, secos y preparados.',false,50),
    (s,'2.6','Cepillos','Limpios y separados según uso.',false,60),
    (s,'2.7','Pulverizadores','Todos están rotulados indicando claramente su contenido.',true,70),
    (s,'2.8','Productos preparados','Los productos necesarios están disponibles antes de comenzar.',false,80),
    (s,'2.9','Stock diario','Existe cantidad suficiente para completar los servicios programados.',false,90),
    (s,'2.10','Canastos pertenencias','Disponibles, limpios y aptos para ser rotulados.',false,100),
    (s,'2.11','Film / protección electrónica','Disponible antes de comenzar los lavados interiores.',true,110);

    insert into public.audit_sections(title, description, sort_order) values
    ('3. Control de máquinas','Verificación funcional y visual previa de equipos.',30)
    returning id into s;
    insert into public.audit_items(section_id,code,title,criterion,is_critical,sort_order) values
    (s,'3.1','Lavatapizados','Limpia, seca, armada y enciende correctamente.',true,10),
    (s,'3.2','Aspiradora','Limpia, con accesorios y succión comprobada.',false,20),
    (s,'3.3','Hidrolavadora','Sin pérdidas visibles y funcionamiento comprobado.',true,30),
    (s,'3.4','Turbinas de secado','Limpias y funcionamiento comprobado antes del servicio.',false,40),
    (s,'3.5','Mangueras','Sin roturas, pérdidas o conexiones defectuosas.',true,50),
    (s,'3.6','Cables eléctricos','Sin cortes, empalmes expuestos o daños visibles.',true,60),
    (s,'3.7','Máquinas no utilizadas','Se encuentran guardadas limpias y secas.',false,70);

    insert into public.audit_sections(title, description, sort_order) values
    ('4. Presentación del personal','Puntualidad, uniforme y elementos de protección.',40)
    returning id into s;
    insert into public.audit_items(section_id,code,title,criterion,is_critical,sort_order) values
    (s,'4.1','Horario','Personal correspondiente presente al inicio de la jornada.',false,10),
    (s,'4.2','Chomba','Uniforme de empresa colocado y en condiciones.',false,20),
    (s,'4.3','Pantalón','Uniforme completo.',false,30),
    (s,'4.4','Calzado de seguridad','Utilizado durante la operación.',true,40),
    (s,'4.5','Elementos de protección','Guantes, anteojos y demás EPP utilizados cuando la tarea lo requiere.',true,50);

    insert into public.audit_sections(title, description, sort_order) values
    ('5. Recepción del cliente y del vehículo','Recepción, relevamiento y resguardo documental previo al trabajo.',50)
    returning id into s;
    insert into public.audit_items(section_id,code,title,criterion,is_critical,sort_order) values
    (s,'5.1','Recepción','Se saludó al cliente cordialmente.',false,10),
    (s,'5.2','Actitud','El operario mantuvo trato cordial y predisposición durante la recepción.',false,20),
    (s,'5.3','Cliente nuevo','Se consultó si era la primera vez que utilizaba el servicio.',false,30),
    (s,'5.4','Explicación del servicio','Si correspondía, se explicó brevemente el procedimiento.',false,40),
    (s,'5.5','Motivo principal','Se preguntó al cliente qué problema o necesidad específica tenía.',false,50),
    (s,'5.6','Inspección exterior','Se realizó recorrido visual completo del vehículo.',true,60),
    (s,'5.7','Inspección interior','Se revisó el estado general del interior y tapizados.',true,70),
    (s,'5.8','Daños preexistentes','Golpes, rayones, vidrios dañados u otros desperfectos fueron registrados.',true,80),
    (s,'5.9','Planilla de recepción','Se completó la “Planilla Recibo de Autos Naón”.',true,90),
    (s,'5.10','Firma del cliente','La planilla quedó firmada antes de comenzar el trabajo.',true,100);

    insert into public.audit_sections(title, description, sort_order) values
    ('6. Pertenencias y preparación del vehículo','Retiro, identificación y resguardo de objetos y alfombras.',60)
    returning id into s;
    insert into public.audit_items(section_id,code,title,criterion,is_critical,sort_order) values
    (s,'6.1','Retiro de pertenencias','Se retiraron los objetos antes de comenzar el aspirado.',true,10),
    (s,'6.2','Revisión completa','Se controlaron guantera, puertas, baúl y debajo de los asientos.',false,20),
    (s,'6.3','Canasto','Todas las pertenencias quedaron juntas en un único canasto.',true,30),
    (s,'6.4','Identificación del canasto','El canasto está rotulado con la patente correspondiente.',true,40),
    (s,'6.5','Alfombras','Se retiraron antes del proceso interior.',false,50),
    (s,'6.6','Identificación alfombras','Todas están marcadas con la patente correspondiente.',true,60),
    (s,'6.7','Ubicación alfombras','Quedaron agrupadas junto al canasto del mismo vehículo.',false,70);

    insert into public.audit_sections(title, description, sort_order) values
    ('7. Aspirado y pretratamiento','Secuencia, cobertura y validación del producto antes del lavado.',70)
    returning id into s;
    insert into public.audit_items(section_id,code,title,criterion,is_critical,sort_order) values
    (s,'7.1','Secuencia','El trabajo se realiza siguiendo un recorrido ordenado y sin sectores salteados.',false,10),
    (s,'7.2','Dirección de limpieza','Se comenzó desde las zonas superiores hacia las inferiores.',false,20),
    (s,'7.3','Techo','Fue aspirado o tratado según correspondiera.',false,30),
    (s,'7.4','Asientos','Superficies y juntas fueron aspiradas.',false,40),
    (s,'7.5','Debajo de asientos','Sin suciedad visible al finalizar el aspirado.',false,50),
    (s,'7.6','Piso','Aspirado completo, incluidos rincones.',false,60),
    (s,'7.7','Tablero / torpedo','Limpieza previa realizada sin dejar polvo acumulado.',false,70),
    (s,'7.8','Manchas específicas','Se identificaron antes de seleccionar producto.',false,80),
    (s,'7.9','Compatibilidad','Antes de utilizar un producto nuevo sobre el material se realizó prueba en sector no visible.',true,90),
    (s,'7.10','Resultado prueba','Se verificó que no existieran decoloración o daños antes de continuar.',true,100);

    insert into public.audit_sections(title, description, sort_order) values
    ('8. Lavado de tapizados','Aplicación, cepillado y extracción según estándar operativo.',80)
    returning id into s;
    insert into public.audit_items(section_id,code,title,criterion,is_critical,sort_order) values
    (s,'8.1','Electrónica protegida','Componentes electrónicos expuestos fueron cubiertos previamente.',true,10),
    (s,'8.2','Dilución','Se utilizó el producto con la preparación definida para la tarea.',true,20),
    (s,'8.3','Aplicación','Se evitó saturar innecesariamente los tapizados.',false,30),
    (s,'8.4','Tiempo de acción','El producto tuvo tiempo de actuación antes de retirar.',false,40),
    (s,'8.5','Cepillado','Se realizó de manera uniforme sobre los sectores tratados.',false,50),
    (s,'8.6','Extracción','Se retiró correctamente producto y humedad con la lavatapizados.',false,60),
    (s,'8.7','Juntas','No quedan sectores visiblemente omitidos.',false,70),
    (s,'8.8','Debajo de asientos','Zona procesada correctamente.',false,80);

    insert into public.audit_sections(title, description, sort_order) values
    ('9. Secado','Control del secado antes de avanzar a terminaciones.',90)
    returning id into s;
    insert into public.audit_items(section_id,code,title,criterion,is_critical,sort_order) values
    (s,'9.1','Turbinas','Se colocaron correctamente para acelerar el secado.',false,10),
    (s,'9.2','Humedad final','No existen sectores excesivamente húmedos antes de avanzar.',false,20),
    (s,'9.3','Control previo','Se verificó el secado antes de aplicar productos finales.',false,30);

    insert into public.audit_sections(title, description, sort_order) values
    ('10. Plásticos, detalles y cristales','Aplicación segura de producto y terminación interior.',100)
    returning id into s;
    insert into public.audit_items(section_id,code,title,criterion,is_critical,sort_order) values
    (s,'10.1','Aplicación APC','El producto se aplica sobre pincel, cepillo o microfibra.',true,10),
    (s,'10.2','Electrónica','No se pulveriza directamente sobre componentes electrónicos.',true,20),
    (s,'10.3','Parlantes','No se pulveriza producto directamente sobre ellos.',true,30),
    (s,'10.4','Detalles','Sectores de difícil acceso fueron trabajados con pinceles o hisopos.',false,40),
    (s,'10.5','Retiro de producto','No quedan restos visibles de APC en superficies.',false,50),
    (s,'10.6','Silicona interior','Aplicada únicamente una vez limpia y seca la superficie.',false,60),
    (s,'10.7','Cristales internos','Limpios, sin marcas evidentes o restos de producto.',false,70);

    insert into public.audit_sections(title, description, sort_order) values
    ('11. Lavado exterior','Secuencia y resultado del lavado exterior.',110)
    returning id into s;
    insert into public.audit_items(section_id,code,title,criterion,is_critical,sort_order) values
    (s,'11.1','Enjuague inicial','Se realizó desde arriba hacia abajo.',false,10),
    (s,'11.2','Sólidos','Se retiró la suciedad gruesa antes del lavado manual.',false,20),
    (s,'11.3','Ruedas','Fueron tratadas y enjuagadas.',false,30),
    (s,'11.4','Método dos baldes','Se utilizó el procedimiento correspondiente para el lavado exterior.',false,40),
    (s,'11.5','Orden de lavado','El vehículo fue lavado siguiendo una secuencia continua.',false,50),
    (s,'11.6','Enjuague final','No quedan restos visibles de shampoo o producto.',false,60),
    (s,'11.7','Secado','Se utilizaron microfibras destinadas al secado.',false,70),
    (s,'11.8','Resultado exterior','No quedan marcas evidentes, suciedad residual o sectores omitidos.',false,80);

    insert into public.audit_sections(title, description, sort_order) values
    ('12. Control final y entrega','Validación final, restitución de pertenencias y liberación del vehículo.',120)
    returning id into s;
    insert into public.audit_items(section_id,code,title,criterion,is_critical,sort_order) values
    (s,'12.1','Interior','Se realizó inspección visual completa antes de entregar.',true,10),
    (s,'12.2','Exterior','Se inspeccionó el vehículo completo.',false,20),
    (s,'12.3','Tapizados','No existen sectores evidentemente omitidos.',false,30),
    (s,'12.4','Plásticos','Sin restos de producto, chorreaduras o manchas.',false,40),
    (s,'12.5','Cristales','Sin marcas visibles.',false,50),
    (s,'12.6','Pertenencias','Canasto correspondiente identificado y disponible para devolución.',true,60),
    (s,'12.7','Alfombras','Corresponden a la patente auditada y fueron restituidas correctamente.',true,70),
    (s,'12.8','Checklist final','Se completó el control de entrega antes de avisar que el vehículo estaba terminado.',true,80),
    (s,'12.9','Área de trabajo','La estación queda limpia y preparada para el siguiente vehículo.',false,90);
  end if;
end $$;
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


-- ============================================================
-- MIGRACIÓN V4 INTEGRADA PARA INSTALACIONES NUEVAS
-- ============================================================
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
