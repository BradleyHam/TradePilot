'use client';

import { useMemo, useState } from 'react';
import { PageHeader } from '@/components/shared/page-header';
import { useStore } from '@/lib/store';
import type { PaintStockItem, PaintStockKind, PaintStockLocation } from '@/lib/types';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import {
  Plus, Minus, Paintbrush, Car, Warehouse, AlertTriangle, Trash2,
} from 'lucide-react';
import { cn } from '@/lib/utils';

// ── Constants ────────────────────────────────────────────────────────────────

// Below this many litres a volume-tracked item counts as "low" and gets
// the amber treatment. Test pots and spray cans (litres undefined) never
// count — presence is what matters for those. Derived here, never stored,
// so there's no flag to forget to update.
const LOW_LITRES = 1;

// Display order + labels for the kind groups. Topcoats first (what you
// reach for most), consumable sealers/primers in the middle, test pots
// (long tail of tiny rows) last.
const KIND_ORDER: PaintStockKind[] = [
  'topcoat', 'enamel', 'ceiling', 'primer_sealer', 'stain', 'other', 'test_pot',
];
const KIND_LABELS: Record<PaintStockKind, string> = {
  topcoat: 'Topcoats',
  enamel: 'Enamels',
  ceiling: 'Ceiling',
  primer_sealer: 'Primers & sealers',
  stain: 'Stains',
  test_pot: 'Test pots',
  other: 'Other',
};
// Short singular labels for the edit sheet's kind chips.
const KIND_CHIP_LABELS: Record<PaintStockKind, string> = {
  topcoat: 'Topcoat',
  enamel: 'Enamel',
  ceiling: 'Ceiling',
  primer_sealer: 'Primer/sealer',
  stain: 'Stain',
  test_pot: 'Test pot',
  other: 'Other',
};

type FilterValue = 'all' | PaintStockLocation | 'low';

// ── Helpers ──────────────────────────────────────────────────────────────────

function isLow(item: PaintStockItem): boolean {
  return item.kind !== 'test_pot' && item.litres !== undefined && item.litres <= LOW_LITRES;
}

function formatLitres(litres: number): string {
  // 0.5 → "0.5 L", 7 → "7 L", 1.25 → "1.25 L"
  const s = Number.isInteger(litres) ? String(litres) : String(Math.round(litres * 100) / 100);
  return `${s} L`;
}

