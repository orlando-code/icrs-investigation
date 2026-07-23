"""Geocode affiliation strings with query variants and a persistent cache."""

from __future__ import annotations

import json
import math
import os
import re
import time
import unicodedata
from pathlib import Path
from typing import Callable, Iterable

import pandas as pd
import pycountry
from geopy.exc import GeocoderServiceError, GeocoderTimedOut
from geopy.geocoders import Nominatim
from rich.console import Console
from rich.progress import (
    BarColumn,
    MofNCompleteColumn,
    Progress,
    SpinnerColumn,
    TextColumn,
    TimeElapsedColumn,
)

DEFAULT_CACHE_PATH = Path("data/geocode_cache.json")
DEFAULT_OVERRIDES_PATH = Path("data/geocode_overrides.json")
DEFAULT_COUNTRY_CACHE_PATH = Path("data/country_centroids.json")
DEFAULT_USER_AGENT = "icrs-investigation/0.1"
_CONSOLE = Console()

# Affiliation fragments mapped to clearer geocoding queries.
_AFFILIATION_ALIASES: dict[str, str] = {
    "cimas": "University of Miami, Florida",
    "rosenstiel school": "Rosenstiel School University of Miami",
    "umces": "University of Maryland Center for Environmental Sciences, Cambridge, Maryland",
    "institute of marine and environmental technology": "Baltimore, Maryland",
    "moss landing marine laboratories": "Moss Landing Marine Laboratories, California",
    "awi": "Alfred Wegener Institute, Bremerhaven, Germany",
    "cnrs/upvd": "University of Perpignan, France",
    "aoml": "Atlantic Oceanographic and Meteorological Laboratory, Miami, Florida",
    "cordio": "CORDIO East Africa, Mombasa, Kenya",
    "kaust": "KAUST, Saudi Arabia",
}

# Region or informal place names mapped to geocodable country queries.
_COUNTRY_ALIASES: dict[str, str] = {
    "micronesia": "Federated States of Micronesia",
    "micronesian": "Federated States of Micronesia",
    "polynesia": "French Polynesia",
    "polynesian": "French Polynesia",
    "melanesia": "Papua New Guinea",
    "pohnpei": "Pohnpei, Federated States of Micronesia",
    "guam": "Guam",
    "samoa": "Samoa",
    "tahiti": "French Polynesia",
    "moorea": "French Polynesia",
    "virgin islands": "United States Virgin Islands",
    "u.s. virgin islands": "United States Virgin Islands",
    "us virgin islands": "United States Virgin Islands",
    "east africa": "Kenya",
    "west africa": "Senegal",
    "south pacific": "Fiji",
    "caribbean": "Jamaica",
    "india": "India",
    "australia": "Australia",
    "new zealand": "New Zealand",
    "fiji": "Fiji",
    "kenya": "Kenya",
    "madagascar": "Madagascar",
    "indonesia": "Indonesia",
    "philippines": "Philippines",
    "japan": "Japan",
    "china": "China",
    "mexico": "Mexico",
    "brazil": "Brazil",
    "saudi arabia": "Saudi Arabia",
    "south africa": "South Africa",
    "thailand": "Thailand",
    "vietnam": "Vietnam",
    "malaysia": "Malaysia",
    "singapore": "Singapore",
    "hawaii": "Hawaii, USA",
}

_MAX_COUNTRY_DISTANCE_KM = 1_500

# Regex replacements applied before query generation.
_NORMALIZATIONS = (
    (r"\bOf\b", "of"),
    (r"\bAnd\b", "and"),
    (r"\bThe\b", "the"),
    (r"\s+", " "),
)


def _load_country_coords_cache(path: Path) -> dict[str, tuple[float, float]]:
    raw = _load_json(path)
    cache: dict[str, tuple[float, float]] = {}
    for country, coords in raw.items():
        lat = coords.get("latitude")
        lon = coords.get("longitude")
        if lat is not None and lon is not None:
            cache[country] = (lat, lon)
    return cache


def _save_country_coords_cache(
    path: Path, cache: dict[str, tuple[float, float]]
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        country: {"latitude": lat, "longitude": lon}
        for country, (lat, lon) in sorted(cache.items())
    }
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)


def _ensure_country_coords(
    geolocator: Nominatim,
    countries: Iterable[str],
    *,
    country_coords_cache: dict[str, tuple[float, float]],
    country_cache_path: Path,
    pause_seconds: float,
) -> None:
    updated = False
    for country in countries:
        if country in country_coords_cache:
            continue
        result = _geocode_country_centroid(
            geolocator,
            country,
            pause_seconds=pause_seconds,
        )
        if result["latitude"] is not None:
            country_coords_cache[country] = (result["latitude"], result["longitude"])
            updated = True
        time.sleep(pause_seconds)
    if updated:
        _save_country_coords_cache(country_cache_path, country_coords_cache)


