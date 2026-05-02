import { ParsedEntry, EntryType, ExpenseCategory } from './types';

const EXPENSE_KEYWORDS = [
  'bought', 'buy', 'paid', 'purchase', 'purchased', 'spent', 'from', 'cost',
  'invoice', 'receipt', 'supply', 'supplies', 'hardware', 'trade', 'depot',
];

const INCOME_KEYWORDS = [
  'received', 'payment', 'paid us', 'cash in', 'deposit', 'transfer in', 'collected',
];

const HOURS_KEYWORDS = [
  'worked', 'work', 'spent', 'did', 'on site', 'hours', 'hour', 'hrs', 'hr',
];

const ENQUIRY_KEYWORDS = [
  'enquiry', 'inquiry', 'lead', 'interested', 'contact', 'rang', 'called', 'potential',
  'new client', 'message', 'emailed us',
];

const QUOTE_KEYWORDS = [
  'sent quote', 'quoted', 'quote sent', 'proposal sent', 'sent proposal',
];

const BILL_KEYWORDS = [
  'bill due', 'bill', 'due', 'owe', 'payment due', 'must pay', 'owing',
];

const CATEGORY_MAP: Record<string, ExpenseCategory> = {
  paint: 'paint',
  primer: 'paint',
  resene: 'paint',
  dulux: 'paint',
  porter: 'paint',
  'paint brush': 'tools',
  roller: 'tools',
  brush: 'tools',
  ladder: 'tools',
  tape: 'materials',
  drop: 'materials',
  cloth: 'materials',
  plastic: 'materials',
  scraper: 'tools',
  sander: 'tools',
  sandpaper: 'materials',
  filler: 'materials',
  putty: 'materials',
  fuel: 'fuel',
  petrol: 'fuel',
  diesel: 'fuel',
  gas: 'fuel',
  power: 'admin',
  phone: 'admin',
  internet: 'admin',
  software: 'software',
  xero: 'software',
  canva: 'software',
  rego: 'vehicle',
  wof: 'vehicle',
  service: 'vehicle',
  tyre: 'vehicle',
  tyres: 'vehicle',
  facebook: 'marketing',
  google: 'marketing',
  flyer: 'marketing',
  letterbox: 'marketing',
  sub: 'subcontractor',
  subcontractor: 'subcontractor',
  helper: 'labour',
  labour: 'labour',
};

function extractAmount(text: string): number | undefined {
  const match = text.match(/\$\s*([\d,]+(?:\.\d{1,2})?)/);
  if (match) {
    return parseFloat(match[1].replace(/,/g, ''));
  }
  const trailingMatch = text.match(/([\d,]+(?:\.\d{1,2})?)\s*(?:dollars?|bucks?)?$/i);
  if (trailingMatch) {
    const val = parseFloat(trailingMatch[1].replace(/,/g, ''));
    if (val > 0 && val < 1000000) return val;
  }
  return undefined;
}

function extractHours(text: string): number | undefined {
  const match = text.match(/(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?/i);
  if (match) return parseFloat(match[1]);
  return undefined;
}

function extractJobName(text: string): string | undefined {
  const patterns = [
    /(?:for|on|to)\s+(?:the\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+job/i,
    /(?:for|to)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:project|job|house|property)/i,
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:exterior|interior|job|project|repaint|repaint)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1];
  }
  return undefined;
}

function extractClientName(text: string): string | undefined {
  const patterns = [
    /(?:from|to|for)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+in/i,
    /(?:enquiry|inquiry|lead)\s+from\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
    /(?:quote|send|sent)\s+(?:quote\s+)?to\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1];
  }
  return undefined;
}

function extractSupplier(text: string): string | undefined {
  const supplierPatterns = [
    /from\s+([A-Za-z][\w\s]+?)(?:\s+for|\s+\$|\s+on|\s*$)/i,
  ];
  for (const p of supplierPatterns) {
    const m = text.match(p);
    if (m) {
      const candidate = m[1].trim();
      if (candidate.length < 30 && !candidate.toLowerCase().startsWith('the ')) {
        return candidate;
      }
    }
  }
  return undefined;
}

function guessCategory(text: string): ExpenseCategory {
  const lower = text.toLowerCase();
  for (const [keyword, category] of Object.entries(CATEGORY_MAP)) {
    if (lower.includes(keyword)) return category;
  }
  return 'other';
}

