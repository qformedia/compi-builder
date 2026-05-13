/**
 * Supabase access for the Duplicates page.
 *
 * Two responsibilities:
 *
 *   1. `fetchResolutions(pairKeys)` reads `duplicate_pair_resolutions` so the
 *      list view can drop pairs already resolved/dismissed. The schema lives
 *      in `supabase/migrations/20260512100000_create_duplicate_pair_resolutions.sql`.
 *
 *   2. `joinDuplicatesRoom(user)` opens a single shared Supabase Realtime
 *      presence channel (`duplicates-room`) so multiple teammates can see who
 *      currently has which pair open. This is presence-only — no resolution
 *      writes flow through this module in v1, so two people can still race
 *      on edits in the same HubSpot record. The presence indicator is the
 *      lightweight first line of defence.
 *
 * v1 has NO write paths to either table. Resolution actions and the audit
 * log land in v2.
 */

import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import { invoke } from "@tauri-apps/api/core";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

/**
 * One stable client instance for this module. Realtime channels need a
 * persistent socket connection, so we don't want to recreate the client on
 * every call — that would tear down and re-establish the WebSocket each
 * time presence is touched.
 */
let cachedClient: SupabaseClient | null = null;
function getClient(): SupabaseClient {
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      "Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.",
    );
  }
  if (!cachedClient) {
    cachedClient = createClient(supabaseUrl, supabaseAnonKey, {
      realtime: {
        params: {
          // Realtime defaults to one event per second per channel; presence
          // is bursty (multiple users joining/leaving as views open/close)
          // so allow a slightly higher ceiling. Still well under the
          // Supabase free-tier quota.
          eventsPerSecond: 10,
        },
      },
    });
  }
  return cachedClient;
}

// ──────────────────────────────────────────────────────────────────────
// Resolutions
// ──────────────────────────────────────────────────────────────────────

export type DuplicatePairStatus =
  | "pending"
  | "resolved"
  | "dismissed"
  | "reopened";

export interface DuplicatePairResolution {
  pairKey: string;
  status: DuplicatePairStatus;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  resolutionNotes: string | null;
  winnerRecordId: string | null;
  updatedAt: Date;
}

interface ResolutionRow {
  pair_key: string;
  status: DuplicatePairStatus;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_notes: string | null;
  winner_record_id: string | null;
  updated_at: string;
}

function mapResolution(r: ResolutionRow): DuplicatePairResolution {
  return {
    pairKey: r.pair_key,
    status: r.status,
    resolvedBy: r.resolved_by,
    resolvedAt: r.resolved_at ? new Date(r.resolved_at) : null,
    resolutionNotes: r.resolution_notes,
    winnerRecordId: r.winner_record_id,
    updatedAt: new Date(r.updated_at),
  };
}

/**
 * Render a Supabase / PostgREST error in a way humans can read.
 *
 * Supabase client throws PostgrestError objects (`{ message, code, details,
 * hint }`) that are NOT JS Error instances, so naive `String(err)` produces
 * the infamous `[object Object]`. This helper surfaces the message and the
 * most useful extra context (code or hint) when present.
 */
export function describeSupabaseError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const e = err as {
      message?: unknown;
      code?: unknown;
      details?: unknown;
      hint?: unknown;
    };
    const parts: string[] = [];
    if (typeof e.message === "string" && e.message) parts.push(e.message);
    if (typeof e.details === "string" && e.details && e.details !== e.message) {
      parts.push(e.details);
    }
    if (typeof e.hint === "string" && e.hint) parts.push(`Hint: ${e.hint}`);
    if (typeof e.code === "string" && e.code) parts.push(`(code ${e.code})`);
    if (parts.length > 0) return parts.join(" — ");
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** True when a Supabase error means "the table or its schema cache is missing". */
function isMissingTableError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; message?: unknown };
  // PGRST205 = "Could not find the table 'public.X' in the schema cache"
  // 42P01 = Postgres "undefined_table"
  if (e.code === "PGRST205" || e.code === "42P01") return true;
  const msg = typeof e.message === "string" ? e.message.toLowerCase() : "";
  return (
    msg.includes("could not find the table") ||
    msg.includes("does not exist") ||
    msg.includes("schema cache")
  );
}

