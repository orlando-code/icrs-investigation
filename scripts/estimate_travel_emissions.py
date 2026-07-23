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

from src.delegates import (
    DEFAULT_DELEGATE_PDF_PATH,
    combined_attendee_talks,
    load_delegates,
)
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

ALL_DELEGATES_OUTPUT_PATH = Path("outputs/travel_emissions_all_delegates_summary.json")
ALL_DELEGATES_DETAILS_PATH = Path("outputs/travel_emissions_all_delegates_by_attendee.csv")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Estimate conference travel emissions for ICRS speakers and delegates using the "
            "emissions.dev Travel API (one query per unique origin route)."
        )
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT_PATH,
        help="Path for speaker-pool JSON summary output.",
    )
    parser.add_argument(
        "--details-output",
        type=Path,
        default=Path("outputs/travel_emissions_by_attendee.csv"),
        help="Path for speaker-pool per-attendee CSV output.",
    )
    parser.add_argument(
        "--all-delegates-output",
        type=Path,
        default=ALL_DELEGATES_OUTPUT_PATH,
        help="Path for all-delegates JSON summary output.",
    )
    parser.add_argument(
        "--all-delegates-details-output",
        type=Path,
        default=ALL_DELEGATES_DETAILS_PATH,
        help="Path for all-delegates per-attendee CSV output.",
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
    parser.add_argument(
        "--skip-delegates",
        action="store_true",
        help="Skip the all-delegates pool (speakers only).",
    )
    parser.add_argument(
        "--delegates-only",
        action="store_true",
        help="Reuse existing speaker outputs; estimate and export only the all-delegates pool.",
    )
    return parser.parse_args()


def _delegate_meta(delegates) -> dict:
    non_speakers = delegates.loc[~delegates["is_speaker"]]
    return {
        "delegate_list_count": int(len(delegates)),
        "speaker_count": int(delegates["is_speaker"].sum()),
        "non_speaker_count": int(len(non_speakers)),
        "source_pdf": str(DEFAULT_DELEGATE_PDF_PATH),
    }


def _save_outputs(estimates, summary, summary_path: Path, details_path: Path) -> None:
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    details_path.parent.mkdir(parents=True, exist_ok=True)
    with summary_path.open("w", encoding="utf-8") as handle:
        json.dump(summary, handle, indent=2)
    estimates.to_csv(details_path, index=False)


def main() -> None:
    args = parse_args()
    delegates = None
    delegate_meta: dict = {}
    if not args.skip_delegates and DEFAULT_DELEGATE_PDF_PATH.exists():
        delegates = load_delegates()
        delegate_meta = _delegate_meta(delegates)

    if args.export_site_only:
        if not args.output.exists() or not args.details_output.exists():
            raise SystemExit("Need existing summary JSON and attendee CSV for --export-site-only.")
        import pandas as pd

        with args.output.open(encoding="utf-8") as handle:
            speaker_summary = json.load(handle)
        speaker_estimates = pd.read_csv(args.details_output)
        speaker_legs, _ = load_attendee_legs(load_geocoded_talks(), show_progress=False)

        all_delegates = None
        if args.all_delegates_output.exists() and args.all_delegates_details_output.exists():
            with args.all_delegates_output.open(encoding="utf-8") as handle:
                delegate_summary = json.load(handle)
            delegate_estimates = pd.read_csv(args.all_delegates_details_output)
            if delegates is not None:
                all_talks = combined_attendee_talks(
                    load_geocoded_talks(),
                    include_non_speakers=True,
                    delegates=delegates,
                    show_progress=False,
                )
                delegate_legs, _ = load_attendee_legs(all_talks, show_progress=False)
            else:
                delegate_legs = speaker_legs
            all_delegates = (delegate_estimates, delegate_summary, delegate_legs)

        locations = load_site_locations("js/locations.js")
        export_emissions_site_data(
            speaker_estimates,
            speaker_summary,
            locations,
            legs=speaker_legs,
            all_delegates=all_delegates,
            delegate_meta=delegate_meta,
            save_path=args.site_output,
        )
        console.print(f"Rebuilt site export at [green]{args.site_output}[/]")
        return

    speaker_talks = load_geocoded_talks()
    speaker_legs, speaker_missing = load_attendee_legs(
        speaker_talks,
        show_progress=True,
        refresh_incomplete=args.refresh_geocodes,
    )
    unique_routes = speaker_legs.drop_duplicates(
        subset=["origin_country", "origin_location", "transport_mode"]
    )

    console.print(
        f"[bold]Speakers with locations:[/] {len(speaker_legs):,} | "
        f"[bold]Missing:[/] {len(speaker_missing):,} | "
        f"[bold]Unique routes:[/] {len(unique_routes):,}"
    )

    all_talks = speaker_talks
    all_legs = speaker_legs
    all_missing = speaker_missing
    if delegates is not None:
        all_talks = combined_attendee_talks(
            speaker_talks,
            include_non_speakers=True,
            delegates=delegates,
            show_progress=True,
        )
        all_legs, all_missing = load_attendee_legs(
            all_talks,
            show_progress=True,
            refresh_incomplete=args.refresh_geocodes,
        )
        all_unique = all_legs.drop_duplicates(
            subset=["origin_country", "origin_location", "transport_mode"]
        )
        console.print(
            f"[bold]All delegates with locations:[/] {len(all_legs):,} | "
            f"[bold]Missing:[/] {len(all_missing):,} | "
            f"[bold]Unique routes:[/] {len(all_unique):,} | "
            f"[bold]Non-speakers on list:[/] {delegate_meta['non_speaker_count']:,}"
        )

    console.print(
        "[dim]Efficient mode uses 1 API query per unique route "
        f"(~{len(unique_routes):,} speaker routes; cache reused for delegates).[/]"
    )

    if args.dry_run:
        console.print(unique_routes.head(10).to_string(index=False))
        if delegates is not None:
            console.print("\n[bold]Additional delegate-only routes:[/]")
            speaker_route_keys = set(
                zip(
                    speaker_legs["origin_country"],
                    speaker_legs["origin_location"],
                    speaker_legs["transport_mode"],
                    strict=False,
                )
            )
            extra = all_legs[
                ~all_legs.apply(
                    lambda row: (
                        row["origin_country"],
                        row["origin_location"],
                        row["transport_mode"],
                    )
                    in speaker_route_keys,
                    axis=1,
                )
            ].drop_duplicates(subset=["origin_country", "origin_location", "transport_mode"])
            console.print(extra.head(10).to_string(index=False))
        return

    api_key = load_api_key(args.keys_path)
    route_limit = 1 if args.smoke_test else args.limit

    if args.smoke_test:
        console.print("[yellow]Smoke test:[/] querying 1 unique route only.")

    speaker_estimates = None
    speaker_summary = None
    if args.delegates_only:
        import pandas as pd

        if not args.output.exists() or not args.details_output.exists():
            raise SystemExit("Need existing speaker summary + CSV for --delegates-only.")
        with args.output.open(encoding="utf-8") as handle:
            speaker_summary = json.load(handle)
        speaker_estimates = pd.read_csv(args.details_output)
        speaker_legs, _ = load_attendee_legs(load_geocoded_talks(), show_progress=False)
    else:
        speaker_estimates, speaker_summary = estimate_conference_travel(
            speaker_talks,
            api_key=api_key,
            legs=speaker_legs,
            missing=speaker_missing,
            travel_cache_path=args.travel_cache,
            show_progress=True,
            refresh_incomplete=args.refresh_geocodes,
            limit=route_limit,
        )
        _save_outputs(speaker_estimates, speaker_summary, args.output, args.details_output)

    delegate_bundle = None
    if delegates is not None and not args.smoke_test and not args.skip_delegates:
        delegate_estimates, delegate_summary = estimate_conference_travel(
            all_talks,
            api_key=api_key,
            legs=all_legs,
            missing=all_missing,
            travel_cache_path=args.travel_cache,
            show_progress=True,
            refresh_incomplete=args.refresh_geocodes,
            limit=args.limit,
            attendee_label="delegates",
            exclusion_note=(
                "Delegates without geocoded affiliations are excluded. "
                f"The published list has {delegate_meta.get('delegate_list_count', 0):,} names; "
                f"{delegate_meta.get('non_speaker_count', 0):,} are not programme speakers."
            ),
        )
        _save_outputs(
            delegate_estimates,
            delegate_summary,
            args.all_delegates_output,
            args.all_delegates_details_output,
        )
        delegate_bundle = (delegate_estimates, delegate_summary, all_legs)
        console.print(
            f"\n[bold]All delegates:[/] {delegate_summary['attendees_estimated']:,} estimated · "
            f"{delegate_summary['co2e_tonnes']:,.1f} t CO₂e"
        )

    locations = load_site_locations("js/locations.js")
    export_emissions_site_data(
        speaker_estimates,
        speaker_summary,
        locations,
        legs=speaker_legs,
        all_delegates=delegate_bundle,
        delegate_meta=delegate_meta,
        save_path=args.site_output,
    )
    if args.delegates_only:
        console.print(f"\nAPI queries this run: [bold]{api_query_count():,}[/]")
    else:
        print_travel_summary(speaker_summary)
        console.print(f"\nAPI queries this run: [bold]{api_query_count():,}[/]")
        console.print(f"Saved speaker summary to [green]{args.output}[/]")
        console.print(f"Saved speaker details to [green]{args.details_output}[/]")
    if delegate_bundle is not None:
        console.print(f"Saved all-delegates summary to [green]{args.all_delegates_output}[/]")
        console.print(f"Saved all-delegates details to [green]{args.all_delegates_details_output}[/]")
    console.print(f"Saved site data to [green]{args.site_output}[/]")

    if args.smoke_test:
        console.print(
            "\n[green]Smoke test passed.[/] Re-run without --smoke-test to fetch all unique routes."
        )


if __name__ == "__main__":
    main()
