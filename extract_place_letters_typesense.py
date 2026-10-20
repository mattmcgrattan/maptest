#!/usr/bin/env python3
"""
Extract Place-to-Place letter correspondence data from Typesense for the
standalone Place Letters Map prototype.

Run with:
    uv run --with httpx local_data/backend/extract_place_letters_typesense.py

Or inside the backend container:
    docker compose -f docker-compose.yml -f docker-compose.develop.yml exec backend \
        /backend/venv/bin/python /backend/local_data/extract_place_letters_typesense.py

How the Typesense Query Works:
1. For a specific Place (e.g. Rouen, `letters.place:448`), we query the
   `letters` collection filtering on `relationships.relationship_id`:
   - Outbound (Letters From Place):
     `relationships.relationship_id:=letters.letter|letters.place|written_from_place|letters.place:448`
   - Inbound (Letters To Place):
     `relationships.relationship_id:=letters.letter|letters.place|written_to_place|letters.place:448`
   - Combined query:
     `relationships.relationship_id:=[letters.letter|letters.place|written_from_place|letters.place:448, letters.letter|letters.place|written_to_place|letters.place:448]`
2. Using `facet_by=relationships.relationship_id` and
   `facet_return_parent=relationships.relationship_id` returns the aggregated
   place counts directly in `facet_counts`, while the `hits` array provides
   the individual letter documents (`identifier`, `w_id`, `date`, `subject`,
   `written_by`, `written_to`, `written_from_place`, `written_to_place`).
"""

import json
import os
from pathlib import Path
import httpx

TYPESENSE_URLS = [
    os.environ.get("TYPESENSE_URL", ""),
    "http://monet-letters.localhost/_typesense",
    "http://localhost:8108",
    "http://typesense:8108",
]
TYPESENSE_API_KEY = os.environ.get("TYPESENSE_API_KEY", "xyz")

