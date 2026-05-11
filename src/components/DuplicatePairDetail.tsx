/**
 * Side-by-side detail view for a single duplicate pair.
 *
 * Both creators are fetched LIVE from HubSpot via `fetch_creators_batch`
 * (which now returns the full property set defined in
 * `helpers::full_creator_properties`). We do not rely on the cached CSV for
 * the comparison values — the cache can be hours old and this page exists
 * specifically to support a resolution decision, so always show the freshest
 * truth.
 *
 * Presence is broadcast via the parent's `roomRef.setActivePair(pairKey)`
 * call. We just consume the resulting `otherViewers` prop here. The local
 * viewer is excluded by the parent so the footer never shows your own name.
 *
 * v1: read-only. No "Mark resolved" / "Mark not-a-duplicate" buttons yet.
 */

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ExternalLink,
  Users,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  CREATOR_PROPERTY_LABELS,
  sortPropertiesForDiff,
  type PropDiff,
  type PropDiffBucket,
} from "@/lib/duplicates/diff";
import type { DuplicatePair } from "@/lib/duplicates/find-pairs";
import type { PresenceEntry } from "@/lib/duplicates/supabase";
import { hubspotCreatorUrl } from "@/lib/hubspot-urls";

interface CreatorRecord {
  id: string;
  properties: Record<string, string | null>;
}

interface FetchResponse {
  results: CreatorRecord[];
}

interface Props {
  pair: DuplicatePair;
  token: string;
  /** Local viewer's presence name; passed in only so we can sanity-check the
   *  list of other viewers (the parent already filters self out). */
  localUser: string;
  otherViewers: PresenceEntry[];
  onBack: () => void;
}

const BUCKET_LABEL: Record<PropDiffBucket, string> = {
  mismatch: "Differs",
  only_a: "Only on A",
  only_b: "Only on B",
  equal: "Identical",
};

const BUCKET_ROW_CLASS: Record<PropDiffBucket, string> = {
  mismatch: "bg-amber-50/40",
  only_a: "",
  only_b: "",
  equal: "",
};

const BUCKET_HEADER_CLASS: Record<PropDiffBucket, string> = {
  mismatch: "text-amber-700",
  only_a: "text-sky-700",
  only_b: "text-sky-700",
  equal: "text-muted-foreground",
};

