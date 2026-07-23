"""Estimate conference travel emissions via emissions.dev."""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pandas as pd
import pycountry
import requests
from geopy.exc import GeocoderServiceError, GeocoderTimedOut
from geopy.geocoders import Nominatim
from rich.console import Console
from rich.table import Table

from src.geocode import _extract_country_hints, attach_coordinates, geocode_affiliations
from src.programme import load_talks

API_BASE_URL = "https://api.emissions.dev/v1/travel/emissions"
API_CONNECT_TIMEOUT_SECONDS = 15
API_READ_TIMEOUT_SECONDS = 90
API_MAX_RETRIES = 5
API_RETRY_BACKOFF_SECONDS = 3.0
API_RETRY_STATUS_CODES = {429, 500, 502, 503, 504}
DEFAULT_DESTINATION_COUNTRY = "NZ"
DEFAULT_DESTINATION_LOCATION = "AKL"
DEFAULT_KEYS_PATH = Path("keys.yaml")
DEFAULT_REVERSE_CACHE_PATH = Path("data/reverse_geocode_cache.json")
DEFAULT_TRAVEL_CACHE_PATH = Path("data/travel_emissions_cache.json")
DEFAULT_OUTPUT_PATH = Path("outputs/travel_emissions_summary.json")
DEFAULT_EMISSIONS_SITE_PATH = Path("js/emissions-data.js")
DEFAULT_USER_AGENT = "icrs-investigation/0.1"
FLIGHT_BUSINESS_MULTIPLIER = 2.9
NZ_CAR_PASSENGERS_CENTRAL = 2
NZ_CAR_PASSENGERS_LOW = 4
NZ_CAR_PASSENGERS_HIGH = 1
_CONSOLE = Console()
_query_count = 0


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


def load_site_locations(
    path: str | Path = "js/locations.js",
) -> list[dict[str, Any]]:
    """Load affiliation locations exported for the static site."""
    js_path = Path(path)
    if not js_path.exists():
        raise FileNotFoundError(f"Site locations file not found: {js_path}")
    text = js_path.read_text(encoding="utf-8")
    marker = "export const SITE_DATA = "
    start = text.find(marker)
    if start < 0:
        raise ValueError(f"Could not parse SITE_DATA from {js_path}")
    payload = json.loads(text[start + len(marker) :].rstrip().rstrip(";"))
    return payload.get("locations", [])


def _api_key() -> str | None:
    return os.environ.get("EMISSIONS_DEV_API_KEY") or os.environ.get("EMISSIONS_API_KEY")


def load_api_key(keys_path: Path = DEFAULT_KEYS_PATH) -> str:
    """Load emissions.dev API key from env or keys.yaml."""
    env_key = _api_key()
    if env_key:
        return env_key

    if not keys_path.exists():
        raise ValueError(
            f"Missing API key. Set EMISSIONS_DEV_API_KEY or create {keys_path} "
            "(see https://emissions.dev/register)."
        )

    try:
        import yaml
    except ImportError as exc:
        raise ImportError("PyYAML is required to read keys.yaml") from exc

    payload = yaml.safe_load(keys_path.read_text(encoding="utf-8")) or {}
    for name in ("emissions-dev", "emissions_dev", "emissions.dev"):
        value = payload.get(name)
        if value:
            return str(value).strip()

    raise ValueError(f"No emissions-dev key found in {keys_path}")


def api_query_count() -> int:
    return _query_count


def _route_key(origin_country: str, origin_location: str, transport_mode: str) -> str:
    return "|".join(
        [
            origin_country.strip().upper(),
            origin_location.strip().casefold(),
            transport_mode.strip().casefold(),
        ]
    )


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
    refresh_incomplete: bool = False,
) -> dict[str, str]:
    key = f"{lat:.4f},{lon:.4f}"
    cached = cache.get(key)
    if cached is not None and (cached.get("country_code") or not refresh_incomplete):
        return cached

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


