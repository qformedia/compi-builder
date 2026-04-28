/**
 * HubSpot record URL builders for the EU1 portal.
 *
 * Centralised so we don't sprinkle the portal id and per-object-type ids
 * throughout the UI — change the portal here once and every link follows.
 */

const PORTAL_RECORD_BASE = "https://app-eu1.hubspot.com/contacts/146859718/record";

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