export function DuplicatePairDetail({
  pair,
  token,
  localUser,
  otherViewers,
  onBack,
}: Props) {
  const [props, setProps] = useState<{ a: Record<string, string>; b: Record<string, string> } | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        if (!token) throw new Error("HubSpot token is not configured");
        const res = await invoke<FetchResponse>("fetch_creators_batch", {
          token,
          creatorIds: [pair.a.rid, pair.b.rid],
        });
        if (cancelled) return;
        const map = new Map(res.results.map((r) => [r.id, normalizeProps(r.properties)]));
        setProps({
          a: map.get(pair.a.rid) ?? {},
          b: map.get(pair.b.rid) ?? {},
        });
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pair.a.rid, pair.b.rid, token]);

  const diff = useMemo<PropDiff[]>(() => {
    if (!props) return [];
    return sortPropertiesForDiff(props.a, props.b);
  }, [props]);

  const groupedDiff = useMemo(() => {
    const groups: Record<PropDiffBucket, PropDiff[]> = {
      mismatch: [],
      only_a: [],
      only_b: [],
      equal: [],
    };
    for (const row of diff) groups[row.bucket].push(row);
    return groups;
  }, [diff]);

  // The parent already filters self out, but defence-in-depth: also drop any
  // accidental self-entry here in case the parent didn't have `localUser`
  // resolved by the time it rendered.
  const displayedViewers = useMemo(
    () => otherViewers.filter((v) => v.user !== localUser),
    [otherViewers, localUser],
  );

  const aName = pair.a.name || pair.a.rid;
  const bName = pair.b.name || pair.b.rid;

  return (
    <div className="h-full overflow-auto">
      <div className="w-full space-y-4 px-4 py-4">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 cursor-pointer px-2"
            onClick={onBack}
          >
            <ArrowLeft className="mr-1.5 h-4 w-4" />
            Back to duplicates
          </Button>
        </div>

        {/* "Why" card */}
        <Card>
          <CardHeader className="gap-1.5">
            <CardTitle className="text-base">Why this is a potential duplicate</CardTitle>
            <CardDescription className="text-xs">
              The same canonical {pair.network} URL was found across both records.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="capitalize">{pair.network}</Badge>
              <button
                type="button"
                onClick={() => void openUrl(pair.canonicalUrl)}
                className="inline-flex items-center gap-1 truncate text-primary hover:underline"
                title="Open canonical URL"
              >
                <span className="truncate">{pair.canonicalUrl}</span>
                <ExternalLink className="h-3 w-3 flex-shrink-0" />
              </button>
              {pair.source.map((s) => (
                <Badge key={s} variant="secondary" className="text-[10px]">
                  {humanizeSource(s)}
                </Badge>
              ))}
            </div>
            <div className="rounded-md bg-muted/40 px-3 py-2 text-xs">
              <span className="font-medium">{aName}</span>
              {pair.a.columns.length > 0 && (
                <> · <span className="text-muted-foreground">{pair.a.columns.join(", ")}</span></>
              )}
              <span className="mx-2 text-muted-foreground">==</span>
              <span className="font-medium">{bName}</span>
              {pair.b.columns.length > 0 && (
                <> · <span className="text-muted-foreground">{pair.b.columns.join(", ")}</span></>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Side-by-side */}
        {loading ? (
          <div className="space-y-2">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-10 animate-pulse rounded-md bg-muted/60" />
            ))}
          </div>
        ) : error ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
            <span className="min-w-0 break-words">{error}</span>
          </div>
        ) : (
          <Card className="overflow-hidden p-0">
            <CardHeader className="gap-1.5 px-4 py-3">
              <div className="grid grid-cols-[minmax(160px,200px)_1fr_1fr] items-center gap-3 text-sm">
                <CardTitle className="text-sm">Property</CardTitle>
                <CreatorHeader name={aName} rid={pair.a.rid} sideLabel="A" />
                <CreatorHeader name={bName} rid={pair.b.rid} sideLabel="B" />
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {(["mismatch", "only_a", "only_b", "equal"] as PropDiffBucket[]).map((bucket) => {
                const rows = groupedDiff[bucket];
                if (rows.length === 0) return null;
                return (
                  <section key={bucket} className="border-t first:border-t-0">
                    <div className="sticky top-0 z-10 border-b border-border/60 bg-muted px-4 py-1.5">
                      <span
                        className={cn(
                          "text-[11px] font-semibold uppercase tracking-wide",
                          BUCKET_HEADER_CLASS[bucket],
                        )}
                      >
                        {BUCKET_LABEL[bucket]}
                      </span>
                      <span className="ml-2 text-[11px] text-muted-foreground">
                        {rows.length}
                      </span>
                    </div>
                    <ul className="divide-y divide-border/60">
                      {rows.map((row) => (
                        <li
                          key={row.key}
                          className={cn(
                            "grid grid-cols-[minmax(160px,200px)_1fr_1fr] items-start gap-3 px-4 py-2 text-xs",
                            BUCKET_ROW_CLASS[row.bucket],
                          )}
                        >
                          <div className="font-medium text-foreground">{row.label}</div>
                          <PropValueCell value={row.valueA} />
                          <PropValueCell value={row.valueB} />
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
              {diff.length === 0 && (
                <div className="px-4 py-6 text-center text-xs text-muted-foreground">
                  Both creators are entirely empty. Open the records in HubSpot for the full picture.
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Other viewers footer */}
        {displayedViewers.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border bg-emerald-50/40 px-3 py-2 text-xs text-emerald-800">
            <Users className="h-3.5 w-3.5 flex-shrink-0" />
            <span>Other viewers right now:</span>
            {displayedViewers.map((v, i) => (
              <span key={`${v.user}-${i}`} className="inline-flex items-center gap-1">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
                {v.user}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CreatorHeader({
  name,
  rid,
  sideLabel,
}: {
  name: string;
  rid: string;
  sideLabel: "A" | "B";
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5">
        <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
          {sideLabel}
        </Badge>
        <span className="truncate text-sm font-medium">{name}</span>
        <button
          type="button"
          onClick={() => void openUrl(hubspotCreatorUrl(rid))}
          className="text-muted-foreground hover:text-foreground"
          title="Open in HubSpot"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="text-[11px] text-muted-foreground">id {rid}</div>
    </div>
  );
}

function PropValueCell({ value }: { value: string }) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  // Detect URLs for clickability — light heuristic, no protocol coercion.
  const isUrl = /^https?:\/\//i.test(value);
  if (isUrl) {
    return (
      <button
        type="button"
        onClick={() => void openUrl(value)}
        className="inline-flex items-start gap-1 break-all text-left text-primary hover:underline"
      >
        <span className="break-all">{value}</span>
        <ExternalLink className="mt-0.5 h-3 w-3 flex-shrink-0" />
      </button>
    );
  }
  return <span className="break-words text-foreground">{value}</span>;
}

function normalizeProps(props: Record<string, string | null>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(props)) {
    out[k] = v == null ? "" : String(v);
  }
  return out;
}

/** Map detector source codes to short user-facing chips on the why-card. */
function humanizeSource(s: string): string {
  switch (s) {
    case "canonical_collision":
      return "Same canonical URL";
    case "multi_url_collision":
      return "Inside a multi-URL cell";
    case "bare_handle_promotion":
      return "Bare handle promoted";
    default:
      return s;
  }
}

// Re-export the labels constant so consumers wanting to map property keys
// can avoid an extra import. (No-op cost; tree-shaken if unused.)
export { CREATOR_PROPERTY_LABELS };