/**
 * Record a successful HubSpot merge for a duplicate pair.
 *
 * This is called AFTER the HubSpot merge endpoint has returned 2xx, so it's
 * doing two things:
 *
 *   1. Upserts the canonical state row in `duplicate_pair_resolutions` to
 *      `status='resolved'` with the winner id, who did it, and when. The
 *      table CHECK constraint requires `record_id_a < record_id_b` (the
 *      same canonical ordering as `pairKey`); we sort the inputs here so
 *      callers can pass the winner/loser pair in any order.
 *   2. Appends an immutable audit row to `duplicate_pair_events` with the
 *      winner/loser pair captured in the payload. The event_type 'merged'
 *      is enabled in the schema (see migration 20260512100000).
 *
 * The two writes are not in a transaction — Supabase's PostgREST surface
 * doesn't expose one and the merge has already happened anyway. We do the
 * audit insert first because if anything fails it's the safer half to
 * lose: the resolutions row is recoverable from the event log, but a
 * resolutions row without an event would silently lose attribution.
 *
 * Either failure surfaces to the caller with `describeSupabaseError` —
 * the UI treats a Supabase failure as a non-blocking warning since the
 * HubSpot side already succeeded.
 */
/** Lightweight associated-record shape mirroring the JSON returned by the
 *  Rust `fetch_creator_associations_batch` command. Carried into snapshots
 *  so the Merge History view can reconstruct the Associations card without
 *  touching HubSpot. */
export interface SnapshotAssociatedRecord {
  id: string;
  name?: string;
  [key: string]: string | undefined;
}

export interface SnapshotAssociations {
  videoProjects: SnapshotAssociatedRecord[];
  externalClips: SnapshotAssociatedRecord[];
}

export interface MergeSnapshotPayload {
  network: string;
  canonicalUrl: string;
  winnerName: string;
  loserName: string;
  winnerProps: Record<string, string>;
  loserProps: Record<string, string>;
  winnerAssociations: SnapshotAssociations | null;
  loserAssociations: SnapshotAssociations | null;
  /** Owner-id -> display-name map captured at merge time. Frozen here so the
   *  diff renders the same human label in the History view even if the
   *  owner is later renamed or deactivated in HubSpot. */
  ownersById: Record<string, string>;
}

export interface RecordMergeResolutionArgs {
  pairKey: string;
  winnerRecordId: string;
  loserRecordId: string;
  actor: string;
  /** Full pre-merge snapshot used by the History view. Required so we never
   *  end up with a "merged" event that has no archaeological row to back
   *  it. */
  snapshot: MergeSnapshotPayload;
}

export async function recordMergeResolution(
  args: RecordMergeResolutionArgs,
): Promise<void> {
  const client = getClient();
  const now = new Date().toISOString();

  // Sort to match the table CHECK (record_id_a < record_id_b) and the
  // pairKey shape `${min}:${max}`. Callers pass winner/loser semantics;
  // we don't assume one is alphabetically smaller than the other.
  const [recordIdA, recordIdB] =
    args.winnerRecordId < args.loserRecordId
      ? [args.winnerRecordId, args.loserRecordId]
      : [args.loserRecordId, args.winnerRecordId];

  const { error: eventErr } = await client.from("duplicate_pair_events").insert({
    pair_key: args.pairKey,
    actor: args.actor || null,
    event_type: "merged",
    payload: {
      winner_record_id: args.winnerRecordId,
      loser_record_id: args.loserRecordId,
    },
  });
  if (eventErr) throw eventErr;

  const { error: resErr } = await client
    .from("duplicate_pair_resolutions")
    .upsert(
      {
        pair_key: args.pairKey,
        record_id_a: recordIdA,
        record_id_b: recordIdB,
        status: "resolved",
        resolved_by: args.actor || null,
        resolved_at: now,
        resolution_notes: "Merged via Duplicates page",
        winner_record_id: args.winnerRecordId,
      },
      { onConflict: "pair_key" },
    );
  if (resErr) throw resErr;

  // Snapshot insert is last so a snapshot-table failure (e.g. migration not
  // applied yet on the user's Supabase project) never blocks the audit row
  // or the resolutions upsert above. The caller surfaces the error as a
  // non-blocking warning the same way it already does for the other two.
  const { error: snapErr } = await client
    .from("duplicate_merge_snapshots")
    .insert({
      pair_key: args.pairKey,
      merged_at: now,
      actor: args.actor || null,
      record_id_a: recordIdA,
      record_id_b: recordIdB,
      winner_record_id: args.winnerRecordId,
      loser_record_id: args.loserRecordId,
      winner_name: args.snapshot.winnerName || null,
      loser_name: args.snapshot.loserName || null,
      network: args.snapshot.network || null,
      canonical_url: args.snapshot.canonicalUrl || null,
      winner_props: args.snapshot.winnerProps,
      loser_props: args.snapshot.loserProps,
      winner_associations: args.snapshot.winnerAssociations,
      loser_associations: args.snapshot.loserAssociations,
      owners_by_id: args.snapshot.ownersById,
    });
  if (snapErr) throw snapErr;
}