function detectType(text: string): EntryType {
  const lower = text.toLowerCase();

  if (QUOTE_KEYWORDS.some((k) => lower.includes(k))) return 'quote';
  if (ENQUIRY_KEYWORDS.some((k) => lower.includes(k))) return 'enquiry';
  if (INCOME_KEYWORDS.some((k) => lower.includes(k))) return 'income';
  if (BILL_KEYWORDS.some((k) => lower.includes(k))) return 'bill';

  const hasHours = extractHours(text) !== undefined;
  const hasExpenseKeyword = EXPENSE_KEYWORDS.some((k) => lower.includes(k));
  const hasHoursKeyword = HOURS_KEYWORDS.some((k) => lower.includes(k));

  if (hasHours && hasHoursKeyword && !hasExpenseKeyword) return 'hours';
  if (hasExpenseKeyword) return 'expense';
  if (hasHours) return 'hours';

  if (text.match(/\$\d/)) return 'expense';

  return 'note';
}

// Best-effort date extractor. Recognises:
//   - "yesterday", "today"
//   - "monday" / "tuesday" / ... (most recent past or current weekday)
//   - "on the 8th of April", "April 8", "8 April"
//   - "30/04/2026", "30/04", "30/4"
//   - ISO "2026-04-30"
// Returns YYYY-MM-DD or undefined. Year defaults to current.
function extractDate(text: string, now: Date = new Date()): string | undefined {
  const lower = text.toLowerCase();
  const iso = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  if (/\byesterday\b/.test(lower)) {
    const d = new Date(now); d.setDate(d.getDate() - 1);
    return iso(d);
  }
  if (/\btoday\b/.test(lower)) return iso(now);

  // ISO match — exact YYYY-MM-DD anywhere in the string
  const isoMatch = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;

  // Weekday name → most recent past instance (or today if it matches)
  const weekdays = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  for (let i = 0; i < weekdays.length; i++) {
    if (new RegExp(`\\b${weekdays[i]}\\b`).test(lower)) {
      const d = new Date(now);
      const today = d.getDay();
      let diff = today - i;
      if (diff < 0) diff += 7;
      d.setDate(d.getDate() - diff);
      return iso(d);
    }
  }

  // Month-name patterns: "8th of april", "april 8", "8 april"
  const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  for (let i = 0; i < months.length; i++) {
    const m = months[i];
    // Day-then-month: "8 april", "8th of april", "8th april"
    const dm = lower.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+${m}\\b`));
    if (dm) {
      const day = Number(dm[1]);
      // Year: assume current year, but if that date is in the future by
      // more than ~7 days, roll back to last year.
      let year = now.getFullYear();
      const candidate = new Date(year, i, day);
      if (candidate.getTime() - now.getTime() > 7 * 86_400_000) year--;
      const dd = new Date(year, i, day);
      return iso(dd);
    }
    // Month-then-day: "april 8", "april 8th"
    const md = lower.match(new RegExp(`\\b${m}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`));
    if (md) {
      const day = Number(md[1]);
      let year = now.getFullYear();
      const candidate = new Date(year, i, day);
      if (candidate.getTime() - now.getTime() > 7 * 86_400_000) year--;
      const dd = new Date(year, i, day);
      return iso(dd);
    }
  }

  // Numeric D/M/YYYY or D/M (NZ-style — day first)
  const dm = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (dm) {
    const day = Number(dm[1]);
    const month = Number(dm[2]);
    let yearStr = dm[3];
    let year = yearStr ? Number(yearStr) : now.getFullYear();
    if (yearStr && yearStr.length === 2) year = year < 70 ? 2000 + year : 1900 + year;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const dd = new Date(year, month - 1, day);
      return iso(dd);
    }
  }

  return undefined;
}

export function parseNaturalLanguage(text: string): ParsedEntry {
  const trimmed = text.trim();
  const type = detectType(trimmed);

  const amount = extractAmount(trimmed);
  const hours = extractHours(trimmed);
  const jobName = extractJobName(trimmed);
  const clientName = extractClientName(trimmed);
  const supplier = type === 'expense' ? extractSupplier(trimmed) : undefined;
  const category = type === 'expense' ? guessCategory(trimmed) : undefined;
  const entryDate = extractDate(trimmed);

  const confidence =
    type !== 'note' && (amount !== undefined || hours !== undefined)
      ? 'high'
      : type !== 'note'
      ? 'medium'
      : 'low';

  return {
    type,
    jobName,
    clientName,
    amount,
    hours,
    category,
    supplier,
    entryDate,
    description: trimmed,
    confidence,
  };
}