# Canonical coordinates & Getty TGN metadata for the Place entities in the database.
# Note: In Wagtail Admin (`map-editor.js`), `Place.latlong` stores GeoJSON
# `{"type": "Point", "coordinates": [lng, lat]}` and `Place.boundary` stores
# an optional OSM GeoJSON polygon.
PLACE_COORDINATES: dict[str, dict] = {
    "letters.place:448": {
        "id": "letters.place:448",
        "pk": 448,
        "name": "Rouen",
        "region": "Normandy (Seine-Maritime)",
        "country_code": "FR",
        "tgn_id": "7008929",
        "lat": 49.443232,
        "lng": 1.099971,
        "db_sent_from_count": 28,  # 22 live non-stub in Typesense + 6 stub letters in DB
        "db_sent_to_count": 2,
        "boundary_geojson": {
            "type": "Feature",
            "properties": {"name": "Rouen"},
            "geometry": {
                "type": "Polygon",
                "coordinates": [
                    [
                        [1.035, 49.462],
                        [1.068, 49.476],
                        [1.132, 49.471],
                        [1.154, 49.442],
                        [1.138, 49.416],
                        [1.076, 49.412],
                        [1.038, 49.431],
                        [1.035, 49.462],
                    ]
                ],
            },
        },
    },
    "letters.place:434": {
        "id": "letters.place:434",
        "pk": 434,
        "name": "Giverny",
        "region": "Normandy (Eure)",
        "country_code": "FR",
        "tgn_id": "7009209",
        "lat": 49.075239,
        "lng": 1.533800,
        "db_sent_from_count": 238,
        "db_sent_to_count": 19,
    },
    "letters.place:435": {
        "id": "letters.place:435",
        "pk": 435,
        "name": "Paris",
        "region": "Île-de-France",
        "country_code": "FR",
        "tgn_id": "7008038",
        "lat": 48.856614,
        "lng": 2.352222,
        "db_sent_from_count": 2,
        "db_sent_to_count": 120,
    },
    "letters.place:439": {
        "id": "letters.place:439",
        "pk": 439,
        "name": "London",
        "region": "Greater London",
        "country_code": "GB",
        "tgn_id": "7011781",
        "lat": 51.510357,
        "lng": -0.120405,
        "db_sent_from_count": 17,
        "db_sent_to_count": 0,
    },
    "letters.place:467": {
        "id": "letters.place:467",
        "pk": 467,
        "name": "Sandviken, Bergen",
        "region": "Vestland",
        "country_code": "NO",
        "tgn_id": "7007059",
        "lat": 60.409300,
        "lng": 5.324500,
        "db_sent_from_count": 7,
        "db_sent_to_count": 0,
    },
    "letters.place:440": {
        "id": "letters.place:440",
        "pk": 440,
        "name": "Vétheuil",
        "region": "Île-de-France (Val-d'Oise)",
        "country_code": "FR",
        "tgn_id": "7008041",
        "lat": 49.065300,
        "lng": 1.700600,
        "db_sent_from_count": 7,
        "db_sent_to_count": 0,
    },
    "letters.place:441": {
        "id": "letters.place:441",
        "pk": 441,
        "name": "Olso",
        "region": "Oslo",
        "country_code": "NO",
        "tgn_id": "7009573",
        "lat": 59.913900,
        "lng": 10.752200,
        "db_sent_from_count": 5,
        "db_sent_to_count": 0,
    },
    "letters.place:456": {
        "id": "letters.place:456",
        "pk": 456,
        "name": "Fresselines",
        "region": "Nouvelle-Aquitaine (Creuse)",
        "country_code": "FR",
        "tgn_id": "7645959",
        "lat": 46.383100,
        "lng": 1.682800,
        "db_sent_from_count": 4,
        "db_sent_to_count": 0,
    },
    "letters.place:480": {
        "id": "letters.place:480",
        "pk": 480,
        "name": "Pourville",
        "region": "Normandy (Seine-Maritime)",
        "country_code": "FR",
        "tgn_id": "7009449",
        "lat": 49.916900,
        "lng": 1.031700,
        "db_sent_from_count": 4,
        "db_sent_to_count": 0,
    },
    "letters.place:459": {
        "id": "letters.place:459",
        "pk": 459,
        "name": "Argenteuil",
        "region": "Île-de-France (Val-d'Oise)",
        "country_code": "FR",
        "tgn_id": "7008019",
        "lat": 48.947200,
        "lng": 2.246700,
        "db_sent_from_count": 3,
        "db_sent_to_count": 1,
    },
    "letters.place:437": {
        "id": "letters.place:437",
        "pk": 437,
        "name": "Honfleur",
        "region": "Normandy (Calvados)",
        "country_code": "FR",
        "tgn_id": "7009235",
        "lat": 49.418900,
        "lng": 0.232500,
        "db_sent_from_count": 2,
        "db_sent_to_count": 0,
    },
    "letters.place:468": {
        "id": "letters.place:468",
        "pk": 468,
        "name": "Étretat",
        "region": "Normandy (Seine-Maritime)",
        "country_code": "FR",
        "tgn_id": "7009168",
        "lat": 49.707200,
        "lng": 0.205800,
        "db_sent_from_count": 2,
        "db_sent_to_count": 0,
    },
    "letters.place:455": {
        "id": "letters.place:455",
        "pk": 455,
        "name": "St. Michel, Bougival",
        "region": "Île-de-France (Yvelines)",
        "country_code": "FR",
        "tgn_id": "7029591",
        "lat": 48.865000,
        "lng": 2.138900,
        "db_sent_from_count": 2,
        "db_sent_to_count": 0,
    },
    "letters.place:498": {
        "id": "letters.place:498",
        "pk": 498,
        "name": "Poissy",
        "region": "Île-de-France (Yvelines)",
        "country_code": "FR",
        "tgn_id": "7008066",
        "lat": 48.928900,
        "lng": 2.045000,
        "db_sent_from_count": 1,
        "db_sent_to_count": 0,
    },
    "letters.place:436": {
        "id": "letters.place:436",
        "pk": 436,
        "name": "Chailly-en-Bière",
        "region": "Île-de-France (Seine-et-Marne)",
        "country_code": "FR",
        "tgn_id": "7007616",
        "lat": 48.468100,
        "lng": 2.607500,
        "db_sent_from_count": 1,
        "db_sent_to_count": 0,
    },
    "letters.place:438": {
        "id": "letters.place:438",
        "pk": 438,
        "name": "Sainte-Adresse",
        "region": "Normandy (Seine-Maritime)",
        "country_code": "FR",
        "tgn_id": "1035560",
        "lat": 49.505600,
        "lng": 0.080000,
        "db_sent_from_count": 1,
        "db_sent_to_count": 0,
    },
    "letters.place:465": {
        "id": "letters.place:465",
        "pk": 465,
        "name": "Zaandam",
        "region": "North Holland",
        "country_code": "NL",
        "tgn_id": "4012447",
        "lat": 52.438900,
        "lng": 4.826400,
        "db_sent_from_count": 1,
        "db_sent_to_count": 0,
    },
    "letters.place:469": {
        "id": "letters.place:469",
        "pk": 469,
        "name": "Fécamp",
        "region": "Normandy (Seine-Maritime)",
        "country_code": "FR",
        "tgn_id": "7009176",
        "lat": 49.757800,
        "lng": 0.379200,
        "db_sent_from_count": 1,
        "db_sent_to_count": 0,
    },
    "letters.place:472": {
        "id": "letters.place:472",
        "pk": 472,
        "name": "Normandy",
        "region": "Normandy",
        "country_code": "FR",
        "tgn_id": "8711852",
        "lat": 49.182900,
        "lng": -0.370700,
        "db_sent_from_count": 1,
        "db_sent_to_count": 0,
    },
    "letters.place:483": {
        "id": "letters.place:483",
        "pk": 483,
        "name": "Montgeron",
        "region": "Île-de-France (Essonne)",
        "country_code": "FR",
        "tgn_id": "7009359",
        "lat": 48.706900,
        "lng": 2.456100,
        "db_sent_from_count": 1,
        "db_sent_to_count": 0,
    },
    "letters.place:486": {
        "id": "letters.place:486",
        "pk": 486,
        "name": "Bergen",
        "region": "Vestland",
        "country_code": "NO",
        "tgn_id": "7007059",
        "lat": 60.391300,
        "lng": 5.322100,
        "db_sent_from_count": 1,
        "db_sent_to_count": 0,
    },
    "letters.place:487": {
        "id": "letters.place:487",
        "pk": 487,
        "name": "Charlottenburg",
        "region": "Berlin",
        "country_code": "DE",
        "tgn_id": "1004256",
        "lat": 52.516700,
        "lng": 13.300000,
        "db_sent_from_count": 0,
        "db_sent_to_count": 1,
    },
    "letters.place:491": {
        "id": "letters.place:491",
        "pk": 491,
        "name": "Yainville",
        "region": "Normandy (Seine-Maritime)",
        "country_code": "FR",
        "tgn_id": "7596747",
        "lat": 49.454700,
        "lng": 0.829700,
        "db_sent_from_count": 0,
        "db_sent_to_count": 1,
    },
    "letters.place:474": {
        "id": "letters.place:474",
        "pk": 474,
        "name": "Nice",
        "region": "Provence-Alpes-Côte d'Azur",
        "country_code": "FR",
        "tgn_id": "7008773",
        "lat": 43.710200,
        "lng": 7.262000,
        "db_sent_from_count": 0,
        "db_sent_to_count": 1,
    },
}