def _load_json(path: Path) -> dict:
    if not path.exists():
        return {}
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def _save_cache(cache_path: Path, cache: dict[str, dict]) -> None:
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    with cache_path.open("w", encoding="utf-8") as handle:
        json.dump(cache, handle, indent=2, sort_keys=True)


def _normalize_text(text: str) -> str:
    text = unicodedata.normalize("NFKD", text)
    text = text.encode("ascii", "ignore").decode("ascii")
    text = text.replace("–", "-").replace("—", "-").strip()
    for pattern, replacement in _NORMALIZATIONS:
        text = re.sub(pattern, replacement, text)
    return text.strip(" ,;-")


def _split_primary_segment(affiliation: str) -> str:
    for sep in ("/", ";", "|"):
        if sep in affiliation:
            affiliation = affiliation.split(sep, 1)[0]
    return affiliation.strip()


def _lookup_country(name: str) -> str | None:
    cleaned = _normalize_text(name).strip(" ,.-")
    if not cleaned or len(cleaned) < 3:
        return None

    alias = _COUNTRY_ALIASES.get(cleaned.lower())
    if alias:
        return alias

    try:
        return pycountry.countries.lookup(cleaned).name
    except LookupError:
        return None


def _extract_country_hints(affiliation: str) -> list[str]:
    """Extract likely country/region names from an affiliation string."""
    hints: list[str] = []
    seen: set[str] = set()

    def add(candidate: str | None, *, resolved: bool = False) -> None:
        if not candidate:
            return
        country = candidate if resolved else _lookup_country(candidate)
        if country and country not in seen:
            seen.add(country)
            hints.append(country)

    normalized = _normalize_text(affiliation)
    lowered = normalized.lower()

    for alias, country in sorted(
        _COUNTRY_ALIASES.items(), key=lambda item: -len(item[0])
    ):
        if alias in lowered:
            add(country, resolved=True)

    for part in re.split(r"[,;/|&]", normalized):
        add(part.strip())

    for sep in (" - ", " – ", " — "):
        if sep in normalized:
            tail = normalized.split(sep, 1)[1]
            for part in re.split(r"[,;/|&]", tail):
                add(part.strip())

    return hints


