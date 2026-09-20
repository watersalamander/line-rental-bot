// Backfill import: loads data/backfill/transactions_backfill.csv (transactions
// that happened while the bot was off) into Supabase. Unlike the one-off family
// import, rent rows also settle their invoice (`rent_month` → that period's
// invoice gets paid_amount/status updated, exactly like a slip would), so the
// dashboard and reminders stop treating those months as unpaid.
//
// DRY-RUN BY DEFAULT — prints the full plan and writes nothing:
//   npx tsx scripts/import-backfill.ts            (dry run)
//   npx tsx scripts/import-backfill.ts --commit   (write)
//
// Safe to re-run: a row whose (condo, date, direction, category, amount, note)
// already exists as a manual transaction is skipped.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { db } from '../src/db/client';
import { bangkokToday } from '../src/services/views';
import type { Invoice, Lease, Property } from '../src/db/types';

const COMMIT = process.argv.includes('--commit');
const FILE = resolve(process.cwd(), 'data/backfill/transactions_backfill.csv');
// Records in the DB stop here; anything dated earlier is probably a typo.
const GAP_START = '2026-07-01';

const CATEGORIES = new Set([
  'rent', 'common_fee', 'agency', 'maintenance',
  'tax', 'utilities', 'insurance', 'deposit', 'other',
]);

