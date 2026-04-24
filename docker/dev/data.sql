create table profiles (
  id uuid references auth.users not null,
  updated_at timestamp with time zone,
  username text unique,
  avatar_url text,
  website text,

  primary key (id),
  unique(username),
  constraint username_length check (char_length(username) >= 3)
);

alter table profiles enable row level security;

create policy "Public profiles are viewable by the owner."
  on profiles for select
  using ( auth.uid() = id );

create policy "Users can insert their own profile."
  on profiles for insert
  with check ( auth.uid() = id );

create policy "Users can update own profile."
  on profiles for update
  using ( auth.uid() = id );

-- Set up Realtime
begin;
  drop publication if exists supabase_realtime;
  create publication supabase_realtime;
commit;
alter publication supabase_realtime add table profiles;

-- The previous version of this file inserted an `avatars` row into
-- `storage.buckets` and declared three policies on `storage.objects`. Both
-- tables are created by the Storage API container the first time it boots,
-- NOT by Postgres init scripts. `data.sql` runs from
-- `/docker-entrypoint-initdb.d` during the `db` container's first start,
-- which is BEFORE Storage has had a chance to run its own bootstrap SQL — so
-- the old block failed every time with `relation "storage.buckets" does not
-- exist`, leaving the rest of the seed file partially applied.
--
-- We intentionally drop the storage seed here. The avatars bucket is a
-- Studio-UI convenience and can be recreated in one click from
-- `/project/{ref}/storage/buckets`, or by running the following block by
-- hand against the DB once the Storage container is up:
--
--   insert into storage.buckets (id, name) values ('avatars', 'avatars');
--   create policy "Avatar images are publicly accessible." on storage.objects
--     for select using (bucket_id = 'avatars');
--   create policy "Anyone can upload an avatar." on storage.objects
--     for insert with check (bucket_id = 'avatars');
--   create policy "Anyone can update an avatar." on storage.objects
--     for update with check (bucket_id = 'avatars');
--
-- Re-adding the block here without first reordering init would just
-- re-break `docker compose up --build` on a clean volume.
