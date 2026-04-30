#!/usr/bin/env python3
"""
Lakeside Painting — Google Sheets Manager (SANDBOX)
Identical to sheets_manager.py but pointed at "Business Data (Sandbox)".
Use this for Trade Pilot experiments so production Finances stays untouched.

Usage:
    python3 sheets_manager.py log_hours <date> <job_id> <activity> <hours> [notes]
    python3 sheets_manager.py log_transaction <date> <job_id> <type> <category> <amount> <description> [payment_method]
    python3 sheets_manager.py log_material <date> <job_id> <product_type> <brand> <product_name> <color> <finish> <qty> <unit> <cost> <supplier> [area] [notes]
    python3 sheets_manager.py log_enquiry <json_string>
    python3 sheets_manager.py add_bill <date> <company> <job_id> <description> <amount> <due_date>
    python3 sheets_manager.py list_jobs
    python3 sheets_manager.py search_jobs <query>
    python3 sheets_manager.py get_job <job_id>
    python3 sheets_manager.py get_hours_summary [job_id]
    python3 sheets_manager.py get_financials [job_id]
    python3 sheets_manager.py get_materials [job_id]
    python3 sheets_manager.py get_outstanding_bills
    python3 sheets_manager.py next_job_id
    python3 sheets_manager.py next_enquiry_id
    python3 sheets_manager.py update_enquiry_status <enquiry_id> <stage> <status>
    python3 sheets_manager.py get_enquiry <enquiry_id>
    python3 sheets_manager.py search_enquiries <query>
    python3 sheets_manager.py create_job <job_id> <job_name> <client_name> <job_address> <quoted_amount> [notes]
"""

import sys
import json
from datetime import datetime, date

import gspread
from google.oauth2.service_account import Credentials

# ─── Config ───────────────────────────────────────────────────────────────────
import os as _os
CREDENTIALS_FILE = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "service-worker.json")
SPREADSHEET_NAME = "Business Data (Sandbox)"
SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive"
]

# ─── Activity mapping (natural language → standard category) ──────────────────
ACTIVITY_MAP = {
    # Prep
    "sanding": "prep", "washing": "prep", "masking": "prep", "filling": "prep",
    "scraping": "prep", "stripping": "prep", "cleaning": "prep", "taping": "prep",
    "prep": "prep", "preparation": "prep", "sugar soaping": "prep",
    "pressure washing": "prep", "water blasting": "prep",
    # Paint
    "painting": "paint", "cutting in": "paint", "rolling": "paint",
    "brushing": "paint", "spraying": "paint", "top coat": "paint",
    "top coats": "paint", "second coat": "paint", "first coat": "paint",
    "paint": "paint", "touching up": "paint", "touch up": "paint",
    # Stain
    "staining": "stain", "oiling": "stain", "stain": "stain", "oil": "stain",
    # Wallpaper
    "wallpapering": "wallpaper", "wallpaper": "wallpaper", "hanging paper": "wallpaper",
    "papering": "wallpaper",
    # Primer
    "priming": "primer", "primer": "primer", "undercoat": "primer",
    "sealing": "primer", "sealer": "primer",
    # Repair
    "patching": "repair", "plastering": "repair", "repair": "repair",
    "repairs": "repair", "filling holes": "repair", "caulking": "repair",
    "putty": "repair",
    # Travel
    "driving": "travel", "travel": "travel", "travelling": "travel",
    "picking up": "travel", "pickup": "travel", "drop off": "travel",
    # Admin
    "quoting": "admin", "measuring": "admin", "site visit": "admin",
    "admin": "admin", "invoicing": "admin", "paperwork": "admin",
    "meeting": "admin", "phone calls": "admin",
}

def normalize_activity(raw: str) -> str:
    """Map natural language activity to a standard category."""
    raw_lower = raw.strip().lower()
    if raw_lower in ACTIVITY_MAP:
        return ACTIVITY_MAP[raw_lower]
    # Try partial match
    for key, val in ACTIVITY_MAP.items():
        if key in raw_lower or raw_lower in key:
            return val
    # If no match, return as-is (freeform fallback)
    return raw_lower


# ─── Connection ───────────────────────────────────────────────────────────────
def connect():
    creds = Credentials.from_service_account_file(CREDENTIALS_FILE, scopes=SCOPES)
    client = gspread.authorize(creds)
    return client.open(SPREADSHEET_NAME)