// ── CSV parsing (BOM- and quote-aware; same as import-family-data.ts) ──
function parseCsv(path: string): Record<string, string>[] {
  const text = readFileSync(path, 'utf8').replace(/^﻿/, '');
  const rows: string[][] = [];
  let field = '', row: string[] = [], inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); if (row.some((f) => f.trim() !== '')) rows.push(row); }
  const [header, ...data] = rows;
  return data.map((r) => Object.fromEntries(header!.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

// ── Dates ─────────────────────────────────────────────────────
// Excel rewrites ISO dates to the PC's locale on save, so a file is either
// all D/M/YYYY or all M/D/YYYY. Decide once from the unambiguous rows (a part
// > 12 can only be a day) and apply it to every row — never guess per row.
type SlashOrder = 'DMY' | 'MDY';

function detectSlashOrder(dates: string[]): SlashOrder {
  let dmy = false, mdy = false;
  for (const s of dates) {
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/\d{4}$/);
    if (!m) continue;
    if (Number(m[1]) > 12) dmy = true;
    if (Number(m[2]) > 12) mdy = true;
  }
  if (dmy && mdy) throw new Error('dates mix D/M/YYYY and M/D/YYYY — use YYYY-MM-DD instead');
  return mdy ? 'MDY' : 'DMY'; // Thai-locale Excel writes D/M/YYYY
}

function parseDate(s: string, order: SlashOrder): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) throw new Error(`bad date "${s}" (expected YYYY-MM-DD or D/M/YYYY)`);
  const [d, mo] = order === 'DMY' ? [m[1]!, m[2]!] : [m[2]!, m[1]!];
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) throw new Error(`bad date "${s}"`);
  return `${m[3]}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

/** rent_month (1–12) → 'YYYY-MM', picking the year that lands closest to the payment date. */
function rentPeriod(month: number, date: string): string {
  const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7));
  const best = [y - 1, y, y + 1]
    .map((yy) => ({ yy, dist: Math.abs((yy - y) * 12 + (month - m)) }))
    .sort((a, b) => a.dist - b.dist)[0]!;
  return `${best.yy}-${String(month).padStart(2, '0')}`;
}

function invoiceStatusFor(paid: number, due: number): Invoice['status'] {
  if (paid >= due) return 'paid';
  if (paid > 0) return 'partial';
  return 'open';
}

const baht = (n: number): string => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface PlanRow {
  line: number;
  property: Property | null; // null = family pool
  date: string;
  direction: 'in' | 'out';
  category: string;
  amount: number;
  note: string | null;
  lease: Lease | null;
  period: string | null;
}

async function main(): Promise<void> {
  const csv = parseCsv(FILE);
  const today = bangkokToday();
  console.log(`${COMMIT ? 'COMMIT' : 'DRY RUN'} — ${csv.length} rows in ${FILE}\n`);

  const { data: propData, error: pe } = await db.from('properties').select();
  if (pe) throw pe;
  const { data: leaseData, error: le } = await db.from('leases').select().eq('status', 'active');
  if (le) throw le;
  const properties = new Map((propData as Property[]).map((p) => [p.name, p]));
  const leases = leaseData as Lease[];

  // ── 1. Validate + resolve every row before writing anything ──
  const errors: string[] = [];
  const warnings: string[] = [];
  const skipped: string[] = [];
  const plan: PlanRow[] = [];
  const order = detectSlashOrder(csv.map((r) => r.date ?? ''));

  csv.forEach((r, i) => {
    const line = i + 2;
    const where = `row ${line}`;
    if (!r.date) {
      skipped.push(`${where}: no date → treated as NOT PAID, skipped (${r.property_name || 'กองกลาง'} ${r.category} ${r.amount})`);
      return;
    }
    try {
      const property = r.property_name ? properties.get(r.property_name) ?? null : null;
      if (r.property_name && !property) throw new Error(`unknown property "${r.property_name}"`);
      if (r.direction !== 'in' && r.direction !== 'out') throw new Error(`bad direction "${r.direction}"`);
      if (!CATEGORIES.has(r.category ?? '')) throw new Error(`bad category "${r.category}"`);
      const amount = Number((r.amount ?? '').replace(/,/g, ''));
      if (!Number.isFinite(amount) || amount <= 0) throw new Error(`bad amount "${r.amount}"`);
      const date = parseDate(r.date, order);
      if (date > today) throw new Error(`date ${date} is in the future`);
      if (date < GAP_START) warnings.push(`${where}: date ${date} is before the gap (${GAP_START}) — already recorded?`);

      let lease: Lease | null = null;
      let period: string | null = null;
      if (r.rent_month) {
        const month = Number(r.rent_month);
        if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error(`bad rent_month "${r.rent_month}"`);
        if (r.category !== 'rent' || r.direction !== 'in') throw new Error('rent_month only applies to in/rent rows');
        if (!property) throw new Error('rent_month needs a property_name');
        period = rentPeriod(month, date);
        lease = leases.find((l) =>
          l.property_id === property.id && l.start_date.slice(0, 7) <= period! && period! <= l.end_date.slice(0, 7)) ?? null;
        if (!lease) {
          warnings.push(`${where}: ${property.name} has NO active lease covering ${period} → recorded as income only, no invoice settled`);
        }
      } else if (r.category === 'rent' && r.direction === 'in') {
        warnings.push(`${where}: rent without rent_month → recorded as income only, no invoice settled`);
      }

      plan.push({ line, property, date, direction: r.direction, category: r.category!, amount, note: r.note || null, lease, period });
    } catch (e) {
      errors.push(`${where}: ${(e as Error).message}`);
    }
  });

  const keyOf = (p: { propertyId: string | null; date: string; direction: string; category: string; amount: number; note: string | null }): string =>
    [p.propertyId ?? 'pool', p.date, p.direction, p.category, p.amount.toFixed(2), p.note ?? ''].join('|');
  const seen = new Set<string>();
  for (const p of plan) {
    const k = keyOf({ ...p, propertyId: p.property?.id ?? null });
    if (seen.has(k)) errors.push(`row ${p.line}: identical to an earlier row — make the note different if both are real`);
    seen.add(k);
  }

  if (errors.length) {
    console.error(`✗ ${errors.length} error(s) — nothing written:\n  ${errors.join('\n  ')}`);
    process.exit(1);
  }

  // ── 2. Skip rows already imported (re-run safety) ─────────────
  const { data: existing, error: xe } = await db.from('transactions')
    .select('property_id, txn_datetime, direction, category, amount, note')
    .eq('source', 'manual').gte('txn_datetime', `${GAP_START}T00:00:00+07:00`);
  if (xe) throw xe;
  const existingKeys = new Set((existing ?? []).map((t) => keyOf({
    propertyId: t.property_id as string | null,
    // stored as <date>T12:00+07:00 → the UTC date is the same calendar day
    date: new Date(new Date(t.txn_datetime as string).getTime() + 7 * 3600_000).toISOString().slice(0, 10),
    direction: t.direction as string, category: t.category as string, amount: Number(t.amount), note: (t.note as string | null) ?? null,
  })));

  // ── 3. Apply (or describe) each row, in file order ────────────
  const invoiceCache = new Map<string, Invoice | null>(); // `${leaseId}:${period}`
  let inserted = 0, already = 0, sumIn = 0, sumOut = 0;

  for (const p of plan) {
    const label = `row ${p.line}  ${p.date}  ${p.property?.name ?? 'กองกลาง'}  ${p.direction} ${p.category} ${baht(p.amount)}`;
    if (existingKeys.has(keyOf({ ...p, propertyId: p.property?.id ?? null }))) {
      console.log(`= ${label}\n      already in DB → skipped`);
      already++;
      continue;
    }

    let invoice: Invoice | null = null;
    let invoiceNote = '';
    if (p.lease && p.period) {
      const ck = `${p.lease.id}:${p.period}`;
      if (!invoiceCache.has(ck)) {
        const { data, error } = await db.from('invoices').select().eq('lease_id', p.lease.id).eq('period_month', p.period).maybeSingle();
        if (error) throw error;
        invoiceCache.set(ck, (data as Invoice | null) ?? null);
      }
      invoice = invoiceCache.get(ck) ?? null;

      if (!invoice) {
        const row = {
          lease_id: p.lease.id, period_month: p.period, amount_due: Number(p.lease.rent_amount),
          due_date: `${p.period}-${String(p.lease.due_day).padStart(2, '0')}`,
        };
        if (COMMIT) {
          const { data, error } = await db.from('invoices').insert(row).select().single();
          if (error) throw error;
          invoice = data as Invoice;
        } else {
          invoice = { ...row, id: '(new)', paid_amount: 0, status: 'open' } as unknown as Invoice;
        }
        invoiceNote = ' (invoice created)';
      }

      const due = Number(invoice.amount_due);
      const before = Number(invoice.paid_amount);
      const after = Number((before + p.amount).toFixed(2));
      const status = invoiceStatusFor(after, due);
      if (before >= due) warnings.push(`row ${p.line}: invoice ${p.period} (${p.property!.name}) was ALREADY fully paid (${baht(before)}/${baht(due)}) — is this payment a duplicate of one already recorded?`);
      else if (after > due) warnings.push(`row ${p.line}: invoice ${p.period} (${p.property!.name}) becomes overpaid by ${baht(after - due)}`);
      invoiceNote = `invoice ${p.period}: paid ${baht(before)} → ${baht(after)} of ${baht(due)} [${invoice.status} → ${status}]${p.date > invoice.due_date ? ' (late)' : ''}${invoiceNote}`;

      if (COMMIT) {
        const { error } = await db.from('invoices').update({ paid_amount: after, status }).eq('id', invoice.id);
        if (error) throw error;
      }
      invoiceCache.set(ck, { ...invoice, paid_amount: after, status } as Invoice);
    }

    if (COMMIT) {
      const { error } = await db.from('transactions').insert({
        landlord_id: p.property?.landlord_id ?? null,
        property_id: p.property?.id ?? null,
        lease_id: p.lease?.id ?? null,
        invoice_id: invoice && p.lease ? invoice.id : null,
        direction: p.direction,
        category: p.category,
        amount: p.amount,
        txn_datetime: `${p.date}T12:00:00+07:00`,
        source: 'manual',
        verify_status: 'verified',
        note: p.note,
      });
      if (error) throw error;
    }
    inserted++;
    if (p.direction === 'in') sumIn += p.amount; else sumOut += p.amount;
    console.log(`+ ${label}${invoiceNote ? `\n      ${invoiceNote}` : ''}`);
  }

  // ── 4. Summary ────────────────────────────────────────────────
  console.log('');
  for (const s of skipped) console.log(`- ${s}`);
  for (const w of warnings) console.log(`! ${w}`);
  console.log(`\n${COMMIT ? 'WRITTEN' : 'WOULD WRITE'}: ${inserted} transactions (in ${baht(sumIn)} / out ${baht(sumOut)} / net ${baht(sumIn - sumOut)})` +
    `${already ? `, ${already} already present` : ''}${skipped.length ? `, ${skipped.length} skipped (no date)` : ''}`);
  if (!COMMIT) console.log('Nothing was written. Re-run with --commit to apply.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
