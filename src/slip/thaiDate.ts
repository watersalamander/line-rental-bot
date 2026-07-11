// Deterministic parsing of Thai slip dates. Vision models routinely botch the
// Buddhist-era → Gregorian conversion and the Thai month abbreviations
// (มิ.ย. read as เม.ย. etc.), so the adapter asks for the printed text
// verbatim and this module does the calendar math in code.

const THAI_MONTHS: Record<string, number> = {
  // abbreviations, normalized by stripping dots/spaces
  'มค': 1, 'กพ': 2, 'มีค': 3, 'เมย': 4, 'พค': 5, 'มิย': 6,
  'กค': 7, 'สค': 8, 'กย': 9, 'ตค': 10, 'พย': 11, 'ธค': 12,
  // full names
  'มกราคม': 1, 'กุมภาพันธ์': 2, 'มีนาคม': 3, 'เมษายน': 4,
  'พฤษภาคม': 5, 'มิถุนายน': 6, 'กรกฎาคม': 7, 'สิงหาคม': 8,
  'กันยายน': 9, 'ตุลาคม': 10, 'พฤศจิกายน': 11, 'ธันวาคม': 12,
};

const EN_MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function monthFromToken(token: string): number | null {
  const thai = THAI_MONTHS[token.replace(/[.\s]/g, '')];
  if (thai) return thai;
  const en = EN_MONTHS[token.slice(0, 3).toLowerCase()];
  return en ?? null;
}

/**
 * Resolve a printed year to Gregorian. Thai slips print Buddhist Era (2569 or
 * short "69"); some apps print Gregorian. Two-digit years are ambiguous, so
 * pick the candidate closest to the current year.
 */
function resolveYear(y: number): number {
  if (y >= 2400) return y - 543; // 4-digit Buddhist Era
  if (y >= 1900) return y; // 4-digit Gregorian
  const be = y + 2500 - 543; // "69" → 2569 BE → 2026
  const ce = y + 2000; // "26" → 2026
  const now = new Date().getFullYear();
  return Math.abs(be - now) <= Math.abs(ce - now) ? be : ce;
}

/** Zero-width spaces/joiners, word-joiner, BOM, soft hyphen — OCR noise that breaks matching. */
export function stripInvisible(s: string): string {
  return s.replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, '');
}

const TIME_RE = /(\d{1,2})[:.](\d{2})(?::(\d{2}))?/;

function build(day: number, month: number, year: number, timeSrc: string): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const resolved = resolveYear(year);
  if (resolved < 2000 || resolved > 2100) return null;

  let hh = 0, mm = 0, ss = 0;
  const t = TIME_RE.exec(timeSrc);
  if (t) {
    hh = Number(t[1]);
    mm = Number(t[2]);
    ss = Number(t[3] ?? 0);
    if (/pm/i.test(timeSrc) && hh < 12) hh += 12;
    if (/am/i.test(timeSrc) && hh === 12) hh = 0;
    if (hh > 23 || mm > 59 || ss > 59) return null;
  }
  const p = (n: number) => String(n).padStart(2, '0');
  return `${resolved}-${p(month)}-${p(day)}T${p(hh)}:${p(mm)}:${p(ss)}+07:00`;
}

/**
 * Parse a slip's printed date/time (e.g. "21 มิ.ย. 69 07:20 น.",
 * "21 มิถุนายน 2569 07:20:33", "21/06/2569 07:20", "21 Jun 2026 07:20")
 * into ISO 8601 with the +07:00 offset. Returns null when unparseable.
 */
export function parseThaiSlipDate(text: string): string | null {
  const s = stripInvisible(text).trim();
  if (!s) return null;

  // "21 มิ.ย. 69 …" / "21 มิถุนายน 2569 …" / "21 Jun 26 …"
  let m = /(\d{1,2})\s*([ก-๙a-zA-Z][ก-๙a-zA-Z.\s]*?)\s*(\d{2,4})(?!\d)(.*)$/s.exec(s);
  if (m) {
    const month = monthFromToken((m[2] ?? '').trim());
    if (month) {
      const iso = build(Number(m[1]), month, Number(m[3]), m[4] ?? '');
      if (iso) return iso;
    }
  }

  // "21/06/2569 07:20" (also - or . separators)
  m = /(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})(?!\d)(.*)$/s.exec(s);
  if (m) {
    const iso = build(Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? '');
    if (iso) return iso;
  }

  return null;
}

/**
 * Sanity-normalize a model-produced ISO datetime (fallback path): strip
 * invisible characters and convert a Buddhist-era year the model failed to
 * convert (e.g. 2569-06-21) to Gregorian. Returns null if not ISO-shaped.
 */
export function normalizeModelIso(iso: string): string | null {
  const s = stripInvisible(iso).trim();
  const m = /^(\d{4})(-\d{2}-\d{2}[T ].+)$/.exec(s);
  if (!m) return null;
  const year = Number(m[1]);
  if (year >= 2400) return `${year - 543}${m[2]}`;
  return s;
}