# The 6 stub letters (`is_stub=True`) from Rouen in PostgreSQL that are not indexed
# in Typesense (`LetterIndexer` filters `is_stub=False, live=True`), explaining why
# Wagtail Admin shows 28 Letters Sent From Rouen while Typesense returns 22.
ROUEN_DB_STUB_LETTERS = [
    {
        "id": "letters.letter:789",
        "identifier": "789",
        "w_id": "1139",
        "date_str": "1892-03-10",
        "year": 1892,
        "written_by": ["Claude Monet"],
        "written_to": ["Alice Hoschedé"],
        "from_place_id": "letters.place:448",
        "from_place_label": "Rouen",
        "to_place_id": None,
        "to_place_label": None,
        "subject": "Stub letter record in PostgreSQL (is_stub=True)",
        "is_stub": True,
    },
    {
        "id": "letters.letter:791",
        "identifier": "791",
        "w_id": "1142",
        "date_str": "1892-03-26",
        "year": 1892,
        "written_by": ["Claude Monet"],
        "written_to": ["Alice Hoschedé"],
        "from_place_id": "letters.place:448",
        "from_place_label": "Rouen",
        "to_place_id": None,
        "to_place_label": None,
        "subject": "Stub letter record in PostgreSQL (is_stub=True)",
        "is_stub": True,
    },
    {
        "id": "letters.letter:806",
        "identifier": "806",
        "w_id": "1185",
        "date_str": "1893-03-08",
        "year": 1893,
        "written_by": ["Claude Monet"],
        "written_to": ["Alice Hoschedé"],
        "from_place_id": "letters.place:448",
        "from_place_label": "Rouen",
        "to_place_id": None,
        "to_place_label": None,
        "subject": "Stub letter record in PostgreSQL (is_stub=True)",
        "is_stub": True,
    },
    {
        "id": "letters.letter:807",
        "identifier": "807",
        "w_id": "",
        "date_str": "1893-03-10",
        "year": 1893,
        "written_by": ["Claude Monet"],
        "written_to": ["Alice Hoschedé"],
        "from_place_id": "letters.place:448",
        "from_place_label": "Rouen",
        "to_place_id": None,
        "to_place_label": None,
        "subject": "Stub letter record in PostgreSQL (is_stub=True)",
        "is_stub": True,
    },
    {
        "id": "letters.letter:808",
        "identifier": "808",
        "w_id": "1189",
        "date_str": "1893-03-16",
        "year": 1893,
        "written_by": ["Claude Monet"],
        "written_to": ["Alice Hoschedé"],
        "from_place_id": "letters.place:448",
        "from_place_label": "Rouen",
        "to_place_id": None,
        "to_place_label": None,
        "subject": "Stub letter record in PostgreSQL (is_stub=True)",
        "is_stub": True,
    },
    {
        "id": "letters.letter:811",
        "identifier": "811",
        "w_id": "1193",
        "date_str": "1893-03-20",
        "year": 1893,
        "written_by": ["Claude Monet"],
        "written_to": ["Alice Hoschedé"],
        "from_place_id": "letters.place:448",
        "from_place_label": "Rouen",
        "to_place_id": None,
        "to_place_label": None,
        "subject": "Stub letter record in PostgreSQL (is_stub=True)",
        "is_stub": True,
    },
]