// ──────────────────────────────────────────────────────────────────────
// Merge history (snapshots)
// ──────────────────────────────────────────────────────────────────────

/** Lightweight row shape used by the Merge History list view. Excludes the
 *  heavy props/associations/owners JSON columns. */
export interface MergeSnapshotSummary {
  id: string;
  pairKey: string;
  mergedAt: Date;
  actor: string | null;
  winnerRecordId: string;
  loserRecordId: string;
  winnerName: string | null;
  loserName: string | null;
  network: string | null;
  canonicalUrl: string | null;
}

/** Full snapshot row including the property bags + associations + owners
 *  map. Returned by `fetchMergeSnapshot` for the detail view. */
export interface MergeSnapshot extends MergeSnapshotSummary {
  recordIdA: string;
  recordIdB: string;
  winnerProps: Record<string, string>;
  loserProps: Record<string, string>;
  winnerAssociations: SnapshotAssociations | null;
  loserAssociations: SnapshotAssociations | null;
  ownersById: Record<string, string>;
}

interface MergeSnapshotSummaryRow {
  id: string;
  pair_key: string;
  merged_at: string;
  actor: string | null;
  winner_record_id: string;
  loser_record_id: string;
  winner_name: string | null;
  loser_name: string | null;
  network: string | null;
  canonical_url: string | null;
}

interface MergeSnapshotRow extends MergeSnapshotSummaryRow {
  record_id_a: string;
  record_id_b: string;
  winner_props: Record<string, string> | null;
  loser_props: Record<string, string> | null;
  winner_associations: SnapshotAssociations | null;
  loser_associations: SnapshotAssociations | null;
  owners_by_id: Record<string, string> | null;
}

const MERGE_SNAPSHOT_SUMMARY_COLUMNS =
  "id, pair_key, merged_at, actor, winner_record_id, loser_record_id, winner_name, loser_name, network, canonical_url";

const MERGE_SNAPSHOT_FULL_COLUMNS =
  `${MERGE_SNAPSHOT_SUMMARY_COLUMNS}, record_id_a, record_id_b, winner_props, loser_props, winner_associations, loser_associations, owners_by_id`;

function mapSnapshotSummary(r: MergeSnapshotSummaryRow): MergeSnapshotSummary {
  return {
    id: r.id,
    pairKey: r.pair_key,
    mergedAt: new Date(r.merged_at),
    actor: r.actor,
    winnerRecordId: r.winner_record_id,
    loserRecordId: r.loser_record_id,
    winnerName: r.winner_name,
    loserName: r.loser_name,
    network: r.network,
    canonicalUrl: r.canonical_url,
  };
}

function mapSnapshot(r: MergeSnapshotRow): MergeSnapshot {
  return {
    ...mapSnapshotSummary(r),
    recordIdA: r.record_id_a,
    recordIdB: r.record_id_b,
    winnerProps: r.winner_props ?? {},
    loserProps: r.loser_props ?? {},
    winnerAssociations: r.winner_associations,
    loserAssociations: r.loser_associations,
    ownersById: r.owners_by_id ?? {},
  };
}

/**
 * List recent merge snapshots, newest first. The table's `merged_at desc`
 * index makes this cheap. Returns an empty list (with a console warning)
 * when the snapshots table doesn't exist yet — keeps the History view
 * functional during the rollout window before the migration is applied.
 */