# ─── Job Helpers ──────────────────────────────────────────────────────────────
def list_jobs(spreadsheet=None):
    """List all jobs with ID, name, client, status."""
    ss = spreadsheet or connect()
    ws = ss.worksheet("Jobs")
    rows = ws.get_all_records()
    result = []
    for r in rows:
        if r.get("Job ID"):
            result.append({
                "job_id": r["Job ID"],
                "name": r["Job Name"],
                "client": r["Client Name"],
                "address": r["Job Address"],
                "status": r["Status"],
                "quoted": r.get("Quoted Amount", ""),
            })
    return result


def search_jobs(query: str, spreadsheet=None):
    """Search jobs by name, client, address, or ID (fuzzy prefix matching)."""
    jobs = list_jobs(spreadsheet)
    query_lower = query.lower().strip()
    matches = []
    for j in jobs:
        searchable = f"{j['job_id']} {j['name']} {j['client']} {j['address']}".lower()
        # Exact substring match
        if query_lower in searchable:
            matches.append(j)
            continue
        # Fuzzy: check if any word in searchable starts with query, or query starts with any word
        words = searchable.replace(",", " ").replace(".", " ").split()
        for word in words:
            if word.startswith(query_lower) or query_lower.startswith(word[:4]) and len(word) >= 4:
                matches.append(j)
                break
    return matches


def get_job(job_id: str, spreadsheet=None):
    """Get full details for a specific job."""
    ss = spreadsheet or connect()
    ws = ss.worksheet("Jobs")
    rows = ws.get_all_records()
    for r in rows:
        if str(r.get("Job ID", "")).upper() == job_id.upper():
            return r
    return None


def next_job_id(spreadsheet=None):
    """Get the next available Job ID (e.g., J7 if J6 exists)."""
    jobs = list_jobs(spreadsheet)
    if not jobs:
        return "J1"
    max_num = 0
    for j in jobs:
        jid = j["job_id"]
        if jid.startswith("J") and jid[1:].isdigit():
            max_num = max(max_num, int(jid[1:]))
    return f"J{max_num + 1}"


def next_enquiry_id(spreadsheet=None):
    """Get the next available Enquiry ID."""
    ss = spreadsheet or connect()
    ws = ss.worksheet("Enquiries")
    rows = ws.get_all_values()
    max_num = 0
    for row in rows[1:]:  # skip header
        eid = row[0] if row else ""
        if eid.startswith("ENQ-") and eid[4:].isdigit():
            max_num = max(max_num, int(eid[4:]))
    return f"ENQ-{max_num + 1:03d}"


# ─── Logging Functions ────────────────────────────────────────────────────────
def log_hours(date_str: str, job_id: str, activity: str, hours: str, notes: str = ""):
    """Append a row to Logged Hours."""
    ss = connect()
    ws = ss.worksheet("Logged Hours")
    timestamp = datetime.now().strftime("%-m/%-d/%Y %H:%M:%S")
    normalized = normalize_activity(activity)
    row = [timestamp, date_str, job_id.upper(), normalized, str(hours), notes]
    ws.append_row(row, value_input_option="USER_ENTERED")
    return {
        "status": "ok",
        "tab": "Logged Hours",
        "data": {"date": date_str, "job_id": job_id.upper(), "activity": normalized,
                 "original_activity": activity, "hours": hours, "notes": notes}
    }


