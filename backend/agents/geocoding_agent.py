import re

import httpx

from agents.base_agent import BaseAgent
from config import settings

# Heuristic patterns to extract a location phrase from a prompt
_LOCATION_PATTERNS = [
    re.compile(r"(?:hitting|at|in|near|around|over)\s+(.+?)(?:\s+(?:after|during|with|from)|[.!?]|$)", re.IGNORECASE),
]


def _extract_location_query(prompt: str) -> str | None:
    for pattern in _LOCATION_PATTERNS:
        m = pattern.search(prompt)
        if m:
            return m.group(1).strip().rstrip(",")
    return None


class GeocodingAgent(BaseAgent):
    @property
    def name(self) -> str:
        return "geocoding"

    async def run(self, context: dict) -> dict:
        prompt: str = context.get("prompt", "")
        query = _extract_location_query(prompt)
        if not query:
            return {"location": None}

        async with httpx.AsyncClient() as client:
            resp = await client.get(
                "https://api.mapbox.com/search/geocode/v6/forward",
                params={
                    "q": query,
                    "access_token": settings.mapbox_access_token,
                    "limit": 1,
                },
            )
            resp.raise_for_status()
            data = resp.json()

        features = data.get("features", [])
        if not features:
            return {"location": None}

        feature = features[0]
        coords = feature["geometry"]["coordinates"]  # [lng, lat]
        name = feature["properties"].get("full_address") or feature["properties"].get("name", query)

        return {
            "location": {
                "name": name,
                "lat": coords[1],
                "lng": coords[0],
            }
        }
