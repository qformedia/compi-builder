import { invoke } from "@tauri-apps/api/core";
import { MULTI_FILE_PROPERTY_KEYS } from "./diff";

export interface BackedUpFile {
  side: "a" | "b";
  property: string;
  hubspotFileId: string;
  name?: string;
  extension?: string;
  mime?: string;
  size?: number;
  storagePath?: string;
  hubspotUrl?: string;
  status: "ok" | "failed";
  error?: string;
}

export interface FileBackupResult {
  files: BackedUpFile[];
  failedCount: number;
}

export async function backupMergeFiles(
  token: string,
  pairKey: string,
  propsA: Record<string, string>,
  propsB: Record<string, string>,
): Promise<FileBackupResult> {
  const items: { fileId: string; side: "a" | "b"; property: string }[] = [];
  const seenIdsA = new Set<string>();
  const seenIdsB = new Set<string>();

  const collect = (props: Record<string, string>, side: "a" | "b", seenIds: Set<string>) => {
    for (const property of MULTI_FILE_PROPERTY_KEYS) {
      const raw = props[property];
      if (!raw) continue;
      const tokens = raw.split(/[;,\s]+/);
      for (const tok of tokens) {
        const fileId = tok.trim();
        if (fileId && !seenIds.has(fileId)) {
          seenIds.add(fileId);
          items.push({ fileId, side, property });
        }
      }
    }
  };

  collect(propsA, "a", seenIdsA);
  collect(propsB, "b", seenIdsB);

  if (items.length === 0) {
    return { files: [], failedCount: 0 };
  }

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  const bucket = import.meta.env.VITE_SUPABASE_CREATOR_MERGE_FILES_BUCKET || "creator-merge-files";

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("Supabase credentials missing from environment");
  }

  const files = await invoke<BackedUpFile[]>("backup_hubspot_files_to_supabase", {
    token,
    supabaseUrl,
    supabaseAnonKey,
    bucket,
    pairKey,
    items,
  });

  const failedCount = files.filter(f => f.status === "failed").length;
  return { files, failedCount };
}
