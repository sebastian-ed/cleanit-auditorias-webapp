# Clean It · Auditorías Operativas Naón · V3

Webapp estática para ejecutar, registrar y analizar auditorías operativas de Clean It con Supabase.

## Qué cambia en V3

La operación queda separada en dos auditorías distintas:

### 1. Auditoría de estado del local
Incluye únicamente:

1. Orden y limpieza del galpón
2. Preparación para la operación
3. Control de máquinas
4. Presentación del personal

Registra responsable operativo y personal presente.

### 2. Auditoría de vehículo
Incluye únicamente:

5. Recepción del cliente y del vehículo
6. Pertenencias y preparación del vehículo
7. Aspirado y pretratamiento
8. Lavado de tapizados
9. Secado
10. Plásticos, detalles y cristales
11. Lavado exterior
12. Control final y entrega

Cada auditoría de vehículo registra:

- patente;
- quién recibió el vehículo;
- quiénes trabajaron sobre el vehículo;
- quién realizó el control final.

La patente y los tres responsables operativos deben quedar completos antes de finalizar la auditoría.

Las auditorías creadas antes de V3 se conservan como **Históricas (formato anterior)**. No se reinterpretan como local o vehículo porque originalmente contenían las 12 secciones.

## Funcionalidades

- Login con Supabase Auth.
- Roles `auditor` y `admin`.
- Auditorías separadas por tipo: Local / Vehículo.
- Respuestas **Cumple / No cumple / N/A**.
- Guardado automático de respuestas y metadatos durante borradores.
- Borradores recuperables.
- Cálculo automático de puntaje y clasificación.
- Regla de criticidad: cualquier incumplimiento crítico fuerza **No conforme**.
- Historial con filtros por fecha, tipo, estado y búsqueda.
- Selección individual mediante checkbox.
- **Seleccionar todo** sobre los resultados visibles.
- Eliminación individual o múltiple.
- Eliminación segura: exige escribir exactamente `ELIMINAR`.
- Edición posterior de auditorías finalizadas.
- Bitácora visible de ediciones y eliminaciones.
- Vista individual de cada auditoría.
- Panel con filtro por tipo de auditoría.
- Descarga de informe individual en PDF.
- Administración del checklist separada por Local / Vehículo.
- Crear, editar, activar/desactivar y eliminar secciones e ítems.
- Administración de roles.
- Snapshot histórico del checklist: los cambios futuros no alteran auditorías anteriores.

## Lógica de evaluación

- `Cumple` = 1 punto.
- `No cumple` = 0 puntos.
- `N/A` queda fuera del denominador.
- Puntaje = ítems cumplidos / ítems aplicables × 100.
- 95–100% = **Conforme**.
- 90–94,99% = **Conforme con observaciones**.
- Menos de 90% = **No conforme**.
- Al menos un `No cumple` crítico = **No conforme**, independientemente del porcentaje.

## Stack

- HTML5
- CSS3
- JavaScript
- Bootstrap 5.3
- Supabase JS v2
- Supabase Auth + Postgres + Row Level Security
- Chart.js
- jsPDF + AutoTable

No requiere Node, npm ni build. Puede publicarse directamente en GitHub Pages.

---

# Actualización desde tu versión actual V2

## 1. Reemplazar los archivos de GitHub

Reemplazá el contenido actual del repositorio por el contenido de esta carpeta y hacé commit/push a `main`.

GitHub Pages volverá a desplegar automáticamente.

## 2. Ejecutar la migración V3 en Supabase

En Supabase abrir:

`SQL Editor → New query`

Copiar y ejecutar completo:

`supabase/migration_v3_audit_types_bulk.sql`

**No vuelvas a ejecutar `migration_v2_edit_delete.sql` si ya la ejecutaste.**

La migración V3:

- agrega tipo de auditoría a secciones y auditorías;
- asigna secciones 1–4 a `local`;
- asigna secciones 5–12 a `vehicle`;
- conserva auditorías previas como `legacy`;
- agrega los tres responsables específicos del vehículo;
- agrega edición V3 con trazabilidad;
- agrega eliminación múltiple segura y atómica;
- conserva en la bitácora metadata suficiente para identificar una auditoría eliminada.

## 3. Supabase ya está configurado

`assets/js/config.js` ya contiene la URL y Publishable Key provistas para este proyecto.

No uses una `service_role` key en código cliente. La protección de datos se realiza con políticas RLS y funciones SQL con validación explícita de permisos.

---

# Instalación desde cero

Si se trata de un proyecto Supabase nuevo, ejecutá solamente:

`supabase/schema.sql`

Ese archivo ya incluye el esquema base y las migraciones V2 + V3.

Después:

1. Crear usuarios en `Authentication → Users`.
2. Promover al primer administrador ejecutando `supabase/promote-admin.sql` o:

```sql
update public.profiles
set role = 'admin'
where email = 'tu-email@empresa.com';
```

3. Subir los archivos a GitHub.
4. Activar GitHub Pages desde `Settings → Pages → Deploy from a branch → main → /(root)`.

---

# Roles

## Auditor

- Crear auditorías de local y vehículo.
- Completar y recuperar borradores.
- Ver sus auditorías.
- Editar sus auditorías finalizadas.
- Eliminar una o varias de sus auditorías con confirmación segura.
- Consultar la trazabilidad disponible de sus registros.
- Descargar informes PDF.

## Admin

Incluye lo anterior y además:

- Ver auditorías de todos los auditores.
- Editar cualquier auditoría finalizada.
- Eliminar una o varias auditorías de cualquier auditor.
- Ver el panel consolidado.
- Administrar secciones e ítems de cada tipo de auditoría.
- Cambiar roles de otros usuarios.

La autorización efectiva se controla en Supabase mediante RLS y RPC seguras, no sólo mediante la interfaz.

---

# Trazabilidad

Cada auditoría guarda una copia del texto de las preguntas, criterios, criticidad y orden utilizados en el momento de ejecución. Si el checklist maestro cambia más adelante, el histórico sigue mostrando el estándar que efectivamente se auditó.

Cuando una auditoría finalizada se edita, Supabase guarda una entrada en `audit_activity_log` con la versión anterior y posterior y recalcula puntaje, clasificación y fallas críticas.

Cuando una o varias auditorías se eliminan, se exige escribir **ELIMINAR**. La auditoría y sus respuestas desaparecen del historial operativo, pero `audit_activity_log` conserva quién realizó la eliminación, cuándo y metadata identificatoria del registro eliminado. Las respuestas eliminadas no se conservan.

---

# Estructura

```text
cleanit-auditorias/
├── index.html
├── README.md
├── .gitignore
├── assets/
│   ├── css/
│   │   └── styles.css
│   └── js/
│       ├── config.js
│       └── app.js
└── supabase/
    ├── schema.sql
    ├── migration_v2_edit_delete.sql
    ├── migration_v3_audit_types_bulk.sql
    └── promote-admin.sql
```

## Recomendación de gobernanza

Si una pregunta deja de utilizarse, es preferible marcarla como **Inactiva** antes que eliminarla. Así se mantiene visible como parte del estándar histórico de gestión sin aparecer en auditorías nuevas.
