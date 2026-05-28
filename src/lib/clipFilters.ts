import type { Clip } from "@/types";
import {
  ASK_FIRST_LICENSE_NORMAL,
  type LicenseTypeOption,
  normaliseLicenseType,
} from "@/components/LicenseTypePicker";
import { getPlatform, type SupportedPlatform } from "@/lib/getPlatform";

/** Client-side license filter shared by SearchTab and the Autofill runner.
 *  - Empty `selected` matches everything.
 *  - When `requireAvailableAskFirst` is true AND the clip is "Ask First", the
 *    clip must also have `available_ask_first === true` in HubSpot. */
export function matchesLicenseFilters(
  clip: Pick<Clip, "licenseType" | "availableAskFirst">,
  selected: readonly LicenseTypeOption[],
  requireAvailableAskFirst = false,
): boolean {
  const lt = normaliseLicenseType(clip.licenseType);
  const matchesSelectedType =
    selected.length === 0 ||
    selected.some((opt) => normaliseLicenseType(opt) === lt);

  if (!matchesSelectedType) return false;

  if (requireAvailableAskFirst && lt === ASK_FIRST_LICENSE_NORMAL) {
    return clip.availableAskFirst === true;
  }

  return true;
}

/** True when the clip's URL maps to one of the requested provider names.
 *  Empty `providers` matches everything. */
export function matchesProvider(
  clip: Pick<Clip, "link">,
  providers: readonly SupportedPlatform[],
): boolean {
  if (providers.length === 0) return true;
  const platform = getPlatform(clip.link);
  if (platform === "Video") return false;
  return providers.includes(platform);
}

/** A numeric range filter (`min` / `max` inclusive). Undefined bounds are
 *  ignored. Returns true when the field is missing only if both bounds are
 *  undefined — otherwise a missing value fails the range check. */
export function matchesNumericRange(
  value: number | undefined,
  min: number | undefined,
  max: number | undefined,
): boolean {
  if (min === undefined && max === undefined) return true;
  if (value === undefined) return false;
  if (min !== undefined && value < min) return false;
  if (max !== undefined && value > max) return false;
  return true;
}

/** ISO date (`YYYY-MM-DD`) range. Same semantics as `matchesNumericRange`. */
export function matchesDateRange(
  value: string | undefined,
  from: string | undefined,
  to: string | undefined,
): boolean {
  if (!from && !to) return true;
  if (!value) return false;
  // ISO strings compare lexicographically when same-length.
  const v = value.slice(0, 10);
  if (from && v < from) return false;
  if (to && v > to) return false;
  return true;
}
