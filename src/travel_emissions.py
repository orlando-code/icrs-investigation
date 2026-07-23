"""Estimate conference travel emissions via emissions.dev."""

from __future__ import annotations

import hashlib
import json
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pandas as pd
import requests
from geopy.exc import GeocoderServiceError, GeocoderTimedOut
from geopy.geocoders import Nominatim
from rich.console import Console
from rich.table import Table

from src.geocode import attach_coordinates, geocode_affiliations
from src.programme import load_talks

API_BASE_URL = "https://api.emissions.dev/v1/travel/emissions"
DEFAULT_DESTINATION_COUNTRY = "NZ"
DEFAULT_DESTINATION_LOCATION = "AKL"
DEFAULT_REVERSE_CACHE_PATH = Path("data/reverse_geocode_cache.json")
DEFAULT_TRAVEL_CACHE_PATH = Path("data/travel_emissions_cache.json")
DEFAULT_OUTPUT_PATH = Path("outputs/travel_emissions_summary.json")
DEFAULT_USER_AGENT = "icrs-investigation/0.1"
_CONSOLE = Console()


@dataclass(frozen=True)
class TravelLeg:
    presenter: str
    affiliation: str
    origin_country: str
    origin_location: str
    transport_mode: str
    geocode_level: str | None
    latitude: float
    longitude: float


@dataclass(frozen=True)
class TravelEstimate:
    presenter: str
    affiliation: str
    transport_mode: str
    origin_country: str
    origin_location: str
    geocode_level: str | None
    co2e_kg: float
    co2e_low_kg: float
    co2e_high_kg: float
    distance_km: float | None
    passengers: int
    return_trip: bool
    query_used: dict[str, Any]


def _load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def _save_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)


def _api_key() -> str | None:
    return os.environ.get("EMISSIONS_DEV_API_KEY") or os.environ.get("EMISSIONS_API_KEY")


def _cache_key(params: dict[str, Any]) -> str:
    serialized = json.dumps(params, sort_keys=True)
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def _reverse_geocode(
    lat: float,
    lon: float,
    *,
    geolocator: Nominatim,
    cache: dict[str, dict[str, str]],
    pause_seconds: float = 1.0,
) -> dict[str, str]:
    key = f"{lat:.4f},{lon:.4f}"
    if key in cache:
        return cache[key]

    for attempt in range(3):
        try:
            location = geolocator.reverse((lat, lon), language="en", timeout=10)
            break
        except (GeocoderTimedOut, GeocoderServiceError):
            if attempt == 2:
                location = None
            time.sleep(pause_seconds * (attempt + 1))
    else:
        location = None

    if location is None or not location.raw.get("address"):
        result = {"country_code": "", "location_name": f"{lat:.3f},{lon:.3f}"}
    else:
        address = location.raw["address"]
        country_code = (address.get("country_code") or "").upper()
        location_name = (
            address.get("city")
            or address.get("town")
            or address.get("village")
            or address.get("state")
            or address.get("county")
            or address.get("country")
            or f"{lat:.3f},{lon:.3f}"
        )
        result = {"country_code": country_code, "location_name": location_name}

    cache[key] = result
    time.sleep(pause_seconds)
    return result


