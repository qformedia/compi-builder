#!/usr/bin/env python3
"""Report External Clips with empty `Tags` but known `Used in Video Tag`."""

from __future__ import annotations

import argparse
import csv
from pathlib import Path


def split_semicolon(value: str | None) -> list[str]:
    if not value:
        return []
    return [part.strip() for part in value.split(";") if part.strip()]


def join_values(values: list[str], separator: str) -> str:
    # Preserve deterministic output and avoid duplicates.
    return separator.join(sorted(set(values)))


def load_vp_tag_map(vp_csv: Path) -> dict[str, list[str]]:
    vp_tag_map: dict[str, list[str]] = {}
    with vp_csv.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            vp_id = (row.get("Record ID") or "").strip()
            vp_tags = split_semicolon(row.get("Tag"))
            if not vp_id or not vp_tags:
                continue
            vp_tag_map[vp_id] = sorted(set(vp_tags))
    return vp_tag_map


def run_report(ec_csv: Path, vp_csv: Path, output_csv: Path, list_separator: str) -> tuple[int, int]:
    vp_tag_map = load_vp_tag_map(vp_csv)

    output_csv.parent.mkdir(parents=True, exist_ok=True)
    processed = 0
    matched = 0

    with (
        ec_csv.open("r", encoding="utf-8-sig", newline="") as in_f,
        output_csv.open("w", encoding="utf-8", newline="") as out_f,
    ):
        reader = csv.DictReader(in_f)
        fieldnames = [
            "ec_record_id",
            "associated_vp_ids",
            "current_tag",
            "current_used_in_video_tag",
            "expected_tag_from_published_vps",
            "used_in_tag_count",
        ]
        writer = csv.DictWriter(
            out_f,
            fieldnames=fieldnames,
            quoting=csv.QUOTE_ALL,
            lineterminator="\n",
        )
        writer.writeheader()

        rows: list[dict[str, str]] = []
        for row in reader:
            processed += 1
            current_tag = split_semicolon(row.get("Tags"))
            current_used_in = split_semicolon(row.get("Used in Video Tag"))
            if current_tag:
                continue
            if not current_used_in:
                continue

            associated_vp_ids = split_semicolon(row.get("Associated Video Project IDs"))
            expected_tags: list[str] = []
            for vp_id in associated_vp_ids:
                expected_tags.extend(vp_tag_map.get(vp_id, []))

            rows.append(
                {
                    "ec_record_id": (row.get("Record ID") or "").strip(),
                    "associated_vp_ids": join_values(associated_vp_ids, list_separator),
                    "current_tag": "",
                    "current_used_in_video_tag": join_values(current_used_in, list_separator),
                    "expected_tag_from_published_vps": join_values(expected_tags, list_separator),
                    "used_in_tag_count": str(len(set(current_used_in))),
                }
            )

        rows.sort(key=lambda r: (-int(r["used_in_tag_count"]), r["ec_record_id"]))
        for out_row in rows:
            writer.writerow(out_row)
        matched = len(rows)

    return processed, matched


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Output ECs where `Tags` is empty and `Used in Video Tag` is non-empty."
    )
    parser.add_argument("--ec-csv", required=True, type=Path, help="Path to External Clips CSV export")
    parser.add_argument("--vp-csv", required=True, type=Path, help="Path to published Video Projects CSV export")
    parser.add_argument("--output-csv", required=True, type=Path, help="Path to output report CSV")
    parser.add_argument(
        "--list-separator",
        default="; ",
        help="Separator used inside list-like output fields (default: '; ')",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    processed, matched = run_report(
        ec_csv=args.ec_csv,
        vp_csv=args.vp_csv,
        output_csv=args.output_csv,
        list_separator=args.list_separator,
    )
    print(f"Processed ECs: {processed}")
    print(f"ECs with empty Tags and known Used in Video Tag: {matched}")
    print(f"Output: {args.output_csv}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
