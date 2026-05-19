# Flag potential duplicate pairs from an external script

CompiFlow's Duplicates page already auto-detects creator pairs that share a
canonical profile URL across Instagram / TikTok / YouTube columns. But some
duplicates can't be caught that way — different URLs that point to the same
person, freshly imported data still being cleaned up out-of-band, hand-curated
matches from another tool.

External cleanup scripts can flag those pairs directly in Supabase. They show
up at the top of the CompiFlow Duplicates page with a `Flagged by <name>`
badge so the team can resolve them through the normal merge / dismiss flow.

This page documents the contract.

## Schema contract

Insert (or upsert) a row in `public.duplicate_pair_resolutions` with:

| Column | Value |
|--------|-------|
| `pair_key` | `f"{min(a, b)}:{max(a, b)}"` — string compare, not numeric. `a < b` is required by a CHECK constraint. |
| `record_id_a` | HubSpot creator record id as a string. Must equal `min(a, b)`. |
| `record_id_b` | HubSpot creator record id as a string. Must equal `max(a, b)`. |
| `status` | `'pending'` |
| `source` | `'external-script:<your-script-name>'`. The Duplicates page renders the suffix verbatim in the `Flagged by …` badge, so keep it short and human-readable. |
| `flagged_at` | `now()` |
| `resolution_notes` | Optional free-form note (e.g. `'matched via display name + city'`). Shown to whoever resolves the pair. |

Append-only audit trail in `public.duplicate_pair_events`:

| Column | Value |
|--------|-------|
| `pair_key` | Same as above. |
| `actor` | Optional. Identifier for whatever ran the script (`'cleanup-script@host'`, an email, etc.). |
| `event_type` | `'flagged'` |
| `payload` | JSON `{ record_id_a, record_id_b, source, note? }` — same shape the CompiFlow Integrity button writes. |

### Skip rules (idempotency)

Scripts can re-run safely. Respect these states before writing:

- If the row exists with `status = 'resolved'` or `'dismissed'`: **don't touch it**. The team made a decision; re-flagging would reopen it. Log and move on.
- If the row exists with `status = 'pending'` or `'reopened'` and `source IS NOT NULL`: already flagged. Don't bump `flagged_at`, don't append a duplicate event.
- Otherwise: upsert the row and append the event.

## Python example

Uses the official `supabase-py` package. The service-role key is required because the table's RLS allows reads but the Integrity-side write rule was provisioned for the desktop app's anon-key context; the service role bypasses RLS for the cleanup script.

```python
import os
from supabase import create_client


def pair_key(record_id_a: str, record_id_b: str) -> tuple[str, str, str]:
    """Canonical (a, b, pair_key) honoring the table's `a < b` CHECK."""
    a, b = sorted([str(record_id_a), str(record_id_b)])
    return a, b, f"{a}:{b}"


def flag_potential_duplicate(
    sb,
    record_id_a: str,
    record_id_b: str,
    *,
    source: str,
    actor: str,
    note: str | None = None,
) -> str:
    """Flag a pair as a potential duplicate. Returns one of:
    'flagged', 'already-flagged', 'already-resolved', 'already-dismissed'.
    """
    a, b, pk = pair_key(record_id_a, record_id_b)
    if a == b:
        raise ValueError("Cannot flag a record as a duplicate of itself")

    existing = (
        sb.table("duplicate_pair_resolutions")
        .select("status, source")
        .eq("pair_key", pk)
        .maybe_single()
        .execute()
        .data
    )
    if existing:
        if existing["status"] == "resolved":
            return "already-resolved"
        if existing["status"] == "dismissed":
            return "already-dismissed"
        if existing["source"]:
            return "already-flagged"

    sb.table("duplicate_pair_events").insert(
        {
            "pair_key": pk,
            "actor": actor or None,
            "event_type": "flagged",
            "payload": {
                "record_id_a": a,
                "record_id_b": b,
                "source": source,
                **({"note": note} if note else {}),
            },
        }
    ).execute()

    sb.table("duplicate_pair_resolutions").upsert(
        {
            "pair_key": pk,
            "record_id_a": a,
            "record_id_b": b,
            "status": "pending",
            "source": source,
            "flagged_at": "now()",
            "resolution_notes": note,
        },
        on_conflict="pair_key",
    ).execute()
    return "flagged"


if __name__ == "__main__":
    sb = create_client(
        os.environ["SUPABASE_URL"],
        os.environ["SUPABASE_SERVICE_ROLE_KEY"],
    )
    pairs = [
        ("12345678901", "98765432109"),
        # ... more pairs ...
    ]
    for a, b in pairs:
        result = flag_potential_duplicate(
            sb,
            a,
            b,
            source="external-script:tastic-cleanup",
            actor="cleanup-script@host",
            note="Matched on display_name + city + first_post_date",
        )
        print(f"{a}:{b} → {result}")
```

## What appears in CompiFlow

When the desktop app next refreshes the Duplicates page:

- The flagged pair appears at the **top** of the pending list (sorted by `flagged_at desc` ahead of auto-detected pairs).
- It carries a `Flagged by <name>` badge (the part of `source` after `external-script:`).
- The side-by-side merge / "Not a duplicate" / Note flow works exactly the same as for auto-detected pairs. A successful merge writes `status='resolved'`, dropping the pair from the list and from the script's "already-flagged" branch next time.
- The `creator_id` matching also means the pair survives Force re-export — flag is independent of the cached CSV.

If one of the two records has been merged or deleted in HubSpot since the script flagged them, the Duplicates page falls back to showing the bare record id. The user can dismiss the pair (`Not a duplicate`) to clear it.