export async function fetchMergeHistory(
  opts: { limit?: number } = {},
): Promise<MergeSnapshotSummary[]> {
  const limit = opts.limit ?? 100;
  const client = getClient();
  const { data, error } = await client
    .from("duplicate_merge_snapshots")
    .select(MERGE_SNAPSHOT_SUMMARY_COLUMNS)
    .order("merged_at", { ascending: false })
    .limit(limit);
  if (error) {
    if (isMissingTableError(error)) {
      console.warn(
        "[duplicates] duplicate_merge_snapshots table not found; treating history as empty. " +
          "Apply the migration to enable the Merge History view.",
      );
      return [];
    }
    throw error;
  }
  return (data ?? []).map((row) => mapSnapshotSummary(row as MergeSnapshotSummaryRow));
}

/** Fetch a single snapshot by id, including the heavy property/association/
 *  owner JSON columns the detail view needs. Returns `null` when the row
 *  isn't found (e.g. the user follows a stale link). */
export async function fetchMergeSnapshot(
  id: string,
): Promise<MergeSnapshot | null> {
  const client = getClient();
  const { data, error } = await client
    .from("duplicate_merge_snapshots")
    .select(MERGE_SNAPSHOT_FULL_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) {
    if (isMissingTableError(error)) {
      console.warn(
        "[duplicates] duplicate_merge_snapshots table not found while loading snapshot.",
      );
      return null;
    }
    throw error;
  }
  if (!data) return null;
  return mapSnapshot(data as MergeSnapshotRow);
}

/**
 * Read the current resolution row for the given pair keys.
 *
 * Returns a Map keyed by `pairKey` so callers can do an O(1) lookup per
 * pair. Pairs with no row in the table are simply absent from the result —
 * the caller treats them as "pending".
 *
 * Chunks the IN clause to keep request URLs under PostgREST's limit on
 * very long filter lists.
 */
export async function fetchResolutions(
  pairKeys: string[],
): Promise<Map<string, DuplicatePairResolution>> {
  const result = new Map<string, DuplicatePairResolution>();
  if (pairKeys.length === 0) return result;

  const client = getClient();
  const CHUNK = 200;
  for (let i = 0; i < pairKeys.length; i += CHUNK) {
    const chunk = pairKeys.slice(i, i + CHUNK);
    const { data, error } = await client
      .from("duplicate_pair_resolutions")
      .select(
        "pair_key, status, resolved_by, resolved_at, resolution_notes, winner_record_id, updated_at",
      )
      .in("pair_key", chunk);
    if (error) {
      // The migration in
      // supabase/migrations/20260512100000_create_duplicate_pair_resolutions.sql
      // may not be deployed yet on the user's Supabase project. Treat that
      // case as "no resolutions persisted" so the page still shows pairs —
      // we just can't filter resolved/dismissed ones until the table exists.
      if (isMissingTableError(error)) {
        console.warn(
          "[duplicates] duplicate_pair_resolutions table not found; treating as empty. " +
            "Apply the migration to enable resolution-status filtering.",
        );
        return result;
      }
      throw error;
    }
    for (const row of (data ?? []) as ResolutionRow[]) {
      result.set(row.pair_key, mapResolution(row));
    }
  }
  return result;
}

// ──────────────────────────────────────────────────────────────────────
// Presence
// ──────────────────────────────────────────────────────────────────────

export interface PresenceEntry {
  user: string;
  pairKey: string;
  joinedAt: number;
}

export interface DuplicatesRoom {
  /** All entries currently present, keyed by pair key. Includes the local user. */
  presence: Map<string, PresenceEntry[]>;
  /** Identifier for the local viewer (matches every PresenceEntry.user we publish). */
  user: string;
  /** Switch which pair (if any) the local viewer is broadcasting on. */
  setActivePair(pairKey: string | null): void;
  /** Subscribe to presence updates. Returns an unsubscribe function. */
  subscribe(cb: (presence: Map<string, PresenceEntry[]>) => void): () => void;
  /** Tear down the channel. After calling, the room cannot be reused. */
  leave(): void;
}

const ROOM_NAME = "duplicates-room";

