-- MiniMiki chat schema
-- Adds conversation persistence (chat_sessions, chat_messages) for the @minimiki_bot
-- Telegram assistant, plus the short-lived `minimiki_handoffs` rows that bridge a
-- click in the CompiFlow desktop app to the bot's first reply.
-- Run in Supabase SQL Editor or via `supabase db push`.

create extension if not exists pgcrypto;

create table if not exists public.chat_sessions (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in (
    'telegram_dm',
    'telegram_group',
    'app_handoff'
  )),
  telegram_chat_id bigint,
  telegram_user_id bigint,
  telegram_user_name text,
  app_version text,
  status text not null default 'open' check (status in (
    'open',
    'closed',
    'converted_to_feedback'
  )),
  summary text,
  started_at timestamptz not null default now(),
  closed_at timestamptz
);

create index if not exists chat_sessions_active_lookup_idx
  on public.chat_sessions (telegram_chat_id, telegram_user_id, status);

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.chat_sessions (id) on delete cascade,
  role text not null check (role in ('system', 'user', 'assistant', 'tool')),
  content text,
  tool_name text,
  tool_input jsonb,
  tool_output jsonb,
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_session_idx
  on public.chat_messages (session_id, created_at);

create table if not exists public.minimiki_handoffs (
  token text primary key,
  screenshot_url text,
  context jsonb not null,
  expires_at timestamptz not null default now() + interval '5 minutes',
  created_at timestamptz not null default now()
);

create index if not exists minimiki_handoffs_expires_at_idx
  on public.minimiki_handoffs (expires_at);

alter table public.feedback
  add column if not exists chat_session_id uuid references public.chat_sessions (id);

create index if not exists feedback_chat_session_idx
  on public.feedback (chat_session_id);

-- RLS for chat tables: service role only. The bot runs server-side and uses
-- the service role key, so anon/authenticated never need direct access.
alter table public.chat_sessions enable row level security;
alter table public.chat_messages enable row level security;

drop policy if exists "chat_sessions_block_anon" on public.chat_sessions;
create policy "chat_sessions_block_anon"
on public.chat_sessions
for all
to anon, authenticated
using (false)
with check (false);

drop policy if exists "chat_messages_block_anon" on public.chat_messages;
create policy "chat_messages_block_anon"
on public.chat_messages
for all
to anon, authenticated
using (false)
with check (false);

-- RLS for minimiki_handoffs: anon may insert (the desktop app writes with the
-- existing anon key). Reads/updates/deletes are service-role only because the
-- bot consumes them via the Edge Function.
alter table public.minimiki_handoffs enable row level security;

drop policy if exists "minimiki_handoffs_insert_anon" on public.minimiki_handoffs;
create policy "minimiki_handoffs_insert_anon"
on public.minimiki_handoffs
for insert
to anon, authenticated
with check (true);

drop policy if exists "minimiki_handoffs_block_select_anon" on public.minimiki_handoffs;
create policy "minimiki_handoffs_block_select_anon"
on public.minimiki_handoffs
for select
to anon, authenticated
using (false);

drop policy if exists "minimiki_handoffs_block_update_anon" on public.minimiki_handoffs;
create policy "minimiki_handoffs_block_update_anon"
on public.minimiki_handoffs
for update
to anon, authenticated
using (false)
with check (false);

drop policy if exists "minimiki_handoffs_block_delete_anon" on public.minimiki_handoffs;
create policy "minimiki_handoffs_block_delete_anon"
on public.minimiki_handoffs
for delete
to anon, authenticated
using (false);
