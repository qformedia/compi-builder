# telegram-callback Edge Function

Handles the `Approve` / `Reject` inline-keyboard taps on the admin DM
sent by `notify-feedback`.

This function is **not** registered as a Telegram webhook directly.
Telegram only allows one webhook per bot, so all updates land at
`telegram-bot`, which proxies `callback_query` updates here.

## Actions

- `approve:<feedback_id>` — flips `feedback.status` to `ai_processing`,
  edits the admin message in place to include "Approved by <reviewer>",
  and leaves a `TODO(V2)` marker for the future Cursor Background Agent
  dispatch (Plan / Build / Review pipeline).
- `reject:<feedback_id>` — flips `feedback.status` to `resolved`, sets
  `ai_response.outcome = "rejected"` with a timestamp, edits the admin
  message in place to include "Rejected by <reviewer>".

## Secrets

- `TELEGRAM_BOT_TOKEN` — required.
- `TELEGRAM_WEBHOOK_SECRET` — same value as `telegram-bot`. Verified on
  every inbound POST.
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — auto-injected by Supabase.

## Deploy

```bash
supabase functions deploy telegram-callback --no-verify-jwt
```

See `../telegram-bot/README.md` for the full setup walkthrough.