/**
 * Derive the presence display name from an owner email.
 *
 * `miguel.tolosa@quantastic.tv` → `miguel.tolosa`
 *
 * The whole-domain stripping is intentional — every Quantastic teammate
 * uses the same `@quantastic.tv` domain so the suffix carries no signal,
 * just visual noise.
 */
export function presenceUserFromEmail(ownerEmail: string): string {
  const trimmed = ownerEmail.trim();
  if (!trimmed) return "";
  const at = trimmed.indexOf("@");
  return at < 0 ? trimmed : trimmed.slice(0, at);
}

/**
 * Resolve the presence display name. Prefers `ownerEmail` (stripped of its
 * `@domain`); falls back to the OS username from the Tauri backend; finally
 * to `"anonymous"`. Never throws — presence is best-effort.
 */
export async function resolvePresenceUser(ownerEmail: string): Promise<string> {
  const fromEmail = presenceUserFromEmail(ownerEmail);
  if (fromEmail) return fromEmail;
  try {
    const fromOs = await invoke<string>("current_os_username");
    if (fromOs && fromOs.trim()) return fromOs.trim();
  } catch {
    // Tauri unavailable (browser preview, tests). Fall through.
  }
  return "anonymous";
}

/**
 * Join the global duplicates presence channel as `user`. The returned
 * room exposes a snapshot of who's looking at what right now, lets the
 * caller change which pair the local viewer is broadcasting on, and lets
 * the caller subscribe to updates.
 *
 * Always pair with `room.leave()` on teardown so the WebSocket and
 * presence entry are cleaned up promptly.
 */
export function joinDuplicatesRoom(user: string): DuplicatesRoom {
  const client = getClient();
  // Each browser/window gets a unique presence key so the same user opening
  // CompiFlow in two windows shows up as one entry per window (which is the
  // honest semantic — they could be looking at different pairs).
  const presenceKey = `${user}:${crypto.randomUUID()}`;
  const channel: RealtimeChannel = client.channel(ROOM_NAME, {
    config: { presence: { key: presenceKey } },
  });

  const presence = new Map<string, PresenceEntry[]>();
  const subscribers = new Set<(p: Map<string, PresenceEntry[]>) => void>();
  let activePair: string | null = null;
  let subscribed = false;
  let pendingTrack = false;

  function refreshFromState() {
    const state = channel.presenceState() as Record<
      string,
      Array<PresenceEntry>
    >;
    presence.clear();
    for (const entries of Object.values(state)) {
      for (const entry of entries) {
        if (!entry || !entry.pairKey) continue;
        const list = presence.get(entry.pairKey) ?? [];
        list.push(entry);
        presence.set(entry.pairKey, list);
      }
    }
    notify();
  }

  function notify() {
    for (const cb of subscribers) {
      try {
        cb(presence);
      } catch (err) {
        console.error("Duplicates presence subscriber threw:", err);
      }
    }
  }

  function applyTrack() {
    if (!subscribed) {
      pendingTrack = true;
      return;
    }
    if (activePair) {
      void channel.track({
        user,
        pairKey: activePair,
        joinedAt: Date.now(),
      } satisfies PresenceEntry);
    } else {
      void channel.untrack();
    }
  }

  channel
    .on("presence", { event: "sync" }, refreshFromState)
    .on("presence", { event: "join" }, refreshFromState)
    .on("presence", { event: "leave" }, refreshFromState)
    .subscribe((status) => {
      if (status === "SUBSCRIBED") {
        subscribed = true;
        if (pendingTrack) {
          pendingTrack = false;
          applyTrack();
        }
      }
    });

  return {
    presence,
    user,
    setActivePair(pairKey: string | null) {
      if (pairKey === activePair) return;
      activePair = pairKey;
      applyTrack();
    },
    subscribe(cb) {
      subscribers.add(cb);
      // Fire immediately so consumers get the current state without
      // waiting for the next presence event.
      try {
        cb(presence);
      } catch (err) {
        console.error("Duplicates presence subscriber threw:", err);
      }
      return () => {
        subscribers.delete(cb);
      };
    },
    leave() {
      activePair = null;
      subscribers.clear();
      void channel.unsubscribe();
    },
  };
}
