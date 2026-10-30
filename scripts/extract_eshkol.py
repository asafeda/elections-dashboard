#!/usr/bin/env python3
"""Convert eshkol.pdf into eshkol.csv (name, eshkol, alias).

`alias` is the settlement name as it appears in the election CSVs, when it
differs from the name in the PDF. Existing aliases in eshkol.csv are kept.
Run from the project root:  python3 scripts/extract_eshkol.py
"""
import csv
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PDF = os.path.join(ROOT, "eshkol.pdf")
OUT = os.path.join(ROOT, "eshkol.csv")
CITY_FILES = [os.path.join(ROOT, f) for f in ("by_city.csv", "by_city_old.csv")]

BIDI = re.compile("[\u200e\u200f\u202a-\u202e]")
ROW = re.compile(r"^\s*(\d+|-)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$")

# PDF name -> election CSV name, for names normalization can't reconcile.
MANUAL_ALIASES = {
    "יהוד-מונסון": "יהוד-מונוסון",
}


def normalize(name):
    """Must stay in sync with normalizeName() in js/data.js."""
    s = re.sub(r"[^\u05d0-\u05ea]", "", name)
    s = s.replace("יי", "י").replace("וו", "ו")
    return s


def extract_rows():
    text = subprocess.run(
        ["pdftotext", "-layout", PDF, "-"], capture_output=True, text=True, check=True
    ).stdout
    rows, pending = [], ""
    for raw in text.splitlines():
        line = BIDI.sub("", raw).rstrip()
        if not line.strip():
            continue
        m = ROW.match(line)
        if m:
            _score, _fin_rank, eshkol, _rank, name = m.groups()
            if pending:
                sep = "" if pending.endswith("-") else " "
                name = pending + sep + name.strip()
                pending = ""
            rows.append((re.sub(r"\s+", " ", name.strip()), int(eshkol)))
        elif re.fullmatch(r"\s{20,}\S.*", raw) and not re.search(r"\d|\(|\)|רשות|ביותר|הנמוך|האיתנות|הפיננסית|דירוג|אשכול|כלכלי|חזקה|חלשה", line):
            pending = line.strip()
    return rows


def load_city_names():
    names = set()
    for path in CITY_FILES:
        with open(path, encoding="utf-8-sig") as f:
            for r in csv.DictReader(f):
                names.add(r["שם ישוב"].strip())
    return names


def main():
    rows = extract_rows()
    existing = {}
    if os.path.exists(OUT):
        with open(OUT, encoding="utf-8") as f:
            existing = {r["name"]: r.get("alias", "") for r in csv.DictReader(f)}

    city_names = load_city_names()
    by_norm = {}
    for n in city_names:
        by_norm.setdefault(normalize(n), n)

    unmatched = []
    with open(OUT, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["name", "eshkol", "alias"])
        for name, eshkol in rows:
            alias = existing.get(name) or MANUAL_ALIASES.get(name, "")
            target = alias or name
            if normalize(target) not in by_norm:
                unmatched.append(name)
            w.writerow([name, eshkol, alias])

    print(f"wrote {len(rows)} rows to {OUT}")
    if unmatched:
        print(f"{len(unmatched)} names not found in the election CSVs (set 'alias' in eshkol.csv):")
        for n in unmatched:
            print("  ", n)


if __name__ == "__main__":
    sys.exit(main())
