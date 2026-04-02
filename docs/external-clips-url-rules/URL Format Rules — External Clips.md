# URL Format Rules — External Clips
*Last updated: 30 March 2026*

---

## In-scope networks

### Instagram
**Valid formats**
```
https://www.instagram.com/reel/SHORTCODE/
https://www.instagram.com/tv/SHORTCODE/
```
- Shortcode: alphanumeric + _ and -, typically 11 characters
- Trailing / required
- /tv/ is a valid separate format (IGTV — different content from Reels, do not convert)

**Common invalid patterns → auto-fix applied**
| Invalid | Fix |
|---|---|
| .../reels/SHORTCODE/ | /reels/ → /reel/ |
| .../username/reel/SHORTCODE/ | Strip username prefix |
| .../reel/SHORTCODE (no trailing /) | Add / |
| .../reel/SHORTCODE?params | Strip params, add / |
| www.ww.instagram.com/... | Fix domain typo |
| .../p/SHORTCODE/ | /p/ → /reel/ |

---

### TikTok
**Valid format**
```
https://www.tiktok.com/@username/video/ID
```
- Video ID: numeric string (15–19 digits)
- No trailing /

**Common invalid patterns → auto-fix applied**
| Invalid | Fix |
|---|---|
| ...?lang=en or other query params | Strip all params |
| ...video/ID/ (trailing /) | Remove / |
| www.www.tiktok.com/... | Fix domain typo |

**Not fixable (manual review)**
- /photo/ posts — photo carousels, not videos; decide per case
- Creator profile URLs (no /video/) — wrong data, no clip
- Two URLs in the same field — corrupt entry

---

### YouTube
**Valid formats**
```
https://www.youtube.com/shorts/ID
https://youtu.be/ID
```
- Video ID: alphanumeric + _ and -, 11 characters
- No trailing /
- Both formats are equivalent and accepted

**Common invalid patterns → auto-fix applied**
| Invalid | Fix |
|---|---|
| youtube.com/watch?v=ID | → youtu.be/ID |
| www.youtu.be/ID | Strip www. |
| youtu.be/ID?feature=share or other params | Strip params |
| youtube.com/shorts/ID?params | Strip params |

**Not fixable (manual review)**
- Channel/user pages (/@username, /c/channel) — wrong data, no clip

---

### Pinterest
**Valid format**
```
https://www.pinterest.es/pin/ID/
```
- ID: numeric (279152876879867692) or encoded string (AbIFR-3jXswjUd16...) — both accepted
- Domain must be .es — all regional variants normalised to .es
- Trailing / required

**Common invalid patterns → auto-fix applied**
| Invalid | Fix |
|---|---|
| www.pinterest.com/pin/ID/ | .com → .es |
| mx.pinterest.com/pin/ID/ | Normalise to www.pinterest.es |
| pinterest.co.uk/pin/ID/ | Normalise to www.pinterest.es |
| .../pin/ID (no trailing /) | Add / |

---

### Bilibili
**Valid format**
```
https://www.bilibili.com/video/BVID/
```
- BVID: alphanumeric, starts with BV (e.g. BV1doQqB8EgM)
- Trailing / required

**Common invalid patterns → auto-fix applied**
| Invalid | Fix |
|---|---|
| .../video/BVID (no trailing /) | Add / |
| .../video/BVID?spm_id_from=... | Strip params, add / |

---

### Douyin
**Valid format**
```
https://www.douyin.com/video/ID
```
- Video ID: numeric string (19 digits, e.g. 7268613378711489832)
- No trailing /

**Common invalid patterns → auto-fix applied**
| Invalid | Fix |
|---|---|
| iesdouyin.com/share/video/ID/ | Extract ID → douyin.com/video/ID |
| douyin.com/user/USERID?modal_id=ID | Extract modal_id value → douyin.com/video/ID |
| v.douyin.com/SHORTCODE/ | Follow HTTP redirect → extract ID from iesdouyin.com destination |

**Not fixable**
- v.douyin.com/SHORTCODE/ where the redirect returns no video ID — link expired/deleted; set Link Not Working Anymore = Yes
- douyin.com/user/USERID with no modal_id — creator profile, no video; manual review

---

## Out-of-scope networks (no format rule enforced)

| Network | Reason |
|---|---|
| Kuaishou (kuaishou.com, live.kuaishou.com) | URL format changes frequently |
| Xiaohongshu (xiaohongshu.com) | URL structure has its own complexities |

---

## General rules (all networks)

1. No query parameters — strip all ?params from any URL
2. No www.ww. typo — applies to any domain; strip extra ww.
3. No duplicate records — when a broken URL and a clean URL point to the same clip, merge associations and properties onto the clean record and delete the duplicate
4. Trailing slash — required for Instagram, Pinterest, Bilibili; must NOT be present for TikTok, YouTube, Douyin
5. Link Not Working Anymore = Yes — set on records whose URL cannot be resolved (expired short links, deleted videos)

---

## Current compliance status

*As of 30 March 2026 — after bulk cleanup + 29 manual fixes*

**Overall: 99.85% compliant — 54,040 of 54,122 links pass the rules.**

| Network | Total | Valid | Issues | Compliance |
|---|---|---|---|---|
| Instagram | 28,846 | 28,818 | 28 | 99.9% |
| TikTok | 16,433 | 16,400 | 33 | 99.8% |
| YouTube | 2,386 | 2,383 | 3 | 99.9% |
| Pinterest | 1,474 | 1,473 | 1 | 99.9% |
| Bilibili | 843 | 842 | 1 | 99.9% |
| Douyin | 2,008 | 1,963 | 45 | 97.8% |
| Kuaishou * | 412 | 412 | 0 | 100.0% |
| Xiaohongshu * | 1,063 | 1,063 | 0 | 100.0% |
| Other * | 657 | 657 | 0 | 100.0% |
| **Total** | **54,122** | **54,040** | **82** | **99.85%** |

\* Out of scope — no rules enforced

### Remaining 82 non-compliant records (manual review)

| Network | Issue | Count |
|---|---|---|
| TikTok | Creator profile (no clip) | 25 |
| Instagram | Creator profile (no clip) | 18 |
| Douyin | User/creator page (no video) | 17 |
| Instagram | Other non-standard | 6 |
| TikTok | /photo/ post (not video) | 4 |
| YouTube | Channel page (no clip) | 3 |
| Instagram | /reels/ profile tab (no clip) | 2 |
| TikTok | Two URLs in same field | 2 |
| Bilibili | No /video/ path | 1 |
| Instagram | Stories link (wrong content) | 1 |
| Pinterest | Missing trailing / | 1 |
| TikTok | Other non-standard | 1 |
| TikTok | Trailing / | 1 |

All 82 are wrong data that cannot be auto-fixed — primarily creator/user profile URLs entered instead of clip links (62 of 82). See hubspot_non_compliant_remaining-updated.xlsx for the full list with all record details.