def _country_name_to_alpha2(country_name: str) -> str | None:
    try:
        return pycountry.countries.lookup(country_name).alpha_2
    except LookupError:
        return None


def _looks_like_coordinates(value: str) -> bool:
    return bool(re.fullmatch(r"-?\d+\.\d+,-?\d+\.\d+", value.strip()))


def _origin_from_attendee(
    affiliation: str,
    geo: dict[str, str],
    *,
    geocode_level: str | None,
) -> tuple[str, str]:
    """Resolve emissions.dev origin country (ISO-2) and city/location label."""
    affiliation_text = "" if pd.isna(affiliation) else str(affiliation)
    hints = _extract_country_hints(affiliation_text)
    country_code = (geo.get("country_code") or "").upper()
    location_name = (geo.get("location_name") or "").strip()

    if not hints and location_name:
        hints = _extract_country_hints(location_name)
        if not hints and "," in location_name:
            hints = _extract_country_hints(location_name.rsplit(",", 1)[-1])

    country_name = hints[0] if hints else None
    if not country_code and country_name:
        country_code = _country_name_to_alpha2(country_name) or ""

    if not country_code:
        country_code = "Unknown"

    if geocode_level == "country" and country_name:
        origin_location = country_name
    elif location_name and not _looks_like_coordinates(location_name):
        origin_location = location_name.split(",")[0].strip() or location_name
    elif country_name:
        origin_location = country_name
    else:
        origin_location = location_name or "Unknown"

    return country_code, origin_location


def _try_affiliation_geo(
    affiliation: str,
    geocode_level: str | None,
) -> dict[str, str] | None:
    """Skip Nominatim when affiliation already defines a country-level origin."""
    if geocode_level != "country":
        return None
    affiliation_text = "" if pd.isna(affiliation) else str(affiliation)
    hints = _extract_country_hints(affiliation_text)
    if not hints:
        return None
    country_code = _country_name_to_alpha2(hints[0]) or ""
    if not country_code:
        return None
    return {"country_code": country_code, "location_name": hints[0]}


