# MiniMiki Telegram bot

Single-file webhook + brain for `@minimiki_bot`, the CompiFlow team's
in-house Telegram assistant. Answers product questions (repo-grounded),
runs guided bug/feature intake, and writes a clean row to `public.feedback`
that fires the existing `notify-feedback` admin digest with Approve / Reject
buttons.

## Files in this folder

- `index.ts` — webhook entry. Verifies `X-Telegram-Bot-Api-Secret-Token`,
  routes message updates into `runConversation`, proxies callback_query
  updates to the sibling `telegram-callback` function.
- `bot.ts` — the brain. Session lookup/creation, history loading, LLM
  call (Vercel AI SDK + OpenAI-compatible provider), tool dispatch
  (`search_repo`, `read_file`, `submit_feedback`), Telegram helpers.
- `prompts.ts` — `buildSystemPrompt(ctx)` and the `MiniMiki knowledge`
  document embedded inline. Edit alongside `docs/minimiki-knowledge.md`
  to keep them in sync.
- `_pure.ts` — pure helpers (no Deno imports) so they're testable from
  vitest under Node.
- `_pure.test.ts` — vitest smoke test asserting the `submit_feedback`
  insert row shape (so it can't drift away from the migration).

## One-time setup

### 1. Create the bot in BotFather

In Telegram, talk to [@BotFather](https://t.me/botfather):

1. `/newbot` → name `MiniMiki`, username `minimiki_bot` (or whatever you
   set in `VITE_MINIMIKI_BOT_USERNAME`).
2. Save the bot token printed by BotFather → this is `TELEGRAM_BOT_TOKEN`.
3. `/setcommands` → paste:
   ```
   new - Start a fresh conversation
   help - What MiniMiki can do
   ```
4. `/setprivacy` → leave as **Enabled** (default). With privacy ON, the
   bot only sees messages that mention it, reply to it, or are slash
   commands — exactly what we want in the team group.

### 2. Discover the admin chat ID

Send a quick `/start` to the bot from your own Telegram account, then:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getUpdates"
```

Find your `chat.id` in the response. Set it as `ADMIN_TELEGRAM_CHAT_ID`
(used by `notify-feedback` for the digest + buttons, and as the default
for `TELEGRAM_CHAT_ID` if not set separately).

### 3. Configure secrets

Set the following in **Supabase Project → Edge Functions → Secrets** (or
via `supabase secrets set` locally):

| Secret | Used by | Notes |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | bot, callback, notify | from BotFather |
| `TELEGRAM_BOT_USERNAME` | bot | e.g. `minimiki_bot` (no `@`); used for group mention detection |
| `TELEGRAM_WEBHOOK_SECRET` | bot, callback | random ≥32-char string; sent as the `X-Telegram-Bot-Api-Secret-Token` header by Telegram |
| `ADMIN_TELEGRAM_CHAT_ID` | notify, callback | your personal Telegram chat ID |
| `TELEGRAM_CHAT_ID` | notify (legacy) | leave equal to `ADMIN_TELEGRAM_CHAT_ID` |
| `MINIMIKI_PROVIDER` | bot | label for the OpenAI-compatible provider, e.g. `deepseek` |
| `MINIMIKI_MODEL` | bot | model id, e.g. `deepseek-chat` |
| `MINIMIKI_API_KEY` | bot | the provider's API key |
| `MINIMIKI_BASE_URL` | bot | OpenAI-compatible base URL, e.g. `https://api.deepseek.com/v1` |
| `GITHUB_TOKEN` | bot | fine-grained PAT, **read-only** to the CompiFlow repo's Code + Contents |
| `GITHUB_REPO` | bot | `Quantastic/compi-builder` (or your fork) |
| `GITHUB_DEFAULT_BRANCH` | bot | `main` |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are auto-injected into
every Edge Function — you don't need to set them.

### 4. Deploy the functions

```bash
supabase functions deploy telegram-bot       --no-verify-jwt
supabase functions deploy telegram-callback  --no-verify-jwt
supabase functions deploy notify-feedback    --no-verify-jwt
```

`--no-verify-jwt` is required because Telegram doesn't speak Supabase JWT;
we authenticate inbound webhooks with `TELEGRAM_WEBHOOK_SECRET` instead.

### 5. Register the webhook

```bash
SUPABASE_PROJECT_REF=your-project-ref
WEBHOOK_URL="https://${SUPABASE_PROJECT_REF}.functions.supabase.co/telegram-bot"

curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{
    \"url\": \"$WEBHOOK_URL\",
    \"secret_token\": \"$TELEGRAM_WEBHOOK_SECRET\",
    \"allowed_updates\": [\"message\", \"edited_message\", \"callback_query\"]
  }"
```

Verify with:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo"
```

Telegram allows exactly one webhook per bot. `telegram-bot` is that
webhook; it proxies `callback_query` updates internally to
`telegram-callback`, so we only register one URL.

## Local testing

```bash
supabase functions serve telegram-bot --env-file ./supabase/.env.local
```

In another terminal, `ngrok http 54321` and point a temporary webhook at
the ngrok URL. Don't forget to flip the webhook back to production when
you're done.

The vitest smoke test runs from the repo root:

```bash
npm test -- supabase/functions/telegram-bot/_pure.test.ts
```

## Conversation flow recap

1. User DMs `@minimiki_bot` (or `@`-mentions it in the team group).
2. The bot greets and offers Question / Bug / Feature buttons.
3. For questions, it answers using `search_repo` + `read_file` against
   the repo on GitHub. No DB write.
4. For bugs/features, it asks 1–3 short clarifiers and confirms with the
   user before calling `submit_feedback`, which writes to
   `public.feedback` with `chat_session_id` linking back to the chat.
5. `notify-feedback` fires on insert: builds an admin digest including the
   last ~10 transcript turns and an inline keyboard with Approve / Reject.
6. Tapping a button hits `telegram-callback` (proxied via `telegram-bot`),
   which updates `feedback.status` and edits the admin message in place.

## Privacy notes

- Conversation transcripts live in `public.chat_messages`, RLS service-role
  only. They are read by the admin digest and not exposed to anon clients.
- App-handoff screenshots (PNG) live in the public `feedback-screenshots`
  Supabase Storage bucket under `minimiki-handoffs/`. They are uploaded
  with random 16-char filenames and referenced by a `minimiki_handoffs`
  token that is **deleted on first consumption**. There is no public
  index of the bucket.
- Hold **Shift** while clicking the **Ask MiniMiki** button in the app to
  skip the screenshot entirely; only the page name and project name are
  sent.
- The bot itself is reachable over the open Internet via its Telegram
  username; access control is by team group membership and 1:1 DMs the
  team initiates. Don't post sensitive secrets in the chat.

## V2 (designed, not built)

When you tap **Approve** on a feedback row, V2 dispatches a 3-stage Code
agent: Plan with Claude Opus → Build with GPT-5.1 → Review with Claude
Opus, opening a draft PR. The dispatch hook is a `TODO` marker inside
`supabase/functions/telegram-callback/index.ts` (search for `TODO(V2)`).
Until V2 ships, Approve simply flips `feedback.status` to `ai_processing`
and edits the admin message accordingly.
