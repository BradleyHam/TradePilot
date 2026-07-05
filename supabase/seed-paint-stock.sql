-- Seed paint_stock from Brad's stocktake (5 July 2026).
-- Run AFTER migrations/024_paint_stock.sql. Safe to re-run only if you
-- truncate first: delete from paint_stock;
--
-- Flagged guesses (fix in the app if wrong):
--   * "Aqua enemal Tea"            → Dulux Aquanamel, colour Tea
--   * "half surrender half iron"   → seeded as TWO test pots: Half Surrender
--                                    + Half Ironsand (check the second)
--   * Woodsman Nutmeg 0.5 + 0.8 L  → combined 1.3 L, cans noted
--   * Sureseal 2 L + 0.5 L         → combined 2.5 L, cans noted

with biz as (select id from businesses limit 1)
insert into paint_stock (business_id, product, brand, color, kind, litres, location, notes)
select biz.id, v.product, v.brand, v.color, v.kind, v.litres::numeric, v.location, v.notes
from biz cross join (values
  -- Garage — topcoats / enamels / ceiling
  ('Wash&Wear Low Sheen',        'Dulux',  'Tea',             'topcoat',       '7',   'garage', null),
  ('Zylone Sheen',               'Resene', 'Triple Sea Fog',  'topcoat',       '1',   'garage', null),
  ('Lumbersider',                'Resene', 'Grey Friars',     'topcoat',       '1',   'garage', null),
  ('Lumbersider',                'Resene', 'Flax Pod',        'topcoat',       '3',   'garage', null),
  ('Lumbersider',                'Resene', 'Double Concrete', 'topcoat',       '0.7', 'garage', null),
  ('Aquanamel',                  'Dulux',  'Tea',             'enamel',        '3',   'garage', null),
  ('Lustacryl',                  'Resene', 'Alabaster',       'enamel',        '2',   'garage', null),
  ('Ceiling paint',              null,     'Quarter Blanc',   'ceiling',       '6',   'garage', null),
  ('Ceiling paint',              null,     'Alabaster',       'ceiling',       '3',   'garage', null),
  -- Garage — primers / sealers / stains / other
  ('Wood primer (oil-based)',    null,     null,              'primer_sealer', '0.5', 'garage', null),
  ('Wallboard sealer',           null,     null,              'primer_sealer', '3',   'garage', null),
  ('Woodsman',                   'Resene', 'Natural',         'stain',         '0.5', 'garage', null),
  ('Woodsman',                   'Resene', 'Nutmeg',          'stain',         '1.3', 'garage', 'Two cans: 0.5 L + 0.8 L'),
  ('Woodsman',                   'Resene', 'Kwila',           'stain',         '0.5', 'garage', null),
  ('Wallpaper paste',            null,     null,              'other',         '3',   'garage', null),
  -- Garage — test pots
  ('Test pot',                   null,     'Tea',             'test_pot',      null,  'garage', null),
  ('Test pot',                   null,     'Half Tea',        'test_pot',      null,  'garage', null),
  ('Test pot',                   null,     'Black White',     'test_pot',      null,  'garage', null),
  ('Test pot',                   null,     'Quarter Tea',     'test_pot',      null,  'garage', null),
  ('Test pot',                   null,     'Eighth Tea',      'test_pot',      null,  'garage', null),
  ('Test pot',                   null,     'Quarter Rakaia',  'test_pot',      null,  'garage', null),
  ('Test pot',                   null,     'Half Surrender',  'test_pot',      null,  'garage', null),
  ('Test pot',                   null,     'Half Ironsand',   'test_pot',      null,  'garage', 'From "half surrender half iron" — check colour name'),
  ('Test pot',                   null,     'Concrete',        'test_pot',      null,  'garage', null),
  -- Van
  ('Quick Dry primer undercoat', 'Resene', null,              'primer_sealer', '3',   'van',    null),
  ('Pigmented Sealer',           'Dulux',  null,              'primer_sealer', '3',   'van',    null),
  ('Sureseal',                   'Resene', null,              'primer_sealer', '2.5', 'van',    'Two cans: 2 L + 0.5 L'),
  ('Galvo prime',                null,     null,              'primer_sealer', '0.8', 'van',    null),
  ('Shellac sealer',             null,     null,              'primer_sealer', null,  'van',    'Spray can'),
  ('Weathershield',              'Dulux',  'Eighth Ironsand', 'topcoat',       '0.5', 'van',    null)
) as v(product, brand, color, kind, litres, location, notes);