def load_attendee_legs(
    talks_geo: pd.DataFrame,
    *,
    reverse_cache_path: Path = DEFAULT_REVERSE_CACHE_PATH,
    pause_seconds: float = 1.0,
    show_progress: bool = True,
    refresh_incomplete: bool = False,
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

    coord_rows = (
        attendees.groupby(["latitude", "longitude"], as_index=False)
        .agg(affiliation=("affiliation", "first"), geocode_level=("geocode_level", "first"))
        .sort_values(["latitude", "longitude"])
    )
    coord_lookup: dict[tuple[float, float], dict[str, str]] = {}

    def process_coord(row: Any) -> None:
        lat = float(row.latitude)
        lon = float(row.longitude)
        fast_geo = _try_affiliation_geo(row.affiliation, row.geocode_level)
        if fast_geo is not None:
            coord_lookup[(lat, lon)] = fast_geo
            return
        coord_lookup[(lat, lon)] = _reverse_geocode(
            lat,
            lon,
            geolocator=geolocator,
            cache=reverse_cache,
            pause_seconds=pause_seconds,
            refresh_incomplete=refresh_incomplete,
        )

    if show_progress:
        from rich.progress import BarColumn, MofNCompleteColumn, Progress, SpinnerColumn, TextColumn, TimeElapsedColumn, TimeRemainingColumn

        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            MofNCompleteColumn(),
            TimeElapsedColumn(),
            TimeRemainingColumn(),
            console=_CONSOLE,
        ) as progress:
            task_id = progress.add_task("Reverse geocoding coordinates", total=len(coord_rows))
            for row in coord_rows.itertuples(index=False):
                lat = float(row.latitude)
                lon = float(row.longitude)
                progress.update(task_id, description=f"[cyan]Geocode {lat:.2f}, {lon:.2f}[/]")
                process_coord(row)
                progress.advance(task_id)
    else:
        for row in coord_rows.itertuples(index=False):
            process_coord(row)

    rows: list[dict[str, Any]] = []
    for _, row in attendees.iterrows():
        lat = float(row["latitude"])
        lon = float(row["longitude"])
        geo = coord_lookup[(lat, lon)]
        origin_country, origin_location = _origin_from_attendee(
            row["affiliation"],
            geo,
            geocode_level=row.get("geocode_level"),
        )
        transport_mode = "car" if origin_country == DEFAULT_DESTINATION_COUNTRY else "flight"
        rows.append(
            {
                "presenter": row["presenter"],
                "affiliation": row["affiliation"],
                "latitude": row["latitude"],
                "longitude": row["longitude"],
                "geocode_level": row.get("geocode_level"),
                "origin_country": origin_country,
                "origin_location": origin_location,
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
    global _query_count
    key = _cache_key(params)
    if key in cache:
        return cache[key]

    last_error: Exception | None = None
    route_label = f"{params.get('origin_country')} · {params.get('origin_location')}"
    for attempt in range(API_MAX_RETRIES):
        try:
            response = requests.get(
                API_BASE_URL,
                params=params,
                headers={"Authorization": f"Bearer {api_key}"},
                timeout=(API_CONNECT_TIMEOUT_SECONDS, API_READ_TIMEOUT_SECONDS),
            )
            if response.status_code in API_RETRY_STATUS_CODES:
                raise requests.HTTPError(
                    f"{response.status_code} from emissions.dev",
                    response=response,
                )
            response.raise_for_status()
            payload = response.json()
            cache[key] = payload
            _save_json(cache_path, cache)
            _query_count += 1
            time.sleep(pause_seconds)
            return payload
        except (
            requests.exceptions.Timeout,
            requests.exceptions.ConnectionError,
            requests.exceptions.ChunkedEncodingError,
        ) as exc:
            last_error = exc
        except requests.HTTPError as exc:
            status = exc.response.status_code if exc.response is not None else None
            if status not in API_RETRY_STATUS_CODES:
                raise
            last_error = exc

        if attempt < API_MAX_RETRIES - 1:
            wait = API_RETRY_BACKOFF_SECONDS * (2**attempt)
            _CONSOLE.print(
                f"[yellow]API error for {route_label} "
                f"(attempt {attempt + 1}/{API_MAX_RETRIES}): {last_error}. "
                f"Retrying in {wait:.0f}s…[/]"
            )
            time.sleep(wait)

    assert last_error is not None
    raise last_error


def _extract_co2e(payload: dict[str, Any]) -> tuple[float, float | None]:
    attrs = payload["data"]["attributes"]
    emissions = attrs["emissions"]
    distance = attrs.get("route", {}).get("total_distance_km")
    return float(emissions["co2e"]), None if distance is None else float(distance)


def _bounds_from_central(central_co2e: float, transport_mode: str) -> tuple[float, float]:
    if transport_mode == "car":
        low = central_co2e * (NZ_CAR_PASSENGERS_CENTRAL / NZ_CAR_PASSENGERS_LOW)
        high = central_co2e * (NZ_CAR_PASSENGERS_CENTRAL / NZ_CAR_PASSENGERS_HIGH)
        return low, high
    return central_co2e, central_co2e * FLIGHT_BUSINESS_MULTIPLIER


def _central_params_for_route(
    origin_country: str,
    origin_location: str,
    transport_mode: str,
) -> dict[str, Any]:
    base = {
        "origin_country": origin_country,
        "origin_location": origin_location,
        "destination_country": DEFAULT_DESTINATION_COUNTRY,
        "destination_location": "Auckland",
        "return_trip": "true",
        "passengers": 1,
    }
    if transport_mode == "car":
        return {
            **base,
            "transport_mode": "car",
            "passengers": NZ_CAR_PASSENGERS_CENTRAL,
            "vehicle_type": "average",
        }
    return {
        **base,
        "transport_mode": "flight",
        "cabin_class": "economy",
    }


def estimate_unique_routes(
    legs: pd.DataFrame,
    *,
    api_key: str,
    travel_cache_path: Path = DEFAULT_TRAVEL_CACHE_PATH,
    pause_seconds: float = 0.2,
    show_progress: bool = True,
    limit: int | None = None,
) -> pd.DataFrame:
    """Query emissions.dev once per unique origin route (efficient for API quotas)."""
    cache = _load_json(travel_cache_path)
    routes = (
        legs.drop_duplicates(subset=["origin_country", "origin_location", "transport_mode"])
        .sort_values(["transport_mode", "origin_country", "origin_location"])
        .reset_index(drop=True)
    )
    if limit is not None:
        routes = routes.head(limit)

    rows: list[dict[str, Any]] = []
    if show_progress:
        from rich.progress import BarColumn, MofNCompleteColumn, Progress, SpinnerColumn, TextColumn, TimeElapsedColumn, TimeRemainingColumn

        progress = Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            MofNCompleteColumn(),
            TimeElapsedColumn(),
            TimeRemainingColumn(),
            console=_CONSOLE,
        )
    else:
        progress = None

    iterator: Any = routes.itertuples(index=False)
    if progress is not None:
        with progress:
            task_id = progress.add_task("Querying emissions.dev", total=len(routes))
            for route in routes.itertuples(index=False):
                progress.update(
                    task_id,
                    description=f"[cyan]{route.origin_country} · {str(route.origin_location)[:28]}[/]",
                )
                rows.append(
                    _estimate_route_row(
                        route._asdict(),
                        api_key=api_key,
                        cache=cache,
                        cache_path=travel_cache_path,
                        pause_seconds=pause_seconds,
                    )
                )
                progress.advance(task_id)
    else:
        for route in routes.itertuples(index=False):
            rows.append(
                _estimate_route_row(
                    route._asdict(),
                    api_key=api_key,
                    cache=cache,
                    cache_path=travel_cache_path,
                    pause_seconds=pause_seconds,
                )
            )

    return pd.DataFrame(rows)


def _estimate_route_row(
    route: dict[str, Any],
    *,
    api_key: str,
    cache: dict[str, Any],
    cache_path: Path,
    pause_seconds: float,
) -> dict[str, Any]:
    params = _central_params_for_route(
        str(route["origin_country"]),
        str(route["origin_location"]),
        str(route["transport_mode"]),
    )
    payload = _query_travel_emissions(
        params,
        api_key=api_key,
        cache=cache,
        cache_path=cache_path,
        pause_seconds=pause_seconds,
    )
    central_co2e, distance_km = _extract_co2e(payload)
    low_co2e, high_co2e = _bounds_from_central(central_co2e, str(route["transport_mode"]))
    return {
        "route_key": _route_key(
            str(route["origin_country"]),
            str(route["origin_location"]),
            str(route["transport_mode"]),
        ),
        "origin_country": route["origin_country"],
        "origin_location": route["origin_location"],
        "transport_mode": route["transport_mode"],
        "co2e_kg": central_co2e,
        "co2e_low_kg": low_co2e,
        "co2e_high_kg": high_co2e,
        "distance_km": distance_km,
        "query_used": params,
    }


def attach_route_emissions(legs: pd.DataFrame, routes: pd.DataFrame) -> pd.DataFrame:
    legs = legs.copy()
    legs["route_key"] = legs.apply(
        lambda row: _route_key(row["origin_country"], row["origin_location"], row["transport_mode"]),
        axis=1,
    )
    merged = legs.merge(
        routes[
            [
                "route_key",
                "co2e_kg",
                "co2e_low_kg",
                "co2e_high_kg",
                "distance_km",
            ]
        ],
        on="route_key",
        how="left",
    )
    return merged


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
        "destination_location": "Auckland",
        "return_trip": "true",
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
    refresh_incomplete: bool = False,
    limit: int | None = None,
) -> tuple[pd.DataFrame, dict[str, Any]]:
    if legs is None or missing is None:
        legs, missing = load_attendee_legs(
            talks_geo,
            reverse_cache_path=reverse_cache_path,
            pause_seconds=1.0,
            show_progress=show_progress,
            refresh_incomplete=refresh_incomplete,
        )

    routes = estimate_unique_routes(
        legs,
        api_key=api_key,
        travel_cache_path=travel_cache_path,
        pause_seconds=pause_seconds,
        show_progress=show_progress,
        limit=limit,
    )
    attendee_estimates = attach_route_emissions(legs, routes)
    attendee_estimates = attendee_estimates.dropna(subset=["co2e_kg"])

    estimate_records = []
    for _, row in attendee_estimates.iterrows():
        estimate_records.append(
            TravelEstimate(
                presenter=row["presenter"],
                affiliation=row["affiliation"],
                transport_mode=row["transport_mode"],
                origin_country=row["origin_country"],
                origin_location=row["origin_location"],
                geocode_level=row.get("geocode_level"),
                co2e_kg=float(row["co2e_kg"]),
                co2e_low_kg=float(row["co2e_low_kg"]),
                co2e_high_kg=float(row["co2e_high_kg"]),
                distance_km=None if pd.isna(row.get("distance_km")) else float(row["distance_km"]),
                passengers=NZ_CAR_PASSENGERS_CENTRAL if row["transport_mode"] == "car" else 1,
                return_trip=True,
                query_used={},
            )
        )

    estimate_df = pd.DataFrame([estimate.__dict__ for estimate in estimate_records])
    summary = summarize_travel_emissions(
        estimate_df,
        missing_count=len(missing),
        total_presenters=talks_geo["presenter"].nunique(),
        unique_routes=len(routes),
        api_queries=api_query_count(),
    )
    summary["routes"] = routes.to_dict(orient="records")
    return estimate_df, summary


