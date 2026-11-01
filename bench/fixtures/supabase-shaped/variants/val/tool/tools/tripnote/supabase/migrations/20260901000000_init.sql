create table public.accounts (
  id text primary key,
  email text not null,
  full_name text,
  home_city text
);
alter table public.accounts enable row level security;

create table public.trips (
  id bigint generated always as identity primary key,
  account_id text not null references public.accounts (id),
  destination text not null,
  starts_on date
);
grant select on public.trips to anon;
