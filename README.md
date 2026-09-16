# Clean It · Auditorías Operativas Naón

Webapp estática para ejecutar, registrar y analizar auditorías operativas del galpón Naón.

## Funcionalidades

- Login con Supabase Auth.
- Roles `auditor` y `admin`.
- Auditoría digital con respuestas **Cumple / No cumple / N/A**.
- Guardado automático de cada respuesta.
- Borradores recuperables.
- Cálculo automático de puntaje y clasificación.
- Regla de criticidad: cualquier incumplimiento crítico fuerza **No conforme**.
- Historial y trazabilidad.
- Vista individual de cada auditoría.
- Panel con KPIs y cumplimiento promedio por sección.
- Descarga del informe individual en PDF.
- Administración del checklist: crear, editar, activar/desactivar y eliminar secciones e ítems.
- Administración de roles de usuarios existentes.
- Snapshot histórico de preguntas: editar el checklist no altera auditorías ya realizadas.

## Lógica de evaluación

- `Cumple` = 1 punto.
- `No cumple` = 0 puntos.
- `N/A` queda fuera del denominador.
- Puntaje = ítems cumplidos / ítems aplicables × 100.
- 95–100% = **Conforme**.
- 90–94,99% = **Conforme con observaciones**.
- Menos de 90% = **No conforme**.
- Si existe al menos un `No cumple` en un ítem crítico, el resultado final es **No conforme**, aunque el porcentaje sea superior a 90%.

## Stack

- HTML5
- CSS3
- JavaScript
- Bootstrap 5.3
- Supabase JS v2
- Supabase Auth + Postgres + Row Level Security
- Chart.js
- jsPDF + AutoTable

No necesita Node, npm ni proceso de build. Se puede publicar directamente en GitHub Pages.

---

# Instalación

## 1. Crear proyecto en Supabase

Crear un proyecto nuevo en Supabase.

## 2. Crear la base de datos

Abrir:

`SQL Editor → New query`

Copiar y ejecutar todo el contenido de:

`supabase/schema.sql`

El script crea:

- perfiles y roles;
- secciones e ítems del checklist;
- auditorías;
- respuestas históricas;
- políticas RLS;
- trigger de creación automática de perfiles;
- checklist inicial de Naón.

## 3. Crear usuarios

En Supabase:

`Authentication → Users → Add user`

Crear las cuentas de los auditores y administradores.

Los usuarios nuevos ingresan por defecto con rol `auditor`.

## 4. Definir el primer administrador

Ejecutar en SQL Editor:

```sql
update public.profiles
set role = 'admin'
where email = 'tu-email@empresa.com';
```

También se incluye el archivo `supabase/promote-admin.sql`.

Una vez que exista un administrador, los demás roles se pueden modificar desde **Usuarios** dentro de la webapp.

> Por seguridad, el administrador no puede quitarse su propio rol desde la interfaz.

## 5. Configurar la conexión

Abrir:

`assets/js/config.js`

Completar:

```js
window.CLEANIT_CONFIG = {
  SUPABASE_URL: 'https://xxxxxxxx.supabase.co',
  SUPABASE_KEY: 'TU_PUBLISHABLE_O_ANON_KEY'
};
```

Los datos se encuentran en Supabase en la configuración/API del proyecto.

**No usar jamás la `service_role` key en este archivo.** La Publishable/Anon Key está diseñada para uso cliente; la protección de datos se realiza con RLS.

## 6. Probar localmente

Por seguridad del navegador conviene servir los archivos por HTTP y no abrir `index.html` como `file://`.

Con Python:

```bash
python -m http.server 8080
```

Abrir:

`http://localhost:8080`

## 7. Publicar en GitHub Pages

1. Crear un repositorio en GitHub.
2. Subir el contenido de esta carpeta a la raíz del repositorio.
3. Ir a `Settings → Pages`.
4. Seleccionar `Deploy from a branch`.
5. Seleccionar la rama `main` y carpeta `/root`.
6. Guardar.

La aplicación no usa rutas del lado del servidor, por lo que funciona directamente con GitHub Pages.

## 8. Configuración de Auth para producción

En Supabase, agregar la URL definitiva de GitHub Pages dentro de la configuración de URLs permitidas de Authentication. Si las cuentas son creadas manualmente y se usa email/contraseña, no hace falta habilitar registro público desde la webapp.

---

# Roles

## Auditor

- Iniciar auditorías.
- Guardar borradores.
- Finalizar auditorías.
- Ver sus propias auditorías.
- Descargar sus informes.
- Ver su propio dashboard.

## Admin

Incluye todo lo anterior y además:

- Ver auditorías de todos los auditores.
- Ver dashboard consolidado.
- Crear, editar, activar/desactivar y eliminar preguntas.
- Crear, editar, activar/desactivar y eliminar secciones.
- Cambiar roles de otros usuarios.

La separación de acceso está implementada en Supabase mediante **Row Level Security**, no solamente ocultando botones en la interfaz.

---

# Trazabilidad

Al iniciar una auditoría, la app copia a `audit_responses` una fotografía de:

- sección;
- código de ítem;
- nombre del punto de control;
- criterio objetivo;
- criticidad;
- orden.

Por eso, si en el futuro un administrador cambia o elimina una pregunta, los informes históricos mantienen exactamente la versión que fue auditada en ese momento.

Las auditorías finalizadas no pueden editarse desde la aplicación. Esta decisión es deliberada para preservar integridad del historial.

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
    └── promote-admin.sql
```

## Nota operativa

Para “sacar” una pregunta del checklist sin perderla como referencia administrativa, es preferible marcarla **Inactiva** antes que eliminarla. La eliminación también es segura para el historial porque las auditorías guardan snapshots, pero desactivar deja más clara la gobernanza del estándar vigente.