def _shortest_lon_delta(lon1: float, lon2: float) -> float:
    delta = lon2 - lon1
    return (delta + 180.0) % 360.0 - 180.0


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius_km = 6_371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lambda = math.radians(_shortest_lon_delta(lon1, lon2))
    a = (
        math.sin(d_phi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    )
    return 2 * radius_km * math.asin(math.sqrt(a))


def _geocode_country_centroid(
    geolocator: Nominatim,
    country: str,
    *,
    pause_seconds: float,
) -> dict[str, float | str | None]:
    for query in (country, f"{country} country"):
        result = _geocode_query(geolocator, query, pause_seconds=pause_seconds)
        if result["latitude"] is not None:
            result["query_used"] = f"country:{country}"
            result["geocode_level"] = "country"
            return result
        time.sleep(pause_seconds)
    return {
        "latitude": None,
        "longitude": None,
        "query_used": None,
        "geocode_level": None,
    }


def _is_plausible_for_hints(
    lat: float,
    lon: float,
    country_hints: list[str],
    country_coords: dict[str, tuple[float, float]],
) -> bool:
    if not country_hints:
        return True
    distances = [
        _haversine_km(lat, lon, country_coords[hint][0], country_coords[hint][1])
        for hint in country_hints
        if hint in country_coords
    ]
    if not distances:
        return True
    return min(distances) <= _MAX_COUNTRY_DISTANCE_KM


def _resolve_country_coords(
    geolocator: Nominatim,
    country_hints: list[str],
    *,
    pause_seconds: float,
    country_coords_cache: dict[str, tuple[float, float]],
) -> dict[str, float | str | None]:
    for country in country_hints:
        if country not in country_coords_cache:
            result = _geocode_country_centroid(
                geolocator,
                country,
                pause_seconds=pause_seconds,
            )
            if result["latitude"] is not None:
                country_coords_cache[country] = (
                    result["latitude"],
                    result["longitude"],
                )
            else:
                continue
        lat, lon = country_coords_cache[country]
        return {
            "latitude": lat,
            "longitude": lon,
            "query_used": f"country:{country}",
            "geocode_level": "country",
        }
    return {
        "latitude": None,
        "longitude": None,
        "query_used": None,
        "geocode_level": None,
    }


def _query_variants(affiliation: str) -> list[str]:
    """Generate progressively simpler geocoding queries."""
    raw = affiliation.strip()
    if not raw:
        return []

    normalized = _normalize_text(raw)
    primary = _split_primary_segment(normalized)
    variants: list[str] = []
    seen: set[str] = set()

    def add(query: str | None) -> None:
        if not query:
            return
        query = _normalize_text(query)
        if query and query not in seen:
            seen.add(query)
            variants.append(query)

    add(raw)
    add(normalized)
    add(primary)

    lowered = primary.lower()
    for fragment, alias in _AFFILIATION_ALIASES.items():
        if fragment in lowered:
            add(alias)

    if "(" in primary and ")" in primary:
        add(re.sub(r"\([^)]*\)", "", primary).strip(" ,"))

    parts = [part.strip() for part in re.split(r",", primary) if part.strip()]
    if len(parts) >= 2:
        add(f"{parts[0]}, {parts[-1]}")
        add(f"{parts[0]} {parts[-1]}")
        add(parts[0])
        add(f"{parts[0]}, {parts[1]}")
        add(f"{parts[1]}, {parts[0]}")

    for sep in (" - ", " – ", " — "):
        if sep in primary:
            add(primary.split(sep, 1)[0])

    if " under " in lowered:
        add(primary.split(" under ", 1)[0])

    if "university" in lowered:
        match = re.search(
            r"(university of [^,;/|-]+(?:,\s*[^,;/|-]+)?)", primary, flags=re.I
        )
        if match:
            add(match.group(1))

    if "institute" in lowered:
        match = re.search(r"(institute[^,;/|]*?(?:,\s*[^,;/|]+)?)", primary, flags=re.I)
        if match:
            add(match.group(1))

    # Local-language variants for universities without country hints.
    if "antsiranana" in lowered:
        add("Universite d'Antsiranana, Madagascar")
    if "salento" in lowered:
        add("Universita del Salento, Lecce, Italy")
    if "toliara" in lowered:
        add("Universite de Toliara, Madagascar")
    if "mons" in lowered and "belgium" in lowered:
        add("Universite de Mons, Belgium")

    # Common trailing department/school noise.
    add(
        re.split(
            r",\s*(?:Department|School|Faculty|Center|Centre|Division)\b",
            primary,
            maxsplit=1,
        )[0]
    )

    return [
        query
        for query in variants
        if len(query) >= 12 or query.lower() in _AFFILIATION_ALIASES
    ]


def _geocode_query(
    geolocator: Nominatim,
    query: str,
    *,
    retries: int = 3,
    pause_seconds: float = 1.0,
) -> dict[str, float | str | None]:
    for attempt in range(retries):
        try:
            location = geolocator.geocode(query, timeout=10)
            if location is None:
                return {"latitude": None, "longitude": None, "query_used": query}
            return {
                "latitude": location.latitude,
                "longitude": location.longitude,
                "query_used": query,
            }
        except (GeocoderTimedOut, GeocoderServiceError):
            if attempt == retries - 1:
                return {"latitude": None, "longitude": None, "query_used": query}
            time.sleep(pause_seconds * (attempt + 1))
    return {"latitude": None, "longitude": None, "query_used": query}


def _llm_geocode_query(affiliation: str) -> str | None:
    """Optional LLM fallback to produce a concise geocoding query."""
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        return None

    try:
        from openai import OpenAI
    except ImportError:
        return None

    client = OpenAI(api_key=api_key)
    response = client.chat.completions.create(
        model=os.environ.get("ICRS_GEOCODE_MODEL", "gpt-4o-mini"),
        temperature=0,
        messages=[
            {
                "role": "system",
                "content": (
                    "Return a concise geocoding query for the main physical location of "
                    "an academic affiliation. Reply with only the query string."
                ),
            },
            {"role": "user", "content": affiliation},
        ],
    )
    query = response.choices[0].message.content
    return query.strip() if query else None


def _resolve_affiliation(
    geolocator: Nominatim,
    affiliation: str,
    overrides: dict[str, dict],
    *,
    pause_seconds: float,
    use_llm: bool,
    country_coords_cache: dict[str, tuple[float, float]],
    country_cache_path: Path,
    on_query: Callable[[str, int, int], None] | None = None,
) -> dict[str, float | str | None]:
    if affiliation in overrides:
        override = overrides[affiliation]
        return {
            "latitude": override.get("latitude"),
            "longitude": override.get("longitude"),
            "query_used": override.get("query_used", "override"),
            "geocode_level": override.get("geocode_level", "institute"),
        }

    country_hints = _extract_country_hints(affiliation)
    _ensure_country_coords(
        geolocator,
        country_hints,
        country_coords_cache=country_coords_cache,
        country_cache_path=country_cache_path,
        pause_seconds=pause_seconds,
    )

    variants = _query_variants(affiliation)
    for index, query in enumerate(variants, start=1):
        if on_query is not None:
            on_query(query, index, len(variants))
        result = _geocode_query(geolocator, query, pause_seconds=pause_seconds)
        if result["latitude"] is not None:
            if _is_plausible_for_hints(
                result["latitude"],
                result["longitude"],
                country_hints,
                country_coords_cache,
            ):
                result["geocode_level"] = "institute"
                return result
        time.sleep(pause_seconds)

    if use_llm:
        if on_query is not None:
            on_query("llm fallback", len(variants) + 1, len(variants) + 1)
        llm_query = _llm_geocode_query(affiliation)
        if llm_query:
            result = _geocode_query(geolocator, llm_query, pause_seconds=pause_seconds)
            if result["latitude"] is not None and _is_plausible_for_hints(
                result["latitude"],
                result["longitude"],
                country_hints,
                country_coords_cache,
            ):
                result["query_used"] = f"llm:{llm_query}"
                result["geocode_level"] = "institute"
                return result
            time.sleep(pause_seconds)

    if country_hints:
        if on_query is not None:
            on_query(f"country fallback ({country_hints[0]})", 1, 1)
        return _resolve_country_coords(
            geolocator,
            country_hints,
            pause_seconds=pause_seconds,
            country_coords_cache=country_coords_cache,
        )

    return {
        "latitude": None,
        "longitude": None,
        "query_used": None,
        "geocode_level": None,
    }


def _needs_reprocessing(
    affiliation: str,
    cached: dict | None,
    *,
    retry_failed: bool,
    country_coords_cache: dict[str, tuple[float, float]],
) -> bool:
    if not cached:
        return True
    lat = cached.get("latitude")
    lon = cached.get("longitude")
    if lat is None or lon is None:
        return retry_failed
    if cached.get("geocode_level") == "country":
        return False
    country_hints = _extract_country_hints(affiliation)
    if not country_hints:
        return False
    return not _is_plausible_for_hints(lat, lon, country_hints, country_coords_cache)


def _affiliations_needing_work(
    unique_affiliations: list[str],
    cache: dict[str, dict],
    overrides: dict[str, dict],
    *,
    retry_failed: bool,
    country_coords_cache: dict[str, tuple[float, float]],
) -> tuple[list[str], int, int]:
    """Return affiliations requiring API calls plus cached/override counts."""
    pending: list[str] = []
    cached_count = 0
    override_count = 0

    for affiliation in unique_affiliations:
        if not affiliation:
            continue
        if affiliation in overrides:
            override_count += 1
            pending.append(affiliation)
            continue

        cached = cache.get(affiliation)
        if cached and cached.get("latitude") is not None:
            if _needs_reprocessing(
                affiliation,
                cached,
                retry_failed=retry_failed,
                country_coords_cache=country_coords_cache,
            ):
                pending.append(affiliation)
                continue
            cached_count += 1
            continue
        if cached and cached.get("latitude") is None and not retry_failed:
            cached_count += 1
            continue

        pending.append(affiliation)

    return pending, cached_count, override_count


def geocode_affiliations(
    affiliations: Iterable[str],
    cache_path: str | Path = DEFAULT_CACHE_PATH,
    overrides_path: str | Path = DEFAULT_OVERRIDES_PATH,
    country_cache_path: str | Path = DEFAULT_COUNTRY_CACHE_PATH,
    *,
    user_agent: str = DEFAULT_USER_AGENT,
    pause_seconds: float = 0.1,
    retry_failed: bool = False,
    use_llm: bool = False,
    show_progress: bool = True,
) -> pd.DataFrame:
    """Return coordinates for each unique affiliation string.

    Uses cached results when available. Set ``retry_failed=True`` to re-attempt
    affiliations previously stored without coordinates using improved queries.
    """
    cache_path = Path(cache_path)
    overrides_path = Path(overrides_path)
    country_cache_path = Path(country_cache_path)
    cache = _load_json(cache_path)
    overrides = _load_json(overrides_path)
    geolocator = Nominatim(user_agent=user_agent)
    country_coords_cache = _load_country_coords_cache(country_cache_path)

    unique_affiliations = sorted({(aff or "").strip() for aff in affiliations})
    all_country_hints = sorted(
        {
            hint
            for affiliation in unique_affiliations
            for hint in _extract_country_hints(affiliation)
        }
    )
    if all_country_hints:
        _ensure_country_coords(
            geolocator,
            all_country_hints,
            country_coords_cache=country_coords_cache,
            country_cache_path=country_cache_path,
            pause_seconds=pause_seconds,
        )

    pending, cached_count, override_count = _affiliations_needing_work(
        unique_affiliations,
        cache,
        overrides,
        retry_failed=retry_failed,
        country_coords_cache=country_coords_cache,
    )

    if show_progress:
        _CONSOLE.print(
            f"[bold]Geocoding affiliations[/] "
            f"({len(unique_affiliations)} unique, {cached_count} cached, "
            f"{override_count} overrides, {len(pending)} to query)"
        )

    geocoded_count = 0
    failed_count = 0

    def _process_affiliation(
        affiliation: str, progress: Progress | None = None, task_id: int | None = None
    ) -> None:
        nonlocal geocoded_count, failed_count

        if affiliation in overrides:
            cache[affiliation] = {
                "latitude": overrides[affiliation].get("latitude"),
                "longitude": overrides[affiliation].get("longitude"),
                "query_used": overrides[affiliation].get("query_used", "override"),
                "geocode_level": overrides[affiliation].get(
                    "geocode_level", "institute"
                ),
            }
            _save_cache(cache_path, cache)
            return

        def on_query(query: str, attempt: int, total: int) -> None:
            if progress is None or task_id is None:
                return
            label = affiliation if len(affiliation) <= 42 else f"{affiliation[:39]}..."
            progress.update(
                task_id,
                description=f"[cyan]{label}[/] ({attempt}/{total}) {query[:48]}",
            )

        cache[affiliation] = _resolve_affiliation(
            geolocator,
            affiliation,
            overrides,
            pause_seconds=pause_seconds,
            use_llm=use_llm,
            country_coords_cache=country_coords_cache,
            country_cache_path=country_cache_path,
            on_query=on_query,
        )
        _save_cache(cache_path, cache)
        if cache[affiliation].get("latitude") is not None:
            geocoded_count += 1
        else:
            failed_count += 1
        time.sleep(pause_seconds)

    if show_progress and pending:
        progress = Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            MofNCompleteColumn(),
            TimeElapsedColumn(),
            console=_CONSOLE,
            transient=False,
        )
        with progress:
            task_id = progress.add_task("Querying Nominatim", total=len(pending))
            for affiliation in pending:
                _process_affiliation(affiliation, progress, task_id)
                progress.advance(task_id)
    else:
        for affiliation in pending:
            _process_affiliation(affiliation)

    if show_progress and pending:
        _CONSOLE.print(
            f"[green]Done.[/] Geocoded {geocoded_count:,} | Failed {failed_count:,} | "
            f"Skipped {cached_count:,} cached"
        )

    rows = []
    for affiliation in unique_affiliations:
        if not affiliation:
            rows.append(
                {
                    "affiliation": affiliation,
                    "latitude": pd.NA,
                    "longitude": pd.NA,
                    "geocoded": False,
                    "geocode_level": pd.NA,
                    "query_used": pd.NA,
                }
            )
            continue

        coords = cache.get(affiliation, {"latitude": None, "longitude": None})
        lat = coords.get("latitude")
        lon = coords.get("longitude")
        geocoded = lat is not None and lon is not None

        rows.append(
            {
                "affiliation": affiliation,
                "latitude": pd.NA if not geocoded else lat,
                "longitude": pd.NA if not geocoded else lon,
                "geocoded": geocoded,
                "geocode_level": coords.get("geocode_level"),
                "query_used": coords.get("query_used"),
            }
        )

    return pd.DataFrame(rows)


def attach_coordinates(
    talks: pd.DataFrame,
    geocoded: pd.DataFrame,
    *,
    affiliation_col: str = "affiliation",
) -> pd.DataFrame:
    """Join cached coordinates onto a talks dataframe."""
    enriched = talks.merge(geocoded, on=affiliation_col, how="left")
    missing_affiliation = enriched[affiliation_col].isna()
    enriched.loc[
        missing_affiliation,
        ["latitude", "longitude", "geocoded", "geocode_level", "query_used"],
    ] = pd.NA
    enriched.loc[missing_affiliation, "geocoded"] = False
    return enriched
