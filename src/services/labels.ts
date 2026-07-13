/**
 * Human-readable condo label: the condo name alone, e.g. "The Esse Asoke"
 * (no unit number).
 *
 * Family/imported rows keep the real condo name in `name` with the unit in
 * `unit_no` (building is null) — we return `name` and drop the unit. Legacy
 * LIFF-created rows fold the unit into `name` already ("XYZ 12/34"), so we
 * strip a trailing folded unit to show the condo name alone.
 *
 * Returns '' only when there's nothing to show, letting callers fall back
 * (e.g. to the tenant's name).
 */
export function propertyLabel(p: {
  name?: string | null;
  building?: string | null;
  unit_no?: string | null;
}): string {
  const name = p.name?.trim() ?? '';
  const unit = p.unit_no?.trim() ?? '';
  // Legacy rows fold the unit into `name` ("XYZ 12/34") — strip it off.
  if (name && unit && name.endsWith(unit)) {
    return name.slice(0, -unit.length).trim() || name;
  }
  const building = p.building?.trim() ?? '';
  return name || building;
}
