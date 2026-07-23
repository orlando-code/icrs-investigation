"""Load ICRS programme and talk data into a regular tabular format."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pandas as pd

TALK_COLUMNS = [
    "talk_id",
    "sid",
    "title",
    "presenter",
    "primary_author",
    "authors",
    "affiliation",
    "honorific",
    "position",
    "has_abstract",
    "abstract",
    "theme_cat",
    "start",
    "end",
    "date",
    "session_id",
    "session_title",
    "session_kind",
    "session_code",
    "session_theme",
    "room",
    "location",
]


def _load_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def load_talks(
    programme_path: str | Path = "data/programme.json",
    abstracts_path: str | Path | None = "data/abstracts.json",
) -> pd.DataFrame:
    """Flatten session talks into one row per talk.

    The presenting author is treated as the primary author. Their affiliation
    is taken from the talk's ``affiliation`` field.
    """
    programme_path = Path(programme_path)
    programme = _load_json(programme_path)

    abstracts: dict[str, str] = {}
    if abstracts_path is not None:
        abstracts_path = Path(abstracts_path)
        if abstracts_path.exists():
            abstracts = _load_json(abstracts_path)

    rows: list[dict[str, Any]] = []
    for session in programme["sessions"]:
        for talk in session["talks"]:
            authors = talk.get("authors") or []
            presenter = talk.get("presenter") or (authors[0] if authors else None)
            sid = talk.get("sid")

            rows.append(
                {
                    "talk_id": talk.get("id"),
                    "sid": sid,
                    "title": talk.get("title"),
                    "presenter": presenter,
                    "primary_author": presenter,
                    "authors": authors,
                    "affiliation": (talk.get("affiliation") or "").strip() or pd.NA,
                    "honorific": talk.get("honorific") or pd.NA,
                    "position": talk.get("position") or pd.NA,
                    "has_abstract": bool(talk.get("hasAbstract")),
                    "abstract": abstracts.get(sid) if sid else pd.NA,
                    "theme_cat": talk.get("themeCat"),
                    "start": talk.get("start"),
                    "end": talk.get("end"),
                    "date": session.get("date"),
                    "session_id": session.get("id"),
                    "session_title": session.get("title"),
                    "session_kind": session.get("kind"),
                    "session_code": session.get("code"),
                    "session_theme": session.get("theme"),
                    "room": session.get("room"),
                    "location": session.get("location"),
                }
            )

    return pd.DataFrame(rows, columns=TALK_COLUMNS)
