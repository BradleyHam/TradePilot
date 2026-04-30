#!/usr/bin/env python3
"""
Export every worksheet from "Business Data (Sandbox)" to JSON files
under TradePilot/data/import/.

Each worksheet becomes one .json file:
  - Filename: slugified worksheet name (e.g. "Materials & Paint" -> "materials_and_paint.json")
  - Contents: { "worksheet": <name>, "headers": [...], "rows": [ {col: val, ...}, ... ], "row_count": N }

Run:
    python3 export_sandbox_to_json.py

Sandbox-only — does not touch production Finances.
"""

import json
import os
import re
import sys
from datetime import datetime

import json as _json

import gspread
from gspread.exceptions import SpreadsheetNotFound
from google.oauth2.service_account import Credentials

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(HERE)  # scripts/ sits one level below project root
CREDENTIALS_FILE = os.path.join(HERE, "service-worker.json")
SPREADSHEET_NAME = "Business Data (Sandbox)"
OUT_DIR = os.path.join(PROJECT_ROOT, "data", "import")

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets.readonly",
    "https://www.googleapis.com/auth/drive.readonly",
]


def slugify(name: str) -> str:
    s = name.lower().strip()
    s = re.sub(r"&", "and", s)
    s = re.sub(r"[^a-z0-9]+", "_", s)
    s = re.sub(r"_+", "_", s).strip("_")
    return s or "sheet"


def connect():
    creds = Credentials.from_service_account_file(CREDENTIALS_FILE, scopes=SCOPES)
    client = gspread.authorize(creds)
    return client.open(SPREADSHEET_NAME)


def export():
    if not os.path.exists(CREDENTIALS_FILE):
        print(f"❌ Missing credentials file: {CREDENTIALS_FILE}", file=sys.stderr)
        sys.exit(1)

    os.makedirs(OUT_DIR, exist_ok=True)

    print(f"Connecting to '{SPREADSHEET_NAME}'…")
    try:
        ss = connect()
    except SpreadsheetNotFound:
        # Surface the service account email so the user knows who to share with.
        try:
            sa_email = _json.load(open(CREDENTIALS_FILE)).get("client_email", "<unknown>")
        except Exception:
            sa_email = "<unknown>"
        print(
            f"\n❌ Could not find a spreadsheet named '{SPREADSHEET_NAME}'.\n"
            f"   The service account is: {sa_email}\n"
            f"   In Google Sheets, open '{SPREADSHEET_NAME}', click Share, and give that\n"
            f"   email Editor access. Then re-run this script.",
            file=sys.stderr,
        )
        sys.exit(2)
    worksheets = ss.worksheets()
    print(f"Found {len(worksheets)} worksheet(s).\n")

    summary = []
    for ws in worksheets:
        title = ws.title
        slug = slugify(title)
        out_path = os.path.join(OUT_DIR, f"{slug}.json")

        # get_all_values gives us raw cell text for every row including the header.
        # get_all_records is friendlier but skips rows where cells happen to be blank
        # in ways that gspread interprets as duplicate columns. Use values, build dicts ourselves.
        values = ws.get_all_values()
        if not values:
            headers, rows = [], []
        else:
            headers = [h.strip() for h in values[0]]
            rows = []
            for raw_row in values[1:]:
                # Skip fully empty rows
                if not any(cell.strip() for cell in raw_row):
                    continue
                # Pad short rows so dict keys line up
                padded = list(raw_row) + [""] * (len(headers) - len(raw_row))
                rows.append({headers[i]: padded[i] for i in range(len(headers))})

        payload = {
            "worksheet": title,
            "exported_at": datetime.utcnow().isoformat() + "Z",
            "spreadsheet": SPREADSHEET_NAME,
            "headers": headers,
            "row_count": len(rows),
            "rows": rows,
        }

        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2, ensure_ascii=False)

        print(f"  {title:25s} -> {os.path.relpath(out_path, HERE)}  ({len(rows)} rows)")
        summary.append({"worksheet": title, "rows": len(rows), "file": os.path.relpath(out_path, HERE)})

    # Write a manifest so the importer knows what's available
    manifest_path = os.path.join(OUT_DIR, "_manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump({
            "spreadsheet": SPREADSHEET_NAME,
            "exported_at": datetime.utcnow().isoformat() + "Z",
            "worksheets": summary,
        }, f, indent=2)

    print(f"\nManifest: {os.path.relpath(manifest_path, HERE)}")
    print(f"\n✅ Done. {len(worksheets)} worksheet(s) exported to {os.path.relpath(OUT_DIR, HERE)}/")


if __name__ == "__main__":
    export()
