# Clean It · Auditorías Operativas Naón · V4

Webapp estática para ejecutar, registrar y analizar auditorías operativas de Clean It con Supabase.

## Novedades de V4

Esta versión corrige dos puntos operativos:

1. **Eliminación segura de auditorías**
   - selección individual mediante checkbox;
   - selección de algunas auditorías;
   - selección de todas las auditorías visibles;
   - eliminación múltiple;
   - confirmación escribiendo exactamente `ELIMINAR`;
   - registro de quién eliminó, cuándo y qué auditoría se eliminó;
   - corrección de instalaciones donde faltaba la tabla `audit_activity_log`.

2. **Auditorías finalizadas con ítems pendientes**
   - ya no es obligatorio responder el 100% del checklist para finalizar;
   - si existen ítems sin responder, la aplicación muestra una advertencia antes de finalizar;
   - la auditoría queda marcada como **Finalizada incompleta**;
   - Historial, detalle y PDF muestran cantidad respondida, total y pendientes;
   - el puntaje se calcula únicamente sobre los ítems efectivamente respondidos y aplicables;
   - una auditoría incompleta puede editarse posteriormente y pasar a completa cuando se respondan los pendientes.

La trazabilidad operativa obligatoria de una auditoría de vehículo —patente, quién recibió, quiénes trabajaron y quién hizo el control final— se mantiene como requisito de cierre.

---

## Tipos de auditoría

### Estado del local

Incluye:

1. Orden y limpieza del galpón
2. Preparación para la operación
3. Control de máquinas
4. Presentación del personal

Registra responsable operativo y personal presente.

### Vehículo

Incluye:

5. Recepción del cliente y del vehículo
6. Pertenencias y preparación del vehículo
7. Aspirado y pretratamiento
8. Lavado de tapizados
9. Secado
10. Plásticos, detalles y cristales
11. Lavado exterior
12. Control final y entrega

Registra:

- patente;
- quién recibió el vehículo;
- quiénes trabajaron sobre el vehículo;
- quién realizó el control final.

Las auditorías anteriores a la separación Local/Vehículo siguen identificadas como **Históricas**.

---

## Funcionalidades

- Login con Supabase Auth.
- Roles `auditor` y `admin`.
- Auditorías Local / Vehículo.
- Respuestas **Cumple / No cumple / N/A**.
- Ítems sin responder permitidos al cierre, con advertencia explícita.
- Guardado automático durante la ejecución.
- Borradores recuperables.
- Puntaje y clasificación automáticos.
- Regla de criticidad.
- Historial con filtros.
- Checkbox por auditoría.
- Botón **Seleccionar todo**.
- Eliminación individual o múltiple.
- Confirmación de eliminación con `ELIMINAR`.
- Edición de auditorías finalizadas.
- Registro de ediciones y eliminaciones.
- Panel consolidado.
- KPI de auditorías finalizadas incompletas.
- Vista individual de cada auditoría.
- Informes PDF.
- Administración de secciones e ítems.
- Administración de roles.
- Snapshot histórico del checklist.

---

## Lógica de evaluación

- `Cumple` = 1 punto.
- `No cumple` = 0 puntos.
- `N/A` queda fuera del denominador.
- `Sin responder` queda fuera del cálculo y genera estado **Incompleta**.
- Puntaje = ítems cumplidos / ítems respondidos aplicables × 100.
- 95–100% = **Conforme**.
- 90–94,99% = **Conforme con observaciones**.
- Menos de 90% = **No conforme**.
- Un incumplimiento crítico fuerza **No conforme**.
- Si no existe ningún ítem evaluable, el resultado es **Sin evaluación**.

Importante: una auditoría puede estar **Finalizada** y al mismo tiempo **Incompleta**. Son dos conceptos distintos: finalizada indica que fue cerrada; incompleta indica que quedaron preguntas sin responder.

---

# Actualización desde la V3 actualmente publicada

## 1. Reemplazar los archivos del repositorio

Reemplazá los archivos actuales del repositorio GitHub por los de esta carpeta y hacé commit/push a `main`.

GitHub Pages volverá a desplegar automáticamente.

## 2. Ejecutar UNA migración en Supabase

Abrí:

`Supabase → SQL Editor → New query`

Copiá y ejecutá completo:

`supabase/migration_v4_incomplete_and_delete_fix.sql`

Esta migración es **idempotente**: si por error la ejecutás nuevamente, no debería duplicar estructura.

### Esta migración es obligatoria

El error:

`relation "public.audit_activity_log" does not exist`

significa que la base actual no tiene creada la bitácora requerida para la eliminación segura. La migración V4 la crea y vuelve a instalar las funciones de eliminación.

Además agrega a `audits`:

- `total_items`
- `answered_items`
- `unanswered_items`
- `is_complete`

También instala `update_completed_audit_v4`, que permite editar auditorías finalizadas aunque existan ítems sin respuesta.

**No necesitás volver a ejecutar schema.sql, migration_v2 ni migration_v3 sobre tu instalación actual.**

---

# Instalación desde cero

En un proyecto Supabase nuevo ejecutá solamente:

`supabase/schema.sql`

El archivo integra el esquema base y las migraciones hasta V4.

Después:

1. Crear usuarios en `Authentication → Users`.
2. Promover el primer administrador ejecutando `supabase/promote-admin.sql`.
3. Subir el contenido a GitHub.
4. Activar GitHub Pages desde `Settings → Pages → Deploy from a branch → main → /(root)`.

`assets/js/config.js` ya contiene la URL y Publishable Key configuradas para este proyecto.

Nunca colocar una `service_role` key en una web estática.

---

## Roles

### Auditor

- Crear auditorías.
- Guardar borradores.
- Finalizar auditorías completas o incompletas.
- Ver sus auditorías.
- Editar sus auditorías finalizadas.
- Eliminar una o varias de sus auditorías con confirmación segura.
- Descargar informes PDF.

### Admin

Además puede:

- ver todas las auditorías;
- editar auditorías de cualquier auditor;
- eliminar auditorías de cualquier auditor;
- ver el panel consolidado;
- administrar checklist;
- administrar roles.

La autorización real se controla mediante Supabase RLS y funciones SQL, no solamente desde la interfaz.

---

## Trazabilidad

Cada auditoría conserva una copia del texto y configuración de las preguntas utilizadas en el momento de ejecución.

Cuando se edita una auditoría finalizada, `audit_activity_log` conserva la versión anterior y posterior junto con usuario y fecha.

Cuando se elimina una auditoría, se elimina definitivamente el registro operativo y sus respuestas, pero queda una entrada de trazabilidad con usuario, fecha y metadata identificatoria básica.

---

## Estructura

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
    ├── migration_v4_incomplete_and_delete_fix.sql
    └── promote-admin.sql
```