def load_attendee_legs(
    talks_geo: pd.DataFrame,
    *,
    reverse_cache_path: Path = DEFAULT_REVERSE_CACHE_PATH,
    pause_seconds: float = 1.0,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Return one travel leg per unique presenter with a geocoded affiliation."""
    geolocator = Nominatim(user_agent=DEFAULT_USER_AGENT)
    reverse_cache = _load_json(reverse_cache_path)

    attendees = (
        talks_geo.dropna(subset=["latitude", "longitude"])
        .sort_values(["presenter", "geocode_level"], na_position="last")
        .drop_duplicates(subset=["presenter"], keep="first")
        .copy()
    )

    rows: list[dict[str, Any]] = []
    for _, row in attendees.iterrows():
        geo = _reverse_geocode(
            float(row["latitude"]),
            float(row["longitude"]),
            geolocator=geolocator,
            cache=reverse_cache,
            pause_seconds=pause_seconds,
        )
        origin_country = geo["country_code"] or "Unknown"
        transport_mode = "car" if origin_country == DEFAULT_DESTINATION_COUNTRY else "flight"
        rows.append(
            {
                "presenter": row["presenter"],
                "affiliation": row["affiliation"],
                "latitude": row["latitude"],
                "longitude": row["longitude"],
                "geocode_level": row.get("geocode_level"),
                "origin_country": origin_country,
                "origin_location": geo["location_name"],
                "transport_mode": transport_mode,
            }
        )
    _save_json(reverse_cache_path, reverse_cache)

    legs = pd.DataFrame(rows)
    missing = talks_geo.loc[~talks_geo["presenter"].isin(legs["presenter"]), "presenter"].drop_duplicates()
    missing_df = pd.DataFrame({"presenter": missing})
    return legs, missing_df


def _query_travel_emissions(
    params: dict[str, Any],
    *,
    api_key: str,
    cache: dict[str, Any],
    cache_path: Path,
    pause_seconds: float,
) -> dict[str, Any]:
    key = _cache_key(params)
    if key in cache:
        return cache[key]

    response = requests.get(
        API_BASE_URL,
        params=params,
        headers={"Authorization": f"Bearer {api_key}"},
        timeout=30,
    )
    response.raise_for_status()
    payload = response.json()
    cache[key] = payload
    _save_json(cache_path, cache)
    time.sleep(pause_seconds)
    return payload


def _extract_co2e(payload: dict[str, Any]) -> tuple[float, float | None]:
    attrs = payload["data"]["attributes"]
    emissions = attrs["emissions"]
    distance = attrs.get("route", {}).get("total_distance_km")
    return float(emissions["co2e"]), None if distance is None else float(distance)


def _leg_value(leg: TravelLeg | pd.Series | dict[str, Any], key: str) -> Any:
    if isinstance(leg, dict):
        return leg[key]
    if isinstance(leg, pd.Series):
        return leg[key]
    return getattr(leg, key)


def estimate_leg_emissions(
    leg: TravelLeg | pd.Series | dict[str, Any],
    *,
    api_key: str,
    cache: dict[str, Any],
    cache_path: Path,
    nz_car_passengers: int = 2,
    nz_car_passengers_low: int = 4,
    nz_car_passengers_high: int = 1,
    flight_cabin_central: str = "economy",
    flight_cabin_high: str = "business",
    pause_seconds: float = 0.2,
) -> TravelEstimate:
    base_params = {
        "origin_country": _leg_value(leg, "origin_country"),
        "origin_location": _leg_value(leg, "origin_location"),
        "destination_country": DEFAULT_DESTINATION_COUNTRY,
        "destination_location": DEFAULT_DESTINATION_LOCATION,
        "return_trip": True,
        "passengers": 1,
    }
    transport_mode = _leg_value(leg, "transport_mode")

    if transport_mode == "car":
        central_params = {
            **base_params,
            "transport_mode": "car",
            "passengers": nz_car_passengers,
            "vehicle_type": "average",
        }
        low_params = {**central_params, "passengers": nz_car_passengers_low}
        high_params = {**central_params, "passengers": nz_car_passengers_high}
    else:
        central_params = {
            **base_params,
            "transport_mode": "flight",
            "cabin_class": flight_cabin_central,
        }
        low_params = central_params
        high_params = {**base_params, "transport_mode": "flight", "cabin_class": flight_cabin_high}

    central_payload = _query_travel_emissions(
        central_params,
        api_key=api_key,
        cache=cache,
        cache_path=cache_path,
        pause_seconds=pause_seconds,
    )
    low_payload = _query_travel_emissions(
        low_params,
        api_key=api_key,
        cache=cache,
        cache_path=cache_path,
        pause_seconds=pause_seconds,
    )
    high_payload = _query_travel_emissions(
        high_params,
        api_key=api_key,
        cache=cache,
        cache_path=cache_path,
        pause_seconds=pause_seconds,
    )

    central_co2e, distance_km = _extract_co2e(central_payload)
    low_co2e, _ = _extract_co2e(low_payload)
    high_co2e, _ = _extract_co2e(high_payload)

    if isinstance(leg, (pd.Series, dict)):
        presenter = _leg_value(leg, "presenter")
        affiliation = _leg_value(leg, "affiliation")
        geocode_level = _leg_value(leg, "geocode_level")
        origin_country = _leg_value(leg, "origin_country")
        origin_location = _leg_value(leg, "origin_location")
    else:
        presenter = leg.presenter
        affiliation = leg.affiliation
        geocode_level = leg.geocode_level
        origin_country = leg.origin_country
        origin_location = leg.origin_location

    return TravelEstimate(
        presenter=presenter,
        affiliation=affiliation,
        transport_mode=transport_mode,
        origin_country=origin_country,
        origin_location=origin_location,
        geocode_level=geocode_level,
        co2e_kg=central_co2e,
        co2e_low_kg=min(low_co2e, high_co2e),
        co2e_high_kg=max(low_co2e, high_co2e),
        distance_km=distance_km,
        passengers=nz_car_passengers if transport_mode == "car" else 1,
        return_trip=True,
        query_used=central_params,
    )


def estimate_conference_travel(
    talks_geo: pd.DataFrame,
    *,
    api_key: str,
    legs: pd.DataFrame | None = None,
    missing: pd.DataFrame | None = None,
    travel_cache_path: Path = DEFAULT_TRAVEL_CACHE_PATH,
    reverse_cache_path: Path = DEFAULT_REVERSE_CACHE_PATH,
    pause_seconds: float = 0.2,
    show_progress: bool = True,
) -> tuple[pd.DataFrame, dict[str, Any]]:
    if legs is None or missing is None:
        legs, missing = load_attendee_legs(
            talks_geo,
            reverse_cache_path=reverse_cache_path,
            pause_seconds=1.0,
        )
    cache = _load_json(travel_cache_path)

    estimates: list[TravelEstimate] = []
    leg_records = legs.to_dict(orient="records")
    if show_progress:
        from rich.progress import BarColumn, MofNCompleteColumn, Progress, SpinnerColumn, TextColumn, TimeElapsedColumn

        progress = Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            MofNCompleteColumn(),
            TimeElapsedColumn(),
            console=_CONSOLE,
        )
        with progress:
            task_id = progress.add_task("Querying emissions.dev", total=len(leg_records))
            for leg in leg_records:
                progress.update(task_id, description=f"[cyan]{leg['presenter'][:36]}[/]")
                estimates.append(
                    estimate_leg_emissions(
                        leg,
                        api_key=api_key,
                        cache=cache,
                        cache_path=travel_cache_path,
                        pause_seconds=pause_seconds,
                    )
                )
                progress.advance(task_id)
    else:
        for leg in leg_records:
            estimates.append(
                estimate_leg_emissions(
                    leg,
                    api_key=api_key,
                    cache=cache,
                    cache_path=travel_cache_path,
                    pause_seconds=pause_seconds,
                )
            )

    estimate_df = pd.DataFrame([estimate.__dict__ for estimate in estimates])
    summary = summarize_travel_emissions(estimate_df, missing_count=len(missing), total_presenters=talks_geo["presenter"].nunique())
    return estimate_df, summary


def summarize_travel_emissions(
    estimates: pd.DataFrame,
    *,
    missing_count: int,
    total_presenters: int,
) -> dict[str, Any]:
    country_level = estimates["geocode_level"].eq("country").sum() if "geocode_level" in estimates.columns else 0
    summary = {
        "attendees_estimated": int(len(estimates)),
        "attendees_missing_location": int(missing_count),
        "unique_presenters": int(total_presenters),
        "destination": {
            "country": DEFAULT_DESTINATION_COUNTRY,
            "location": DEFAULT_DESTINATION_LOCATION,
        },
        "assumptions": {
            "non_nz_transport": "return flight to Auckland Airport (economy central, business upper bound)",
            "nz_transport": "return car trip to Auckland Airport (shared car; 2 passengers central, 4 low, 1 high)",
            "return_trip": True,
        },
        "co2e_kg": float(estimates["co2e_kg"].sum()),
        "co2e_low_kg": float(estimates["co2e_low_kg"].sum()),
        "co2e_high_kg": float(estimates["co2e_high_kg"].sum()),
        "co2e_tonnes": float(estimates["co2e_kg"].sum() / 1_000),
        "by_transport_mode": estimates.groupby("transport_mode")[["co2e_kg", "co2e_low_kg", "co2e_high_kg"]]
        .sum()
        .reset_index()
        .to_dict(orient="records"),
        "uncertainty": {
            "missing_location_presenters": int(missing_count),
            "country_level_origins": int(country_level),
            "cabin_class_range": "economy to business for flights",
            "nz_car_occupancy_range": "2 to 4 passengers",
            "notes": [
                "Lower bound uses more car-sharing for NZ attendees and economy flights elsewhere.",
                "Upper bound uses fewer car-shares for NZ attendees and business-class flights elsewhere.",
                "Speakers without geocoded affiliations are excluded from totals.",
            ],
        },
    }
    return summary


def print_travel_summary(summary: dict[str, Any]) -> None:
    table = Table(title="ICRS 2026 travel emissions estimate")
    table.add_column("Metric")
    table.add_column("Value", justify="right")
    table.add_row("Attendees estimated", f"{summary['attendees_estimated']:,}")
    table.add_row("Missing location", f"{summary['attendees_missing_location']:,}")
    table.add_row("Central total", f"{summary['co2e_kg']:,.0f} kg CO2e ({summary['co2e_tonnes']:,.1f} t)")
    table.add_row("Range", f"{summary['co2e_low_kg']:,.0f} – {summary['co2e_high_kg']:,.0f} kg CO2e")
    _CONSOLE.print(table)

    mode_table = Table(title="By transport mode")
    mode_table.add_column("Mode")
    mode_table.add_column("Central kg", justify="right")
    mode_table.add_column("Low kg", justify="right")
    mode_table.add_column("High kg", justify="right")
    for row in summary["by_transport_mode"]:
        mode_table.add_row(
            str(row["transport_mode"]),
            f"{row['co2e_kg']:,.0f}",
            f"{row['co2e_low_kg']:,.0f}",
            f"{row['co2e_high_kg']:,.0f}",
        )
    _CONSOLE.print(mode_table)


def load_geocoded_talks() -> pd.DataFrame:
    talks = load_talks()
    geocoded = geocode_affiliations(talks["affiliation"].dropna().unique(), show_progress=False)
    return attach_coordinates(talks, geocoded)
