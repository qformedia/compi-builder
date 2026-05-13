/**
 * HubSpot record URL builders for the EU1 portal.
 *
 * Centralised so we don't sprinkle the portal id and per-object-type ids
 * throughout the UI — change the portal here once and every link follows.
 */

const PORTAL_ID = "146859718";
const PORTAL_BASE = `https://app-eu1.hubspot.com`;
const PORTAL_RECORD_BASE = `${PORTAL_BASE}/contacts/${PORTAL_ID}/record`;

const OBJECT_ID = {
  clip: "2-192287471",
  creator: "2-191972671",
  videoProject: "2-192286893",
} as const;

export function hubspotClipUrl(clipId: string): string {
  return `${PORTAL_RECORD_BASE}/${OBJECT_ID.clip}/${clipId}`;
}

export function hubspotCreatorUrl(creatorId: string): string {
  return `${PORTAL_RECORD_BASE}/${OBJECT_ID.creator}/${creatorId}`;
}

export function hubspotVideoProjectUrl(videoProjectId: string): string {
  return `${PORTAL_RECORD_BASE}/${OBJECT_ID.videoProject}/${videoProjectId}`;
}

/**
 * Direct link into HubSpot's File Preview view for a single file id.
 *
 * HubSpot file properties (e.g. `license_file`, `traceability_file`)
 * store numeric file ids. The canonical preview route on the EU1 portal
 * is `/file-preview/<portalId>/file/<fileId>/` — opens the file viewer
 * with the PDF/image inline, no Files-dashboard detour. Falls back to
 * the bare Files dashboard if we're handed an empty id so the link is
 * never a dead `/file-preview/.../file//` URL.
 */
export function hubspotFileUrl(fileId: string): string {
  const id = fileId.trim();
  if (!id) return `${PORTAL_BASE}/files/${PORTAL_ID}`;
  return `${PORTAL_BASE}/file-preview/${PORTAL_ID}/file/${encodeURIComponent(id)}/`;
}
