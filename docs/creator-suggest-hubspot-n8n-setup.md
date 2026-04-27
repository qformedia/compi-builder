# Creator suggest — HubSpot & n8n (out-of-repo) setup

CompiFlow reads/writes these **External Clip** (object `2-192287471`) custom properties. Create them in HubSpot if not present:


| Internal name             | Type             | Notes                                 |
| ------------------------- | ---------------- | ------------------------------------- |
| `sk_creator_handle`       | Single-line text | Post author @handle or username       |
| `sk_creator_profile_url`  | Single-line text | Canonical profile URL                 |
| `sk_creator_display_name` | Single-line text | Optional display name from enrichment |
| `sk_creator_avatar`       | Single-line text | Optional avatar URL                   |
| `sk_last_enriched`        | Date / datetime  | When creator fields were last written |
| `sk_status`               | Single-line text | e.g. `ok` (written by n8n / app)      |


**n8n** `enrichClip` workflow: extend the Map + “apply” write step so the same SocialKit response that enriches metrics also `fillIfEmpty`’s the four `sk_creator_`* fields (Instagram: `data.author` / `data.authorLink`; TikTok: `username` / `authorMeta`). No extra SocialKit request.