def log_transaction(
    date_str: str,
    job_id: str,
    txn_type: str,
    category: str,
    amount: str,
    description: str,
    payment_method: str = "",
    gst_applies: str = "",
    amount_ex_gst: str = "",
    gst_component: str = "",
):
    """Append a row to Transactions.

    The Transactions tab schema has evolved over time.

    Current header (as of 2026-03+) includes GST columns:
      ['', 'Date', 'Job ID', 'Type (income or expense)', 'Category', 'Amount',
       'Description', 'Payment method', 'GST applies?', 'Amount ex GST', 'GST component']

    This function:
      - Writes all known columns when present in the sheet
      - Falls back gracefully if the sheet has fewer columns
      - Avoids `append_row` because the sheet contains pre-filled blank rows; instead
        it finds the last non-empty data row and writes the next row via update.

    GST behaviour:
      - If gst_applies is TRUE and ex-GST / GST component are blank, auto-calculates
        using NZ GST 15% (ex = amount/1.15, gst = amount - ex).
    """

    ss = connect()
    ws = ss.worksheet("Transactions")

    # Build canonical values
    timestamp = datetime.now().strftime("%-m/%-d/%Y %H:%M:%S")
    ttype = txn_type.lower().strip()
    cat = category.lower().strip()

    # Ensure expenses are negative
    amt = float(amount)
    if ttype == "expense" and amt > 0:
        amt = -amt

    # Normalize GST fields (keep blank if unknown)
    gst_norm = str(gst_applies).strip().upper()
    if gst_norm in {"TRUE", "T", "YES", "Y", "1"}:
        gst_norm = "TRUE"
    elif gst_norm in {"FALSE", "F", "NO", "N", "0"}:
        gst_norm = "FALSE"
    elif gst_norm == "":
        gst_norm = ""

    # Compute ex-GST and GST component if GST applies and not supplied.
    ex = str(amount_ex_gst).strip()
    gstc = str(gst_component).strip()
    if gst_norm == "TRUE" and (ex == "" or gstc == ""):
        ex_val = round(amt / 1.15, 2)
        gst_val = round(amt - ex_val, 2)
        if ex == "":
            ex = str(ex_val)
        if gstc == "":
            gstc = str(gst_val)

    # Read header to map columns
    headers = ws.row_values(1)
    col_map = {h: i + 1 for i, h in enumerate(headers) if h != ""}
    # The first header cell is blank; treat it as Timestamp
    timestamp_col = 1

    # Detect whether the sheet uses ARRAYFORMULA to compute ex-GST/GST component.
    # If so, we MUST NOT write into those columns, otherwise it will block the array.
    def _get_formula(a1: str) -> str:
        try:
            v = ws.get(a1, value_render_option="FORMULA")
            if v and v[0] and len(v[0]) > 0:
                return str(v[0][0] or "")
        except Exception:
            return ""
        return ""

    ex_col = col_map.get("Amount ex GST", 0)
    gst_col = col_map.get("GST component", 0)
    ex_formula = _get_formula(gspread.utils.rowcol_to_a1(2, ex_col)) if ex_col else ""
    gst_formula = _get_formula(gspread.utils.rowcol_to_a1(2, gst_col)) if gst_col else ""
    uses_array_gst = (
        ex_formula.strip().upper().startswith("=ARRAYFORMULA")
        or gst_formula.strip().upper().startswith("=ARRAYFORMULA")
    )

    # Determine the next row to write: last row with any content in cols 1..8
    all_vals = ws.get_all_values()
    last_data_row = 1
    for idx, row in enumerate(all_vals[1:], start=2):
        if any((c or "").strip() for c in row[:8]):
            last_data_row = idx
    target_row = last_data_row + 1

    # Prepare row with same length as header (or at least 8 columns)
    width = max(len(headers), 8)
    row_out = ["" for _ in range(width)]

    def set_col(col_idx_1based: int, value: str):
        if col_idx_1based <= 0:
            return
        if col_idx_1based > len(row_out):
            row_out.extend([""] * (col_idx_1based - len(row_out)))
        row_out[col_idx_1based - 1] = value

    # Required/base columns
    set_col(timestamp_col, timestamp)
    set_col(col_map.get("Date", 2), date_str)
    set_col(col_map.get("Job ID", 3), job_id.upper())
    set_col(col_map.get("Type (income or expense)", 4), ttype)
    set_col(col_map.get("Category", 5), cat)
    set_col(col_map.get("Amount", 6), str(amt))
    set_col(col_map.get("Description", 7), description)
    set_col(col_map.get("Payment method", 8), payment_method)

    # Optional GST columns (only if present)
    if "GST applies?" in col_map:
        set_col(col_map["GST applies?"], gst_norm)

    # Only write into ex-GST / GST component columns if the sheet is NOT using an array formula.
    # (If it is, leaving these blank lets the array formula populate them automatically.)
    if not uses_array_gst:
        if "Amount ex GST" in col_map:
            set_col(col_map["Amount ex GST"], ex)
        if "GST component" in col_map:
            set_col(col_map["GST component"], gstc)

    # Write the row into the sheet.
    # To avoid breaking ARRAYFORMULA columns, limit the written range to the last column we intend to set.
    write_end_col = 8
    if "GST applies?" in col_map:
        write_end_col = max(write_end_col, col_map["GST applies?"])
    if not uses_array_gst:
        if "Amount ex GST" in col_map:
            write_end_col = max(write_end_col, col_map["Amount ex GST"])
        if "GST component" in col_map:
            write_end_col = max(write_end_col, col_map["GST component"])

    start_a1 = gspread.utils.rowcol_to_a1(target_row, 1)
    end_a1 = gspread.utils.rowcol_to_a1(target_row, write_end_col)
    ws.update([row_out[:write_end_col]], f"{start_a1}:{end_a1}", value_input_option="USER_ENTERED")

    return {
        "status": "ok",
        "tab": "Transactions",
        "row": target_row,
        "data": {
            "date": date_str,
            "job_id": job_id.upper(),
            "type": ttype,
            "category": cat,
            "amount": amt,
            "description": description,
            "payment_method": payment_method,
            "gst_applies": gst_norm,
            "amount_ex_gst": ex,
            "gst_component": gstc,
        },
    }

