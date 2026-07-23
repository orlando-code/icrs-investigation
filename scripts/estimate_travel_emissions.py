#!/usr/bin/env python3
"""Estimate ICRS 2026 attendee travel emissions using emissions.dev."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from rich.console import Console

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from src.travel_emissions import (
    DEFAULT_OUTPUT_PATH,
    DEFAULT_TRAVEL_CACHE_PATH,
    _api_key,
    estimate_conference_travel,
    load_attendee_legs,
    load_geocoded_talks,
    print_travel_summary,
)

console = Console()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Estimate conference travel emissions for ICRS speakers using the "
            "emissions.dev Travel API."
        )
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT_PATH,
        help="Path for JSON summary output.",
    )
    parser.add_argument(
        "--details-output",
        type=Path,
        default=Path("outputs/travel_emissions_by_attendee.csv"),
        help="Path for per-attendee CSV output.",
    )
    parser.add_argument(
        "--travel-cache",
        type=Path,
        default=DEFAULT_TRAVEL_CACHE_PATH,
        help="Cache file for emissions.dev responses.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show attendee legs without calling emissions.dev.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Limit number of attendees queried (useful for testing).",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    talks_geo = load_geocoded_talks()
    legs, missing = load_attendee_legs(talks_geo)

    if args.limit is not None:
        legs = legs.head(args.limit)

    console.print(
        f"[bold]Attendees with locations:[/] {len(legs):,} | "
        f"[bold]Missing:[/] {len(missing):,} | "
        f"[bold]Flights:[/] {(legs['transport_mode'] == 'flight').sum():,} | "
        f"[bold]NZ car:[/] {(legs['transport_mode'] == 'car').sum():,}"
    )

    if args.dry_run:
        console.print(legs.head(10).to_string(index=False))
        return

    api_key = _api_key()
    if not api_key:
        raise SystemExit(
            "Missing API key. Set EMISSIONS_DEV_API_KEY (or EMISSIONS_API_KEY). "
            "Get one at https://emissions.dev/register"
        )

    estimates, summary = estimate_conference_travel(
        talks_geo,
        api_key=api_key,
        legs=legs,
        missing=missing,
        travel_cache_path=args.travel_cache,
        show_progress=True,
    )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.details_output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8") as handle:
        json.dump(summary, handle, indent=2)
    estimates.to_csv(args.details_output, index=False)

    print_travel_summary(summary)
    console.print(f"\nSaved summary to [green]{args.output}[/]")
    console.print(f"Saved attendee details to [green]{args.details_output}[/]")


if __name__ == "__main__":
    main()