def format_yyyymmdd(ts: int | None) -> str:
    if not ts:
        return ""
    year, rem = divmod(int(ts), 10000)
    month, day = divmod(rem, 100)
    return f"{year:04d}-{month:02d}-{day:02d}"


def get_working_base_url() -> str:
    for candidate in TYPESENSE_URLS:
        if not candidate:
            continue
        try:
            resp = httpx.get(
                f"{candidate.rstrip('/')}/collections/letters",
                headers={"X-TYPESENSE-API-KEY": TYPESENSE_API_KEY},
                timeout=3.0,
            )
            if resp.status_code == 200:
                return candidate.rstrip("/")
        except Exception:
            continue
    raise RuntimeError(
        f"Could not connect to Typesense at any of: {[u for u in TYPESENSE_URLS if u]}"
    )


def fetch_letters_for_place(base_url: str, place_id: str) -> dict:
    """
    Query Typesense for all letters written FROM or TO `place_id`.
    Mirrors the connection pattern in `backend/test_facet_tree_rollup.py`.
    """
    url = f"{base_url}/collections/letters/documents/search"
    from_rel = f"letters.letter|letters.place|written_from_place|{place_id}"
    to_rel = f"letters.letter|letters.place|written_to_place|{place_id}"

    params = {
        "q": "*",
        "filter_by": f"relationships.relationship_id:=[{from_rel}, {to_rel}]",
        "facet_by": "relationships.relationship_id",
        "facet_return_parent": "relationships.relationship_id",
        "max_facet_values": "200",
        "per_page": "250",
        "include_fields": "id,identifier,w_id,date,display_date,title,subject,pull_quote,relationships",
    }
    resp = httpx.get(
        url,
        params=params,
        headers={"X-TYPESENSE-API-KEY": TYPESENSE_API_KEY},
        timeout=10.0,
    )
    resp.raise_for_status()
    return resp.json()


