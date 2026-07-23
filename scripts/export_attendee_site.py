#!/usr/bin/env python3
"""Export geocoded affiliation locations for the static JS map site."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from src.geocode import attach_coordinates, geocode_affiliations
from src.plot_utils import export_attendee_site_data
from src.programme import load_talks


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        default="js/locations.js",
        help="Path to write the generated locations module",
    )
    parser.add_argument(
        "--retry-failed",
        action="store_true",
        help="Re-query affiliations that previously failed geocoding",
    )
    args = parser.parse_args()

    talks = load_talks()
    geocoded = geocode_affiliations(
        talks["affiliation"].dropna().unique(),
        retry_failed=args.retry_failed,
        show_progress=True,
    )
    talks_geo = attach_coordinates(talks, geocoded)
    output = export_attendee_site_data(talks_geo, save_path=args.output)
    stats = output.read_text(encoding="utf-8").split('"stats":', 1)[-1][:120]
    print(f"Wrote {output}")
    print(f"Preview: ...stats{stats}...")


if __name__ == "__main__":
    main()