def log_material(date_str: str, job_id: str, product_type: str, brand: str,
                 product_name: str, color: str, finish: str, qty: str, unit: str,
                 cost: str, supplier: str, area: str = "", notes: str = ""):
    """Append a row to Materials & Paint."""
    ss = connect()
    ws = ss.worksheet("Materials & Paint")
    row = [date_str, job_id.upper(), product_type.lower(), brand, product_name,
           color, finish.lower(), str(qty), unit.lower(), str(cost), supplier, area, notes]
    ws.append_row(row, value_input_option="USER_ENTERED")
    return {
        "status": "ok",
        "tab": "Materials & Paint",
        "data": {"date": date_str, "job_id": job_id.upper(), "product": product_name,
                 "color": color, "qty": qty, "unit": unit, "cost": cost}
    }


def add_bill(date_str: str, company: str, job_id: str, description: str,
             amount: str, due_date: str):
    """Append a row to Outstanding Bills."""
    ss = connect()
    ws = ss.worksheet("Outstanding Bills")
    row = [date_str, company, job_id.upper(), description, str(amount), due_date, "FALSE"]
    ws.append_row(row, value_input_option="USER_ENTERED")
    return {
        "status": "ok",
        "tab": "Outstanding Bills",
        "data": {"company": company, "job_id": job_id.upper(), "amount": amount,
                 "due_date": due_date}
    }


def log_enquiry(data: dict):
    """Append a row to Enquiries. Expects a dict with field names matching headers."""
    ss = connect()
    ws = ss.worksheet("Enquiries")
    eid = next_enquiry_id(ss)
    headers = ws.row_values(1)
    row = []
    data["Enquiry ID"] = eid
    data.setdefault("Date Received", date.today().strftime("%-m/%-d/%Y"))
    data.setdefault("Status", "New")
    data.setdefault("Stage", "New Lead")
    for h in headers:
        row.append(str(data.get(h, "")))
    ws.append_row(row, value_input_option="USER_ENTERED")
    return {"status": "ok", "tab": "Enquiries", "enquiry_id": eid, "data": data}


# ─── Query Functions ──────────────────────────────────────────────────────────
def get_hours_summary(job_id: str = None, spreadsheet=None):
    """Get total hours, optionally filtered by job."""
    ss = spreadsheet or connect()
    ws = ss.worksheet("Logged Hours")
    rows = ws.get_all_records()
    total = 0
    by_activity = {}
    for r in rows:
        if job_id and str(r.get("Job ID", "")).upper() != job_id.upper():
            continue
        hrs = float(r.get("Hours", 0) or 0)
        total += hrs
        act = r.get("Activity", "unknown")
        by_activity[act] = by_activity.get(act, 0) + hrs
    return {"total_hours": total, "by_activity": by_activity, "job_id": job_id or "all"}


def get_financials(job_id: str = None, spreadsheet=None):
    """Get financial summary, optionally filtered by job."""
    ss = spreadsheet or connect()
    ws = ss.worksheet("Transactions")
    rows = ws.get_all_records()
    income = 0
    expenses = 0
    by_category = {}
    for r in rows:
        if job_id and str(r.get("Job ID", "")).upper() != job_id.upper():
            continue
        amt = float(r.get("Amount", 0) or 0)
        if amt > 0:
            income += amt
        else:
            expenses += abs(amt)
        cat = r.get("Category", "unknown")
        by_category[cat] = by_category.get(cat, 0) + amt
    return {
        "income": income, "expenses": expenses, "profit": income - expenses,
        "by_category": by_category, "job_id": job_id or "all"
    }


