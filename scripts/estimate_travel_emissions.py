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
    DEFAULT_EMISSIONS_SITE_PATH,
    DEFAULT_OUTPUT_PATH,
    DEFAULT_TRAVEL_CACHE_PATH,
    api_query_count,
    estimate_conference_travel,
    export_emissions_site_data,
    load_api_key,
    load_attendee_legs,
    load_geocoded_talks,
    load_site_locations,
    print_travel_summary,
)

console = Console()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Estimate conference travel emissions for ICRS speakers using the "
            "emissions.dev Travel API (one query per unique origin route)."
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
        "--site-output",
        type=Path,
        default=DEFAULT_EMISSIONS_SITE_PATH,
        help="Path for JS export used by the emissions tab.",
    )
    parser.add_argument(
        "--travel-cache",
        type=Path,
        default=DEFAULT_TRAVEL_CACHE_PATH,
        help="Cache file for emissions.dev responses.",
    )
    parser.add_argument(
        "--keys-path",
        type=Path,
        default=Path("keys.yaml"),
        help="YAML file containing the emissions-dev API key.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show attendee legs and unique route counts without calling the API.",
    )
    parser.add_argument(
        "--smoke-test",
        action="store_true",
        help="Query a single unique route to verify API access before the full run.",
    )
    parser.add_argument(
        "--refresh-geocodes",
        action="store_true",
        help="Re-query Nominatim for coordinates missing country codes in the reverse-geocode cache.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Limit number of unique routes queried (for testing).",
    )
    parser.add_argument(
        "--export-site-only",
        action="store_true",
        help="Rebuild js/emissions-data.js from existing summary + attendee CSV.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    talks_geo = load_geocoded_talks()
    legs, missing = load_attendee_legs(
        talks_geo,
        show_progress=True,
        refresh_incomplete=args.refresh_geocodes,
    )
    unique_routes = legs.drop_duplicates(
        subset=["origin_country", "origin_location", "transport_mode"]
    )

    console.print(
        f"[bold]Attendees with locations:[/] {len(legs):,} | "
        f"[bold]Missing:[/] {len(missing):,} | "
        f"[bold]Unique routes:[/] {len(unique_routes):,} | "
        f"[bold]Flights:[/] {(unique_routes['transport_mode'] == 'flight').sum():,} | "
        f"[bold]NZ car:[/] {(unique_routes['transport_mode'] == 'car').sum():,}"
    )
    console.print(
        "[dim]Efficient mode uses 1 API query per unique route "
        f"(~{len(unique_routes):,} queries for a full run).[/]"
    )

    if args.dry_run:
        console.print(unique_routes.head(10).to_string(index=False))
        return

    if args.export_site_only:
        if not args.output.exists() or not args.details_output.exists():
            raise SystemExit("Need existing summary JSON and attendee CSV for --export-site-only.")
        with args.output.open(encoding="utf-8") as handle:
            summary = json.load(handle)
        estimates = __import__("pandas").read_csv(args.details_output)
        locations = load_site_locations("js/locations.js")
        export_emissions_site_data(estimates, summary, locations, save_path=args.site_output)
        console.print(f"Rebuilt site export at [green]{args.site_output}[/]")
        return

    api_key = load_api_key(args.keys_path)
    route_limit = 1 if args.smoke_test else args.limit

    if args.smoke_test:
        console.print("[yellow]Smoke test:[/] querying 1 unique route only.")

    estimates, summary = estimate_conference_travel(
        talks_geo,
        api_key=api_key,
        legs=legs,
        missing=missing,
        travel_cache_path=args.travel_cache,
        show_progress=True,
        refresh_incomplete=args.refresh_geocodes,
        limit=route_limit,
    )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.details_output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8") as handle:
        json.dump(summary, handle, indent=2)
    estimates.to_csv(args.details_output, index=False)

    locations = load_site_locations("js/locations.js")
    export_emissions_site_data(estimates, summary, locations, save_path=args.site_output)

    print_travel_summary(summary)
    console.print(f"\nAPI queries this run: [bold]{api_query_count():,}[/]")
    console.print(f"Saved summary to [green]{args.output}[/]")
    console.print(f"Saved attendee details to [green]{args.details_output}[/]")
    console.print(f"Saved site data to [green]{args.site_output}[/]")

    if args.smoke_test:
        console.print(
            "\n[green]Smoke test passed.[/] Re-run without --smoke-test to fetch all unique routes."
        )


if __name__ == "__main__":
    main()
