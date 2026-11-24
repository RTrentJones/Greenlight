create table public.heartbeat (id int primary key, note text);
insert into public.heartbeat (id, note) values (1, 'keepalive');
grant select on public.heartbeat to anon;
