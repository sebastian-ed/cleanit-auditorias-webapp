# Clean It · Auditorías Operativas Naón · V5

Webapp estática en HTML, CSS, JavaScript y Bootstrap, con Supabase para autenticación, permisos, persistencia, trazabilidad e historial.

## V5: tres tipos de auditoría

### 1. Estado del local

Incluye únicamente:

1. Orden y limpieza del galpón
2. Preparación para la operación
3. Control de máquinas

Antes de iniciar, el auditor debe marcar qué operarios están presentes. La selección se hace desde un maestro de operarios y queda guardada como snapshot de nombres en la auditoría.

### 2. Presentación del personal

Incluye únicamente:

4. Presentación del personal

Es una auditoría individual: se selecciona un único operario y se lo evalúa de manera independiente. Esto permite generar una serie diaria por persona y filtrar el panel por operario.

### 3. Vehículo

Mantiene el flujo anterior:

5. Recepción del cliente y del vehículo
6. Pertenencias y preparación del vehículo
7. Aspirado y pretratamiento
8. Lavado de tapizados
9. Secado
10. Plásticos, detalles y cristales
11. Lavado exterior
12. Control final y entrega

Registra patente, quién recibió el vehículo, quiénes trabajaron sobre él y quién realizó el control final.

Las auditorías históricas existentes no se reinterpretan ni se modifican.

---

## Maestro de operarios

Los administradores tienen una nueva sección **Operarios** desde la cual pueden:

- agregar operarios;
- editar nombres;
- activar o desactivar operarios.

No se recomienda borrar personas del maestro: se desactivan para conservar consistencia histórica. Las auditorías guardan también el nombre utilizado en el momento de ejecución.

---

## Funcionalidades principales

- Login con Supabase Auth.
- Roles `auditor` y `admin`.
- Tres tipos de auditoría.
- Respuestas **Cumple / No cumple / N/A**.
- Cierre permitido con ítems sin responder, con advertencia y estado **Incompleta**.
- Guardado automático de respuestas y borradores.
- Puntaje y clasificación automáticos.
- Incumplimientos críticos.
- Historial con filtros.
- Selección individual, múltiple o total para eliminar auditorías.
- Confirmación segura escribiendo `ELIMINAR`.
- Edición de auditorías finalizadas.
- Registro de ediciones y eliminaciones.
- Panel consolidado.
- Filtro de panel por tipo de auditoría y por operario en auditorías de presentación personal.
- Vista individual de cada auditoría.
- Informes PDF.
- Administración editable del checklist.
- Maestro de operarios.
- Administración de roles.
- Snapshot histórico de preguntas, criterios y datos identificatorios.

---

## Actualización desde V4

### 1. Reemplazar archivos en GitHub

Reemplazá los archivos actuales del repositorio por los incluidos en este paquete y hacé commit/push a `main`.

GitHub Pages volverá a desplegar automáticamente.

### 2. Ejecutar UNA migración nueva en Supabase

Abrí:

`Supabase → SQL Editor → New query`

Ejecutá completo:

`supabase/migration_v5_three_audit_types_staff.sql`

**No vuelvas a ejecutar las migraciones V2, V3 o V4 si ya estaban aplicadas.**

La migración V5:

- agrega el tipo `personnel`;
- mueve la sección 4 al nuevo tipo de auditoría;
- mantiene las secciones 1–3 en `local` y 5–12 en `vehicle`;
- crea `staff_members`;
- intenta recuperar automáticamente nombres ya usados en `operators_text` de auditorías anteriores;
- agrega referencias de operarios presentes y operario auditado;
- instala `update_completed_audit_v5` para preservar la trazabilidad al editar;
- conserva la eliminación múltiple segura.

Después del deploy conviene hacer `Ctrl + F5` para evitar que el navegador use JavaScript de una versión anterior.

---

## Instalación desde cero

En un proyecto Supabase nuevo ejecutá solamente:

`supabase/schema.sql`

El archivo integra el esquema base y las migraciones hasta V5.

Después:

1. Crear usuarios desde `Authentication → Users`.
2. Promover el primer administrador ejecutando `supabase/promote-admin.sql`.
3. Entrar a **Operarios** y completar el maestro de personal.
4. Subir el contenido a GitHub.
5. Activar GitHub Pages desde `Settings → Pages → Deploy from a branch → main → /(root)`.

`assets/js/config.js` ya contiene la URL y Publishable Key configuradas para el proyecto actual.

Nunca colocar una `service_role` key en una aplicación web estática.

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

---

## Roles

### Auditor

Puede crear auditorías, guardar borradores, finalizar auditorías completas o incompletas, consultar sus auditorías, editarlas, eliminarlas con confirmación segura y descargar informes.

### Admin

Además puede ver y administrar auditorías de todos los auditores, administrar el checklist, mantener el maestro de operarios y gestionar roles.

La autorización efectiva se aplica mediante Supabase RLS y funciones SQL.

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
    ├── migration_v5_three_audit_types_staff.sql
    └── promote-admin.sql
```
