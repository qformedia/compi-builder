-- Feedback & bug reporting schema
-- Run in Supabase SQL Editor or via `supabase db push`.

create extension if not exists pgcrypto;

create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('bug', 'feature')),
  title text not null check (char_length(title) between 3 and 150),
  description text not null check (char_length(description) between 10 and 5000),
  frequency text check (frequency in ('once', 'sometimes', 'always')),
  importance text check (importance in ('nice_to_have', 'important', 'critical')),
  reporter_name text check (reporter_name is null or char_length(reporter_name) <= 120),
  screenshots text[] not null default '{}'::text[],
  app_version text,
  os_info text,
  status text not null default 'new' check (status in ('new', 'triaging', 'ai_processing', 'test_ready', 'resolved')),
  ai_response jsonb,
  created_at timestamptz not null default now()
);

create index if not exists feedback_created_at_idx on public.feedback (created_at desc);
create index if not exists feedback_status_idx on public.feedback (status);
create index if not exists feedback_type_idx on public.feedback (type);

alter table public.feedback enable row level security;

-- App clients can submit feedback, but cannot read/update/delete rows.
drop policy if exists "feedback_insert_anon" on public.feedback;
create policy "feedback_insert_anon"
on public.feedback
for insert
to anon, authenticated
with check (true);

-- Optional admin read policy for service role usage (service role bypasses RLS anyway).
drop policy if exists "feedback_select_service_only" on public.feedback;
create policy "feedback_select_service_only"
on public.feedback
for select
to authenticated
using (false);

insert into storage.buckets (id, name, public)
values ('feedback-screenshots', 'feedback-screenshots', true)
on conflict (id) do update set public = excluded.public;

-- Allow uploads from app clients to the feedback screenshot bucket.
drop policy if exists "feedback_screenshots_insert" on storage.objects;
create policy "feedback_screenshots_insert"
on storage.objects
for insert
to anon, authenticated
with check (bucket_id = 'feedback-screenshots');

-- Public bucket: users can read uploaded screenshot URLs.
drop policy if exists "feedback_screenshots_select" on storage.objects;
create policy "feedback_screenshots_select"
on storage.objects
for select
to anon, authenticated
using (bucket_id = 'feedback-screenshots');

-- Prevent client-side overwrite/delete in this bucket.
drop policy if exists "feedback_screenshots_update_block" on storage.objects;
create policy "feedback_screenshots_update_block"
on storage.objects
for update
to anon, authenticated
using (false)
with check (false);

drop policy if exists "feedback_screenshots_delete_block" on storage.objects;
create policy "feedback_screenshots_delete_block"
on storage.objects
for delete
to anon, authenticated
using (false);