/** "Flax Pod — Lumbersider" or just "Wallboard sealer" for untinted. */
function itemTitle(item: PaintStockItem): string {
  return item.color || item.product;
}
function itemSubtitle(item: PaintStockItem): string {
  const parts: string[] = [];
  // When the colour is the title, the product line moves to the subtitle.
  if (item.color) parts.push(item.product);
  if (item.brand) parts.push(item.brand);
  return parts.join(' · ');
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function StockPage() {
  const { paintStock, updatePaintStock, loading } = useStore();
  const [filter, setFilter] = useState<FilterValue>('all');
  // Sheet state: 'new' opens an empty form; an item opens it pre-filled.
  const [editing, setEditing] = useState<PaintStockItem | 'new' | null>(null);

  const lowCount = useMemo(() => paintStock.filter(isLow).length, [paintStock]);
  const totalLitres = useMemo(
    () => paintStock.reduce((sum, p) => sum + (p.kind !== 'test_pot' ? (p.litres ?? 0) : 0), 0),
    [paintStock],
  );

  const filtered = useMemo(() => {
    switch (filter) {
      case 'garage': return paintStock.filter((p) => p.location === 'garage');
      case 'van': return paintStock.filter((p) => p.location === 'van');
      case 'low': return paintStock.filter(isLow);
      default: return paintStock;
    }
  }, [paintStock, filter]);

  // Group by kind in fixed order; alphabetical by title inside a group so
  // the same colour is always in the same place.
  const groups = useMemo(() => {
    return KIND_ORDER
      .map((kind) => ({
        kind,
        items: filtered
          .filter((p) => p.kind === kind)
          .sort((a, b) => itemTitle(a).localeCompare(itemTitle(b))),
      }))
      .filter((g) => g.items.length > 0);
  }, [filtered]);

  const chips: { value: FilterValue; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'garage', label: 'Garage' },
    { value: 'van', label: 'Van' },
    { value: 'low', label: lowCount > 0 ? `Low (${lowCount})` : 'Low' },
  ];

  return (
    <div className="pb-24 md:pb-8 md:max-w-2xl">
      <PageHeader
        title="Paint stock"
        subtitle={
          paintStock.length > 0
            ? `${paintStock.length} items · ~${formatLitres(totalLitres)} on hand${lowCount > 0 ? ` · ${lowCount} low` : ''}`
            : 'What paint is in the garage and van'
        }
        action={
          <button
            onClick={() => setEditing('new')}
            className="flex items-center gap-1.5 h-11 px-4 rounded-xl bg-primary text-primary-foreground text-sm font-semibold active:scale-95 transition-transform"
          >
            <Plus size={16} strokeWidth={2.2} />
            Add
          </button>
        }
      />

      {/* Filter chips */}
      <div className="flex gap-2 px-4 md:px-6 pb-3 overflow-x-auto">
        {chips.map(({ value, label }) => (
          <button
            key={value}
            onClick={() => setFilter(value)}
            className={cn(
              'shrink-0 h-9 px-4 rounded-full text-sm font-medium border transition-colors',
              filter === value
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-card text-muted-foreground border-border hover:text-foreground',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* List */}
      <div className="px-4 md:px-6 space-y-5">
        {loading && paintStock.length === 0 && (
          <p className="text-sm text-muted-foreground py-8 text-center">Loading…</p>
        )}

        {!loading && filtered.length === 0 && (
          <div className="flex flex-col items-center gap-3 py-14 text-center">
            <div className="w-12 h-12 rounded-2xl bg-muted flex items-center justify-center">
              <Paintbrush size={22} className="text-muted-foreground" strokeWidth={1.8} />
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">
                {paintStock.length === 0 ? 'No paint in stock yet' : 'Nothing matches this filter'}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {paintStock.length === 0
                  ? 'Add what’s in the garage and van to start tracking.'
                  : 'Try another filter.'}
              </p>
            </div>
          </div>
        )}

        {groups.map(({ kind, items }) => (
          <section key={kind}>
            <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
              {KIND_LABELS[kind]}
            </h2>
            <div className="bg-card border border-border rounded-2xl divide-y divide-border overflow-hidden">
              {items.map((item) => (
                <StockRow
                  key={item.id}
                  item={item}
                  showLocation={filter === 'all' || filter === 'low'}
                  onOpen={() => setEditing(item)}
                  onAdjust={(delta) => {
                    const next = Math.max(0, Math.round(((item.litres ?? 0) + delta) * 100) / 100);
                    updatePaintStock(item.id, { litres: next });
                  }}
                />
              ))}
            </div>
          </section>
        ))}
      </div>

      <StockItemSheet
        key={editing === 'new' ? 'new' : editing?.id ?? 'closed'}
        editing={editing}
        onClose={() => setEditing(null)}
      />
    </div>
  );
}

// ── Row ──────────────────────────────────────────────────────────────────────

function StockRow({
  item, showLocation, onOpen, onAdjust,
}: {
  item: PaintStockItem;
  showLocation: boolean;
  onOpen: () => void;
  onAdjust: (delta: number) => void;
}) {
  const low = isLow(item);
  const hasVolume = item.litres !== undefined;

  return (
    <div className="flex items-center gap-2 pl-4 pr-2 py-1.5 min-h-[56px]">
      {/* Tap target for editing — everything except the steppers */}
      <button onClick={onOpen} className="flex-1 min-w-0 flex items-center gap-2 py-2 text-left">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground truncate">
            {itemTitle(item)}
          </p>
          {(itemSubtitle(item) || item.notes) && (
            <p className="text-xs text-muted-foreground truncate mt-0.5">
              {[itemSubtitle(item), item.notes].filter(Boolean).join(' · ')}
            </p>
          )}
        </div>
        {showLocation && item.location === 'van' && (
          <Car size={14} className="shrink-0 text-muted-foreground" strokeWidth={1.8} />
        )}
        {low && (
          <AlertTriangle size={14} className="shrink-0 text-amber-500" strokeWidth={2} />
        )}
      </button>

      {/* Litres + steppers. Test pots / spray cans have no volume — the
          row is presence-only and edited via the sheet. */}
      {hasVolume ? (
        <div className="flex items-center shrink-0">
          <button
            onClick={() => onAdjust(-0.5)}
            aria-label="Used half a litre"
            className="w-11 h-11 flex items-center justify-center rounded-xl text-muted-foreground hover:text-foreground hover:bg-muted active:scale-90 transition-all"
          >
            <Minus size={16} strokeWidth={2.2} />
          </button>
          <span
            className={cn(
              'w-14 text-center text-sm font-semibold tabular-nums',
              low ? 'text-amber-600' : 'text-foreground',
            )}
          >
            {formatLitres(item.litres!)}
          </span>
          <button
            onClick={() => onAdjust(0.5)}
            aria-label="Added half a litre"
            className="w-11 h-11 flex items-center justify-center rounded-xl text-muted-foreground hover:text-foreground hover:bg-muted active:scale-90 transition-all"
          >
            <Plus size={16} strokeWidth={2.2} />
          </button>
        </div>
      ) : (
        <span className="w-14 text-center text-xs text-muted-foreground shrink-0 mr-1">
          {item.kind === 'test_pot' ? 'pot' : '—'}
        </span>
      )}
    </div>
  );
}

// ── Add / edit sheet ─────────────────────────────────────────────────────────

const inputCls =
  'w-full h-11 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring';
const labelCls =
  'text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1 block';

function StockItemSheet({
  editing, onClose,
}: {
  editing: PaintStockItem | 'new' | null;
  onClose: () => void;
}) {
  const { addPaintStock, updatePaintStock, deletePaintStock } = useStore();
  const isNew = editing === 'new';
  const item = isNew || editing === null ? null : editing;

  const [product, setProduct] = useState(item?.product ?? '');
  const [brand, setBrand] = useState(item?.brand ?? '');
  const [color, setColor] = useState(item?.color ?? '');
  const [kind, setKind] = useState<PaintStockKind>(item?.kind ?? 'topcoat');
  const [litresStr, setLitresStr] = useState(item?.litres !== undefined ? String(item.litres) : '');
  const [location, setLocation] = useState<PaintStockLocation>(item?.location ?? 'garage');
  const [notes, setNotes] = useState(item?.notes ?? '');
  // Two-tap delete: first tap arms, second confirms. No modal in the way.
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const open = editing !== null;

  // Forgive bad input: "3", "3.5", "3,5", " 3l ", "3 L" all parse.
  function parseLitres(s: string): number | undefined {
    const cleaned = s.replace(',', '.').replace(/[^0-9.]/g, '').trim();
    if (cleaned === '') return undefined;
    const n = Number(cleaned);
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : undefined;
  }

  async function handleSave() {
    const trimmedProduct = product.trim();
    if (!trimmedProduct) {
      setFormError('Needs a product name — e.g. "Lumbersider" or "Wallboard sealer".');
      return;
    }
    setFormError(null);
    const payload = {
      product: trimmedProduct,
      brand: brand.trim() || undefined,
      color: color.trim() || undefined,
      kind,
      litres: parseLitres(litresStr),
      location,
      notes: notes.trim() || undefined,
    };

    if (item) {
      updatePaintStock(item.id, payload);
      onClose();
      return;
    }

    setSaving(true);
    const res = await addPaintStock(payload);
    setSaving(false);
    if (!res.ok) {
      // Loud failure on the screen, per the golden rule.
      setFormError(res.error ?? 'Save failed — try again.');
      return;
    }
    onClose();
  }

  function handleDelete() {
    if (!item) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    deletePaintStock(item.id);
    onClose();
  }

  return (
    <Sheet open={open} onOpenChange={onClose}>
      <SheetContent side="bottom" className="rounded-t-2xl p-0" showCloseButton={false}>
        <div className="max-h-[92vh] md:max-h-none md:h-full flex flex-col overflow-hidden">
          <div className="shrink-0 px-4 pt-4 pb-3 border-b border-border bg-card">
            <div className="flex items-center gap-2">
              <Paintbrush size={18} className="text-primary shrink-0" strokeWidth={1.8} />
              <SheetHeader className="p-0">
                <SheetTitle className="text-base font-bold text-foreground">
                  {/* item is null both for 'new' AND when the sheet is
                      closed (editing === null) — Radix still renders the
                      (hidden) content, so never assume item exists here. */}
                  {item ? itemTitle(item) : 'Add paint'}
                </SheetTitle>
              </SheetHeader>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-4 space-y-4">
            {/* Product + brand */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Product</label>
                <input
                  type="text"
                  value={product}
                  onChange={(e) => setProduct(e.target.value)}
                  placeholder="Lumbersider"
                  className={inputCls}
                />
              </div>
              <div>
                <label className={labelCls}>Brand</label>
                <input
                  type="text"
                  value={brand}
                  onChange={(e) => setBrand(e.target.value)}
                  placeholder="Resene"
                  className={inputCls}
                />
              </div>
            </div>

            {/* Colour */}
            <div>
              <label className={labelCls}>Colour</label>
              <input
                type="text"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                placeholder="Flax Pod (blank if untinted)"
                className={inputCls}
              />
            </div>

            {/* Kind chips */}
            <div>
              <label className={labelCls}>Type</label>
              <div className="flex flex-wrap gap-2">
                {KIND_ORDER.map((k) => (
                  <button
                    key={k}
                    onClick={() => setKind(k)}
                    className={cn(
                      'h-10 px-3.5 rounded-full text-sm font-medium border transition-colors',
                      kind === k
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-card text-muted-foreground border-border hover:text-foreground',
                    )}
                  >
                    {KIND_CHIP_LABELS[k]}
                  </button>
                ))}
              </div>
            </div>

            {/* Litres + location */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Litres left (approx)</label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={litresStr}
                  onChange={(e) => setLitresStr(e.target.value)}
                  placeholder={kind === 'test_pot' ? 'Blank for a pot' : '3.5'}
                  className={inputCls}
                />
              </div>
              <div>
                <label className={labelCls}>Where</label>
                <div className="grid grid-cols-2 h-11 rounded-lg border border-input overflow-hidden">
                  {(['garage', 'van'] as const).map((loc) => (
                    <button
                      key={loc}
                      onClick={() => setLocation(loc)}
                      className={cn(
                        'flex items-center justify-center gap-1.5 text-sm font-medium transition-colors',
                        location === loc
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-background text-muted-foreground',
                      )}
                    >
                      {loc === 'garage'
                        ? <Warehouse size={14} strokeWidth={1.8} />
                        : <Car size={14} strokeWidth={1.8} />}
                      {loc === 'garage' ? 'Garage' : 'Van'}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Notes */}
            <div>
              <label className={labelCls}>Notes</label>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Two cans: 2 L + 0.5 L"
                className={inputCls}
              />
            </div>

            {formError && (
              <p className="text-sm text-destructive font-medium">{formError}</p>
            )}
          </div>

          {/* Actions */}
          <div className="shrink-0 px-4 py-3 border-t border-border bg-card flex items-center gap-2 pb-safe">
            {item && (
              <button
                onClick={handleDelete}
                className={cn(
                  'h-12 px-4 rounded-xl border text-sm font-semibold flex items-center gap-1.5 transition-colors',
                  confirmDelete
                    ? 'bg-destructive text-destructive-foreground border-destructive'
                    : 'border-border text-muted-foreground hover:text-destructive',
                )}
              >
                <Trash2 size={15} strokeWidth={1.8} />
                {confirmDelete ? 'Tap to confirm' : 'Delete'}
              </button>
            )}
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex-1 h-12 rounded-xl bg-primary text-primary-foreground text-sm font-semibold active:scale-[0.98] transition-transform disabled:opacity-60"
            >
              {saving ? 'Saving…' : isNew ? 'Add to stock' : 'Save'}
            </button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
