# notify-feedback

Supabase Edge Function that receives `feedback` insert webhooks and sends Telegram notifications.

## 1) Deploy function

```bash
supabase functions deploy notify-feedback
```

## 2) Set secrets

```bash
supabase secrets set TELEGRAM_BOT_TOKEN=your_bot_token
supabase secrets set TELEGRAM_CHAT_ID=your_chat_id
```

## 3) Create database webhook

In Supabase Dashboard:

1. Go to **Database** -> **Webhooks**
2. Create webhook:
   - Name: `feedback_insert_notify`
   - Table: `public.feedback`
   - Events: `INSERT`
   - Type: **Supabase Edge Functions**
   - Edge Function: `notify-feedback`

Now each new feedback row will trigger a Telegram notification.
