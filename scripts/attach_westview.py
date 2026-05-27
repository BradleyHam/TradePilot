#!/usr/bin/env python3
"""attach_westview.py — one-off uploader.

Mirrors scripts/attach-westview.ts but runs as pure Python from the agent
sandbox, sidestepping the Mac-side node_modules / esbuild platform issue.

Uploads the optimised 23 Westview Rd files into the existing draft quote on
the (lost) 23 Westview Rd job:
  - 12 optimised scope photos  → kind = scope_photo
  - Compressed Plans.pdf       → kind = plan
  - QUO-036 quote PDF          → kind = quote_pdf

Idempotent: a (kind, file_name) pair already on the quote is skipped.
Dry-run by default; pass --apply to upload + insert.
"""

from __future__ import annotations
import argparse, os, sys, uuid
from pathlib import Path
import urllib.request, urllib.parse, json

# ─── Config ─────────────────────────────────────────────────────────────
# Mac paths — Supabase isn't reachable from the agent sandbox, so this
# script is expected to run on the Mac with Python 3.
SOURCE_DIR = Path('/Users/bradleyhamilton/Desktop/lakeside-painting/projects/23 Westview rd ')
PHOTOS_DIR = SOURCE_DIR / 'optimised'
OPTIMISED_PLANS = SOURCE_DIR / 'optimised' / 'Plans-v2.pdf'
QUOTE_PDF = SOURCE_DIR / 'QUO-036 - Soderstrom - 23 Westview Rd Cedar Restain.pdf'

PHOTO_FILES = [
    'IMG_6567.jpeg', 'IMG_6568.jpeg', 'IMG_6569.jpeg', 'IMG_6570.jpeg',
    'IMG_6571.jpeg', 'IMG_6572.jpeg', 'IMG_6573.jpeg', 'IMG_6574.jpeg',
    'IMG_6575.jpeg', 'IMG_6577.jpeg', 'IMG_6578.jpeg', 'IMG_6580.jpeg',
]

# Load env from TradePilot-lakeside/.env.local (script lives in scripts/).
ENV_FILE = Path(__file__).resolve().parent.parent / '.env.local'
env = {}
for line in ENV_FILE.read_text().splitlines():
    line = line.strip()
    if not line or line.startswith('#') or '=' not in line:
        continue
    k, v = line.split('=', 1)
    env[k.strip()] = v.strip().strip('"').strip("'")

SUPABASE_URL = env.get('NEXT_PUBLIC_SUPABASE_URL') or ''
SERVICE_KEY  = env.get('SUPABASE_SERVICE_ROLE_KEY') or ''
BUSINESS_ID  = env.get('TRADEPILOT_BUSINESS_ID') or ''
if not (SUPABASE_URL and SERVICE_KEY and BUSINESS_ID):
    print('missing env: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / TRADEPILOT_BUSINESS_ID')
    sys.exit(1)

# Strip trailing slash defensively.
SUPABASE_URL = SUPABASE_URL.rstrip('/')

# ─── HTTP helpers ───────────────────────────────────────────────────────
def _request(method: str, url: str, *, headers=None, data=None) -> tuple[int, bytes]:
    h = dict(headers or {})
    h.setdefault('apikey', SERVICE_KEY)
    h.setdefault('Authorization', f'Bearer {SERVICE_KEY}')
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()

def pg_get(table: str, params: dict) -> list:
    qs = urllib.parse.urlencode(params)
    code, body = _request('GET', f'{SUPABASE_URL}/rest/v1/{table}?{qs}',
                          headers={'Accept': 'application/json'})
    if code >= 300:
        print(f'GET {table} {code}: {body.decode()[:300]}')
        sys.exit(1)
    return json.loads(body or b'[]')

def pg_insert(table: str, row: dict) -> tuple[int, str]:
    body = json.dumps(row).encode()
    code, resp = _request('POST', f'{SUPABASE_URL}/rest/v1/{table}',
                          headers={'Content-Type': 'application/json',
                                   'Prefer': 'return=minimal'},
                          data=body)
    return code, resp.decode()

def storage_upload(bucket: str, path: str, content: bytes, content_type: str) -> tuple[int, str]:
    code, resp = _request('POST',
        f'{SUPABASE_URL}/storage/v1/object/{bucket}/{urllib.parse.quote(path)}',
        headers={'Content-Type': content_type, 'x-upsert': 'false'},
        data=content)
    return code, resp.decode()

def storage_remove(bucket: str, paths: list[str]):
    body = json.dumps({'prefixes': paths}).encode()
    _request('DELETE', f'{SUPABASE_URL}/storage/v1/object/{bucket}',
             headers={'Content-Type': 'application/json'}, data=body)

