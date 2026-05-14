import { invoke } from "@tauri-apps/api/core";

export async function resolveOwnerId(token: string, email: string): Promise<string> {
  return invoke<string>("resolve_owner_id", { token, email: email.trim() });
}
