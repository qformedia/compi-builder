#!/usr/bin/env python3
"""Audit missing `Used in Video Tag` values for External Clips.

Compares current EC `Used in Video Tag` values against expected tags inferred from
associated Video Projects.
"""

from __future__ import annotations

import argparse
import csv
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


def split_semicolon(value: str | None) -> list[str]:
    if not value:
        return []
    return [part.strip() for part in value.split(";") if part.strip()]


def uniq_sorted(values: Iterable[str]) -> list[str]:
    return sorted(set(values))


@dataclass
class AuditRow:
    ec_record_id: str
    associated_vp_ids: str
    current_tag: str
    expected_tag_from_published_vps: str
    tag_fill_if_empty: str
    current_used_in_video_tag: str
    expected_used_in_video_tag: str
    missing_tags: str
    missing_count: int


def load_vp_tag_map(vp_csv: Path) -> dict[str, list[str]]:
    vp_tag_map: dict[str, list[str]] = {}

    with vp_csv.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            vp_id = (row.get("Record ID") or "").strip()
            if not vp_id:
                continue

            # VP `Tag` is usually single-select, but support semicolon values too.
            tags = uniq_sorted(split_semicolon(row.get("Tag")))
            if not tags:
                continue

            vp_tag_map[vp_id] = tags

    return vp_tag_map


def audit_missing_tags(ec_csv: Path, vp_tag_map: dict[str, list[str]]) -> tuple[list[AuditRow], int, int]:
    results: list[AuditRow] = []
    total_ecs = 0
    total_missing_assignments = 0

    with ec_csv.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            total_ecs += 1

            ec_id = (row.get("Record ID") or "").strip()
            associated_vp_ids = uniq_sorted(split_semicolon(row.get("Associated Video Project IDs")))
            current_tag_values = uniq_sorted(split_semicolon(row.get("Tags")))
            current_tags = uniq_sorted(split_semicolon(row.get("Used in Video Tag")))

            expected_tag_set: set[str] = set()
            for vp_id in associated_vp_ids:
                vp_tags = vp_tag_map.get(vp_id)
                if vp_tags:
                    expected_tag_set.update(vp_tags)

            expected_tags = sorted(expected_tag_set)
            missing_tags = [tag for tag in expected_tags if tag not in set(current_tags)]

            if not missing_tags:
                continue

            total_missing_assignments += len(missing_tags)
            results.append(
                AuditRow(
                    ec_record_id=ec_id,
                    associated_vp_ids=";".join(associated_vp_ids),
                    current_tag=";".join(current_tag_values),
                    expected_tag_from_published_vps=";".join(expected_tags),
                    tag_fill_if_empty=";".join(expected_tags) if not current_tag_values else "",
                    current_used_in_video_tag=";".join(current_tags),
                    expected_used_in_video_tag=";".join(expected_tags),
                    missing_tags=";".join(missing_tags),
                    missing_count=len(missing_tags),
                )
            )

    # Deterministic sort: largest gap first, then ID.
    results.sort(key=lambda r: (-r.missing_count, r.ec_record_id))
    return results, total_ecs, total_missing_assignments


def write_report(rows: list[AuditRow], output_csv: Path, list_separator: str) -> None:
    output_csv.parent.mkdir(parents=True, exist_ok=True)

    with output_csv.open("w", encoding="utf-8", newline="") as f:
        fieldnames = [
            "ec_record_id",
            "associated_vp_ids",
            "current_tag",
            "expected_tag_from_published_vps",
            "tag_fill_if_empty",
            "current_used_in_video_tag",
            "expected_used_in_video_tag",
            "missing_tags",
            "missing_count",
        ]
        writer = csv.DictWriter(
            f,
            fieldnames=fieldnames,
            quoting=csv.QUOTE_ALL,
            lineterminator="\n",
        )
        writer.writeheader()

        for row in rows:
            writer.writerow(
                {
                    "ec_record_id": row.ec_record_id,
                    "associated_vp_ids": list_separator.join(split_semicolon(row.associated_vp_ids)),
                    "current_tag": list_separator.join(split_semicolon(row.current_tag)),
                    "expected_tag_from_published_vps": list_separator.join(
                        split_semicolon(row.expected_tag_from_published_vps)
                    ),
                    "tag_fill_if_empty": list_separator.join(split_semicolon(row.tag_fill_if_empty)),
                    "current_used_in_video_tag": list_separator.join(split_semicolon(row.current_used_in_video_tag)),
                    "expected_used_in_video_tag": list_separator.join(split_semicolon(row.expected_used_in_video_tag)),
                    "missing_tags": list_separator.join(split_semicolon(row.missing_tags)),
                    "missing_count": row.missing_count,
                }
            )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Find External Clips whose `Used in Video Tag` is missing tags inferred "
            "from associated Video Projects."
        )
    )
    parser.add_argument("--ec-csv", required=True, type=Path, help="Path to External Clips CSV export")
    parser.add_argument("--vp-csv", required=True, type=Path, help="Path to published Video Projects CSV export")
    parser.add_argument("--output-csv", required=True, type=Path, help="Path to output report CSV")
    parser.add_argument(
        "--list-separator",
        default=" | ",
        help="Separator used inside list-like output fields (default: ' | ')",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    vp_tag_map = load_vp_tag_map(args.vp_csv)
    rows, total_ecs, total_missing_assignments = audit_missing_tags(args.ec_csv, vp_tag_map)
    write_report(rows, args.output_csv, list_separator=args.list_separator)

    print(f"Processed ECs: {total_ecs}")
    print(f"ECs with missing tags: {len(rows)}")
    print(f"Total missing tag assignments: {total_missing_assignments}")
    print(f"Output: {args.output_csv}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