def get_materials(job_id: str = None, spreadsheet=None):
    """Get materials used, optionally filtered by job."""
    ss = spreadsheet or connect()
    ws = ss.worksheet("Materials & Paint")
    rows = ws.get_all_records()
    result = []
    for r in rows:
        if job_id and str(r.get("Job ID", "")).upper() != job_id.upper():
            continue
        if r.get("Product Type"):
            result.append(r)
    return result


def get_outstanding_bills(spreadsheet=None):
    """Get all unpaid bills."""
    ss = spreadsheet or connect()
    ws = ss.worksheet("Outstanding Bills")
    rows = ws.get_all_records()
    unpaid = []
    for r in rows:
        if str(r.get("Paid", "")).upper() != "TRUE" and r.get("Amount"):
            unpaid.append(r)
    return unpaid


# ─── Enquiry / Quote / Job Workflow ─────────────────────────────────────────
def update_enquiry_status(enquiry_id: str, stage: str, status: str, spreadsheet=None):
    """Update an enquiry's Stage and Status fields by Enquiry ID."""
    ss = spreadsheet or connect()
    ws = ss.worksheet("Enquiries")
    rows = ws.get_all_values()
    headers = rows[0]

    id_col = headers.index("Enquiry ID") if "Enquiry ID" in headers else 0
    stage_col = headers.index("Stage") if "Stage" in headers else None
    status_col = headers.index("Status") if "Status" in headers else None

    for i, row in enumerate(rows[1:], start=2):  # row 2 in sheets (1-indexed)
        if row[id_col].strip().upper() == enquiry_id.strip().upper():
            updates = {}
            if stage_col is not None:
                ws.update_cell(i, stage_col + 1, stage)
                updates["stage"] = stage
            if status_col is not None:
                ws.update_cell(i, status_col + 1, status)
                updates["status"] = status
            return {"status": "ok", "enquiry_id": enquiry_id, "updates": updates}

    return {"status": "error", "message": f"Enquiry {enquiry_id} not found"}


def get_enquiry(enquiry_id: str, spreadsheet=None):
    """Get full details for an enquiry by ID."""
    ss = spreadsheet or connect()
    ws = ss.worksheet("Enquiries")
    rows = ws.get_all_records()
    for r in rows:
        if str(r.get("Enquiry ID", "")).strip().upper() == enquiry_id.strip().upper():
            return r
    return None


def search_enquiries(query: str, spreadsheet=None):
    """Search enquiries by client name, address, or summary."""
    ss = spreadsheet or connect()
    ws = ss.worksheet("Enquiries")
    rows = ws.get_all_records()
    query_lower = query.lower().strip()
    matches = []
    for r in rows:
        searchable = " ".join(str(v) for v in r.values()).lower()
        if query_lower in searchable:
            matches.append(r)
    return matches


def create_job(job_id: str, job_name: str, client_name: str, job_address: str,
               quoted_amount: str, notes: str = "", start_date: str = "",
               spreadsheet=None):
    """Create a new job entry in the Jobs sheet."""
    ss = spreadsheet or connect()
    ws = ss.worksheet("Jobs")
    row = [
        job_id,
        job_name,
        client_name,
        job_address,
        start_date or date.today().strftime("%-m/%-d/%Y"),
        "New",          # Status
        quoted_amount,  # Quoted Amount
        "",             # Total Income
        "",             # Total Expenses
        "",             # Profit
        notes,          # Notes
        "",             # Total Hours
        "",             # $ Per Hour
        "",             # Variance from quote
    ]
    ws.append_row(row, value_input_option="USER_ENTERED")
    return {
        "status": "ok",
        "tab": "Jobs",
        "data": {
            "job_id": job_id,
            "job_name": job_name,
            "client": client_name,
            "address": job_address,
            "quoted": quoted_amount,
        }
    }


