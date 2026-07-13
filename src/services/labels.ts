/**
 * Human-readable condo label: property name followed by unit number, e.g.
 * "The Esse Asoke 333/23".
 *
 * Family/imported rows keep the real condo name in `name` with the unit in
 * `unit_no` (building is null) — those become "<name> <unit>". Legacy
 * LIFF-created rows fold the unit into `name` already ("XYZ 12/34"), so we
 * skip the join when the name already contains the unit to avoid repeating it.
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
  if (name && unit) return name.includes(unit) ? name : `${name} ${unit}`;
  const building = p.building?.trim() ?? '';
  return name || [building, unit].filter(Boolean).join(' ') || unit;
}
