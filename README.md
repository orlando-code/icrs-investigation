# ICRS 2026 speaker affiliations

Interactive map and co-authorship network for ICRS 2026 speakers, geocoded by affiliation and centred on Auckland.

**Live site:** https://orlando-code.github.io/icrs-investigation/

## Local preview

```bash
python -m http.server 8765
# open http://localhost:8765/
```

## Regenerate site data

```bash
python scripts/export_attendee_site.py
```

Requires geocoding dependencies (`pandas`, `geopy`, `pycountry`, etc.) and cached geocodes in `data/`.