# ─── CLI Interface ────────────────────────────────────────────────────────────
def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "log_hours":
        # date, job_id, activity, hours, [notes]
        result = log_hours(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5],
                          sys.argv[6] if len(sys.argv) > 6 else "")
        print(json.dumps(result, indent=2))

    elif cmd == "log_transaction":
        # date, job_id, type, category, amount, description,
        # [payment_method], [gst_applies], [amount_ex_gst], [gst_component]
        payment_method = sys.argv[8] if len(sys.argv) > 8 else ""
        gst_applies = sys.argv[9] if len(sys.argv) > 9 else ""
        amount_ex_gst = sys.argv[10] if len(sys.argv) > 10 else ""
        gst_component = sys.argv[11] if len(sys.argv) > 11 else ""
        result = log_transaction(
            sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5],
            sys.argv[6], sys.argv[7],
            payment_method,
            gst_applies,
            amount_ex_gst,
            gst_component,
        )
        print(json.dumps(result, indent=2))

    elif cmd == "log_material":
        result = log_material(*sys.argv[2:15])
        print(json.dumps(result, indent=2))

    elif cmd == "log_enquiry":
        data = json.loads(sys.argv[2])
        result = log_enquiry(data)
        print(json.dumps(result, indent=2))

    elif cmd == "add_bill":
        result = add_bill(sys.argv[2], sys.argv[3], sys.argv[4],
                         sys.argv[5], sys.argv[6], sys.argv[7])
        print(json.dumps(result, indent=2))

    elif cmd == "list_jobs":
        jobs = list_jobs()
        for j in jobs:
            print(f"  {j['job_id']}: {j['name']} ({j['client']}) — {j['status']}")

    elif cmd == "search_jobs":
        matches = search_jobs(sys.argv[2])
        if matches:
            for j in matches:
                print(f"  {j['job_id']}: {j['name']} ({j['client']}) — {j['status']}")
        else:
            print("No matching jobs found.")

    elif cmd == "get_job":
        job = get_job(sys.argv[2])
        if job:
            print(json.dumps(job, indent=2))
        else:
            print(f"Job {sys.argv[2]} not found.")

    elif cmd == "get_hours_summary":
        jid = sys.argv[2] if len(sys.argv) > 2 else None
        result = get_hours_summary(jid)
        print(json.dumps(result, indent=2))

    elif cmd == "get_financials":
        jid = sys.argv[2] if len(sys.argv) > 2 else None
        result = get_financials(jid)
        print(json.dumps(result, indent=2))

    elif cmd == "get_materials":
        jid = sys.argv[2] if len(sys.argv) > 2 else None
        result = get_materials(jid)
        print(json.dumps(result, indent=2))

    elif cmd == "get_outstanding_bills":
        bills = get_outstanding_bills()
        total = sum(float(b.get("Amount", 0)) for b in bills)
        print(f"Outstanding bills: {len(bills)} totalling ${total:.2f}")
        for b in bills:
            print(f"  {b.get('Company', '?')} — ${b.get('Amount', '?')} (due {b.get('Due date', '?')}) [{b.get('Job ID', '?')}]")

    elif cmd == "next_job_id":
        print(next_job_id())

    elif cmd == "next_enquiry_id":
        print(next_enquiry_id())

    elif cmd == "update_enquiry_status":
        # enquiry_id, stage, status
        result = update_enquiry_status(sys.argv[2], sys.argv[3], sys.argv[4])
        print(json.dumps(result, indent=2))

    elif cmd == "get_enquiry":
        result = get_enquiry(sys.argv[2])
        if result:
            print(json.dumps(result, indent=2))
        else:
            print(f"Enquiry {sys.argv[2]} not found.")

    elif cmd == "search_enquiries":
        matches = search_enquiries(sys.argv[2])
        if matches:
            for e in matches:
                print(f"  {e.get('Enquiry ID', '?')}: {e.get('Client Name', '?')} — {e.get('Stage', '?')} ({e.get('Status', '?')})")
        else:
            print("No matching enquiries found.")

    elif cmd == "create_job":
        # job_id, job_name, client_name, job_address, quoted_amount, [notes]
        result = create_job(
            sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6],
            sys.argv[7] if len(sys.argv) > 7 else ""
        )
        print(json.dumps(result, indent=2))

    else:
        print(f"Unknown command: {cmd}")
        print(__doc__)
        sys.exit(1)

if __name__ == "__main__":
    main()
