-- Rechte: Das Projekt hat „Automatically expose new tables" aus, daher bekommt service_role nichts automatisch.
-- Die Edge Functions arbeiten mit dem Secret Key (Rolle service_role). anon/authenticated bekommen bewusst nichts.

grant usage on schema public to service_role;
grant all privileges on all tables in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

alter default privileges for role postgres in schema public grant all on tables to service_role;
alter default privileges for role postgres in schema public grant all on sequences to service_role;
alter default privileges for role postgres in schema public grant execute on functions to service_role;

revoke all on function public.radar_call(text, jsonb) from service_role;
