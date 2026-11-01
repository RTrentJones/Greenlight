create table public.profiles (
  id text primary key,
  email text not null,
  display_name text,
  created_at date not null default current_date
);
alter table public.profiles enable row level security;
-- profiles are private: no anon grant.

create table public.quizzes (
  id bigint generated always as identity primary key,
  title text not null,
  owner_id text not null references public.profiles (id),
  published boolean not null default false
);
grant select on public.quizzes to anon;

-- One row, no user data, readable anonymously.
create table public.keepalive_probe (id int primary key);
insert into public.keepalive_probe (id) values (1);
grant select on public.keepalive_probe to anon;