def fetch_all_place_letters(base_url: str) -> list[dict]:
    """Fetch all letters from Typesense that have any place relationship."""
    url = f"{base_url}/collections/letters/documents/search"
    all_letters = []
    page = 1
    while True:
        params = {
            "q": "*",
            "per_page": "250",
            "page": str(page),
            "include_fields": "id,identifier,w_id,date,display_date,title,subject,pull_quote,relationships",
        }
        resp = httpx.get(
            url,
            params=params,
            headers={"X-TYPESENSE-API-KEY": TYPESENSE_API_KEY},
            timeout=10.0,
        )
        resp.raise_for_status()
        data = resp.json()
        hits = data.get("hits", [])
        for hit in hits:
            doc = hit["document"]
            rels = doc.get("relationships") or []
            from_places = [
                r
                for r in rels
                if r.get("relationship_type")
                == "letters.letter|letters.place|written_from_place"
            ]
            to_places = [
                r
                for r in rels
                if r.get("relationship_type")
                == "letters.letter|letters.place|written_to_place"
            ]
            if not from_places and not to_places:
                continue

            writers = [
                r.get("label", {}).get("en")
                for r in rels
                if r.get("relationship_type")
                == "letters.letter|letters.person|written_by"
                and r.get("label", {}).get("en")
            ]
            recipients = [
                r.get("label", {}).get("en")
                for r in rels
                if r.get("relationship_type")
                == "letters.letter|letters.person|written_to"
                and r.get("label", {}).get("en")
            ]

            date_obj = doc.get("date") or {}
            start_ts = date_obj.get("start_timestamp")
            display_date = (doc.get("display_date") or {}).get(
                "en"
            ) or format_yyyymmdd(start_ts)
            subject_en = (doc.get("subject") or {}).get("en") or ""

            all_letters.append(
                {
                    "id": doc.get("id"),
                    "identifier": str(doc.get("identifier") or ""),
                    "w_id": str(doc.get("w_id") or ""),
                    "date_str": display_date,
                    "year": date_obj.get("histogram_year"),
                    "written_by": writers,
                    "written_to": recipients,
                    "from_place_id": from_places[0]["id"] if from_places else None,
                    "from_place_label": (
                        from_places[0].get("label", {}).get("en")
                        if from_places
                        else None
                    ),
                    "to_place_id": to_places[0]["id"] if to_places else None,
                    "to_place_label": (
                        to_places[0].get("label", {}).get("en") if to_places else None
                    ),
                    "subject": subject_en,
                    "is_stub": False,
                }
            )

        if len(hits) < 250:
            break
        page += 1

    return all_letters


def main():
    base_url = get_working_base_url()
    print(f"Connected to Typesense at: {base_url}")

    rouen_raw = fetch_letters_for_place(base_url, "letters.place:448")
    print(
        f"Rouen (letters.place:448) Typesense query returned {rouen_raw.get('found')} letters."
    )

    all_letters = fetch_all_place_letters(base_url)
    print(f"Extracted {len(all_letters)} letters with place relationships from Typesense.")

    output = {
        "default_place_id": "letters.place:448",
        "typesense_endpoint": "http://monet-letters.localhost/_typesense/collections/letters/documents/search",
        "places": PLACE_COORDINATES,
        "letters": all_letters,
        "rouen_db_stubs": ROUEN_DB_STUB_LETTERS,
        "rouen_sample_facet_counts": (
            rouen_raw.get("facet_counts", [{}])[0].get("counts", [])
            if rouen_raw.get("facet_counts")
            else []
        ),
    }

    out_dir = Path(__file__).resolve().parent
    json_path = out_dir / "place-letters-data.json"
    json_str = json.dumps(output, indent=2, ensure_ascii=False)
    json_path.write_text(json_str + "\n")
    print(f"Wrote {json_path}")

    js_data_path = out_dir / "place-letters-data.js"
    js_data_path.write_text(
        "// Auto-generated from Typesense by extract_place_letters_typesense.py\n"
        f"window.MONET_PLACE_MAP_DATA = {json_str};\n"
    )
    print(f"Wrote {js_data_path}")


if __name__ == "__main__":
    main()
