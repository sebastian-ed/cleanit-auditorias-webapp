-- Reemplazar el email y ejecutar una sola vez en Supabase > SQL Editor.
update public.profiles
set role = 'admin'
where email = 'TU_EMAIL@EMPRESA.COM';
