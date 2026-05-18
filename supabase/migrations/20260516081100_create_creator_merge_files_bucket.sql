-- Migration: create private creator-merge-files bucket + ALTER duplicate_merge_snapshots ADD backed_up_files jsonb

create extension if not exists pgcrypto;

-- Alter existing table to add the backed_up_files array (nullable, default empty array)
alter table public.duplicate_merge_snapshots
add column if not exists backed_up_files jsonb default '[]'::jsonb;

-- Create the private bucket
insert into storage.buckets (id, name, public)
values ('creator-merge-files', 'creator-merge-files', false)
on conflict (id) do update set public = excluded.public;

-- Policies for the creator-merge-files bucket

-- Allow app clients to upload new merge files.
drop policy if exists "creator_merge_files_insert" on storage.objects;
create policy "creator_merge_files_insert"
on storage.objects
for insert
to anon, authenticated
with check (bucket_id = 'creator-merge-files');

-- Allow app clients to read the backed up files.
drop policy if exists "creator_merge_files_select" on storage.objects;
create policy "creator_merge_files_select"
on storage.objects
for select
to anon, authenticated
using (bucket_id = 'creator-merge-files');

-- Prevent client-side overwrite/update
drop policy if exists "creator_merge_files_update_block" on storage.objects;
create policy "creator_merge_files_update_block"
on storage.objects
for update
to anon, authenticated
using (false)
with check (false);

-- Prevent client-side delete
drop policy if exists "creator_merge_files_delete_block" on storage.objects;
create policy "creator_merge_files_delete_block"
on storage.objects
for delete
to anon, authenticated
using (false);
