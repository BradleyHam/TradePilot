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

export function parseNaturalLanguage(text: string): ParsedEntry {
  const trimmed = text.trim();
  const type = detectType(trimmed);

  const amount = extractAmount(trimmed);
  const hours = extractHours(trimmed);
  const jobName = extractJobName(trimmed);
  const clientName = extractClientName(trimmed);
  const supplier = type === 'expense' ? extractSupplier(trimmed) : undefined;
  const category = type === 'expense' ? guessCategory(trimmed) : undefined;

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
    description: trimmed,
    confidence,
  };
}