def summarize_travel_emissions(
    estimates: pd.DataFrame,
    *,
    missing_count: int,
    total_presenters: int,
    unique_routes: int | None = None,
    api_queries: int | None = None,
) -> dict[str, Any]:
    country_level = estimates["geocode_level"].eq("country").sum() if "geocode_level" in estimates.columns else 0
    by_country = (
        estimates.groupby("origin_country")[["co2e_kg", "co2e_low_kg", "co2e_high_kg"]]
        .sum()
        .reset_index()
        .sort_values("co2e_kg", ascending=False)
    )
    by_affiliation = (
        estimates.groupby("affiliation")[["co2e_kg", "co2e_low_kg", "co2e_high_kg"]]
        .sum()
        .reset_index()
        .sort_values("co2e_kg", ascending=False)
    )
    summary = {
        "attendees_estimated": int(len(estimates)),
        "attendees_missing_location": int(missing_count),
        "unique_presenters": int(total_presenters),
        "unique_routes_queried": int(unique_routes or 0),
        "api_queries_used": int(api_queries or 0),
        "destination": {
            "country": DEFAULT_DESTINATION_COUNTRY,
            "location": DEFAULT_DESTINATION_LOCATION,
        },
        "assumptions": {
            "non_nz_transport": "return economy flight to Auckland; upper bound uses business-class multiplier (2.9×)",
            "nz_transport": "return shared car trip; bounds derived from passenger occupancy (not extra API calls)",
            "return_trip": True,
            "api_strategy": "one emissions.dev query per unique origin route; bounds derived from cabin/occupancy multipliers",
        },
        "co2e_kg": float(estimates["co2e_kg"].sum()),
        "co2e_low_kg": float(estimates["co2e_low_kg"].sum()),
        "co2e_high_kg": float(estimates["co2e_high_kg"].sum()),
        "co2e_tonnes": float(estimates["co2e_kg"].sum() / 1_000),
        "by_transport_mode": estimates.groupby("transport_mode")[["co2e_kg", "co2e_low_kg", "co2e_high_kg"]]
        .sum()
        .reset_index()
        .to_dict(orient="records"),
        "by_country": by_country.to_dict(orient="records"),
        "by_affiliation": by_affiliation.head(50).to_dict(orient="records"),
        "uncertainty": {
            "missing_location_presenters": int(missing_count),
            "country_level_origins": int(country_level),
            "cabin_class_range": f"economy to business (~{FLIGHT_BUSINESS_MULTIPLIER}×) for flights",
            "nz_car_occupancy_range": "2 to 4 passengers",
            "notes": [
                "Lower bound uses economy flights and higher car-sharing assumptions.",
                "Upper bound uses business-class multiplier for flights.",
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


def export_emissions_site_data(
    estimates: pd.DataFrame,
    summary: dict[str, Any],
    site_locations: list[dict[str, Any]],
    *,
    save_path: str | Path = DEFAULT_EMISSIONS_SITE_PATH,
) -> Path:
    """Export travel emissions for the static emissions tab."""
    from datetime import UTC, datetime

    affiliation_stats = (
        estimates.groupby("affiliation")
        .agg(
            co2e_kg=("co2e_kg", "sum"),
            co2e_low_kg=("co2e_low_kg", "sum"),
            co2e_high_kg=("co2e_high_kg", "sum"),
            attendee_count=("presenter", "count"),
        )
        .reset_index()
    )
    affiliation_map = {
        row["affiliation"]: row for _, row in affiliation_stats.iterrows()
    }

    location_rows: list[dict[str, Any]] = []
    for location in site_locations:
        stats = affiliation_map.get(location["affiliation"])
        co2e_kg = round(float(stats["co2e_kg"]), 1) if stats is not None else 0.0
        co2e_low_kg = round(float(stats["co2e_low_kg"]), 1) if stats is not None else 0.0
        co2e_high_kg = round(float(stats["co2e_high_kg"]), 1) if stats is not None else 0.0
        attendees = int(stats["attendee_count"]) if stats is not None else 0
        location_rows.append(
            {
                "id": location["id"],
                "affiliation": location["affiliation"],
                "lat": location["lat"],
                "lon": location["lon"],
                "speaker_count": location["speaker_count"],
                "travel_attendees": attendees,
                "co2e_kg": co2e_kg,
                "co2e_low_kg": co2e_low_kg,
                "co2e_high_kg": co2e_high_kg,
                "co2e_per_speaker_kg": round(co2e_kg / max(attendees, 1), 1),
                "distance_km": location.get("distance_km"),
            }
        )

    rankings = sorted(location_rows, key=lambda row: row["co2e_kg"], reverse=True)
    by_country = summary.get("by_country", [])

    payload = {
        "meta": {
            "generated_at": datetime.now(UTC).isoformat(timespec="seconds"),
            "headline": {
                "co2e_kg": round(summary["co2e_kg"], 1),
                "co2e_low_kg": round(summary["co2e_low_kg"], 1),
                "co2e_high_kg": round(summary["co2e_high_kg"], 1),
                "co2e_tonnes": round(summary["co2e_tonnes"], 2),
                "attendees_estimated": summary["attendees_estimated"],
                "attendees_missing_location": summary["attendees_missing_location"],
                "unique_routes_queried": summary.get("unique_routes_queried", 0),
                "api_queries_used": summary.get("api_queries_used", 0),
            },
            "assumptions": summary.get("assumptions", {}),
            "uncertainty": summary.get("uncertainty", {}),
            "by_transport_mode": summary.get("by_transport_mode", []),
        },
        "locations": location_rows,
        "rankings": rankings[:30],
        "by_country": by_country[:30],
    }

    output_path = Path(save_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    js_body = (
        "/** Generated by estimate_travel_emissions.py — do not edit by hand. */\n"
        f"export const EMISSIONS_DATA = {json.dumps(payload, ensure_ascii=True, indent=2)};\n"
    )
    output_path.write_text(js_body, encoding="utf-8")
    return output_path


def load_geocoded_talks() -> pd.DataFrame:
    talks = load_talks()
    geocoded = geocode_affiliations(talks["affiliation"].dropna().unique(), show_progress=False)
    return attach_coordinates(talks, geocoded)