def content_type_for(name: str) -> str:
    n = name.lower()
    if n.endswith('.pdf'): return 'application/pdf'
    if n.endswith('.png'): return 'image/png'
    if n.endswith('.jpg') or n.endswith('.jpeg'): return 'image/jpeg'
    return 'application/octet-stream'

# ─── Main ───────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true', help='actually upload + insert')
    args = ap.parse_args()
    print('🚀  --apply mode' if args.apply else '🔍  dry-run (no writes)')

    # 1. Find the Westview job.
    jobs = pg_get('jobs', {
        'select': 'id,name,location,status',
        'business_id': f'eq.{BUSINESS_ID}',
        'or': '(name.ilike.%westview%,location.ilike.%westview%)',
    })
    if not jobs:
        print('No job found matching "westview". Aborting.'); sys.exit(1)
    if len(jobs) > 1:
        print(f'Found {len(jobs)} matching jobs:')
        for j in jobs: print(f'   - {j["id"]} | {j["name"]} | {j["location"]} | {j["status"]}')
        print('Refusing to guess; aborting.'); sys.exit(1)
    job = jobs[0]
    print(f'✓ Job: {job["id"]} | {job["name"]} | {job["status"]}')

    # 2. Find the (first) quote on this job.
    quotes = pg_get('quotes', {
        'select': 'id,status,total_amount_incl_gst,created_at',
        'business_id': f'eq.{BUSINESS_ID}',
        'job_id': f'eq.{job["id"]}',
        'order': 'created_at.asc',
    })
    if not quotes:
        print('No quote on this job. Aborting.'); sys.exit(1)
    quote = quotes[0]
    print(f'✓ Quote: {quote["id"]} | status={quote["status"]}')

    # 3. Build plan.
    plan: list[dict] = []
    for name in PHOTO_FILES:
        p = PHOTOS_DIR / name
        if not p.exists():
            print(f'   ⚠ missing photo: {name}'); continue
        plan.append({'path': p, 'file_name': name, 'kind': 'scope_photo'})
    if OPTIMISED_PLANS.exists():
        plan.append({'path': OPTIMISED_PLANS, 'file_name': 'Plans.pdf', 'kind': 'plan'})
    else:
        print(f'   ⚠ missing optimised plans')
    if QUOTE_PDF.exists():
        plan.append({'path': QUOTE_PDF, 'file_name': QUOTE_PDF.name, 'kind': 'quote_pdf'})
    else:
        print(f'   ⚠ missing quote PDF')

    # 4. Skip already-attached.
    existing = pg_get('quote_attachments', {
        'select': 'file_name,kind',
        'quote_id': f'eq.{quote["id"]}',
    })
    existing_keys = {f'{r["kind"]}::{r["file_name"]}' for r in existing}
    todo = [p for p in plan if f'{p["kind"]}::{p["file_name"]}' not in existing_keys]
    skipped = len(plan) - len(todo)

    print(f'\nPlan: {len(todo)} to upload, {skipped} already present')
    total = 0
    for p in todo:
        size = p['path'].stat().st_size
        total += size
        print(f'   {p["kind"]:<12} {p["file_name"]:<70} {size/1024:.0f} KB')
    print(f'   ──────  total {total/1024/1024:.1f} MB')

    if not args.apply:
        print('\n(dry run — re-run with --apply to upload)')
        return

    # 5. Upload + insert.
    uploaded = failed = 0
    for p in todo:
        safe_name = ''.join(c if c.isalnum() or c in '._-' else '_' for c in p['file_name'])
        storage_path = f'{BUSINESS_ID}/{quote["id"]}/{uuid.uuid4()}__{safe_name}'
        content = p['path'].read_bytes()
        ct = content_type_for(p['file_name'])

        code, resp = storage_upload('quote-attachments', storage_path, content, ct)
        if code >= 300:
            print(f'   ⚠ upload failed: {p["file_name"]} ({code}) — {resp[:200]}')
            failed += 1; continue

        code, resp = pg_insert('quote_attachments', {
            'business_id':  BUSINESS_ID,
            'quote_id':     quote['id'],
            'kind':         p['kind'],
            'storage_path': storage_path,
            'file_name':    p['file_name'],
        })
        if code >= 300:
            print(f'   ⚠ insert failed: {p["file_name"]} ({code}) — {resp[:200]}')
            storage_remove('quote-attachments', [storage_path])
            failed += 1; continue

        print(f'   ✓ {p["file_name"]}')
        uploaded += 1

    print(f'\n📊  {uploaded} uploaded, {failed} failed, {skipped} skipped (already present)')

if __name__ == '__main__':
    main()
