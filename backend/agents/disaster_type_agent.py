import re

from agents.base_agent import BaseAgent

DISASTER_TYPES = [
    "avalanche",
    "earthquake",
    "flood",
    "wildfire",
    "hurricane",
    "tornado",
    "tsunami",
    "landslide",
    "volcanic eruption",
]

# Build a single regex: matches any known disaster type (case-insensitive)
_PATTERN = re.compile(
    "|".join(re.escape(d) for d in DISASTER_TYPES),
    re.IGNORECASE,
)


class DisasterTypeAgent(BaseAgent):
    @property
    def name(self) -> str:
        return "disaster_type"

    async def run(self, context: dict) -> dict:
        prompt: str = context.get("prompt", "")
        match = _PATTERN.search(prompt)
        return {"disaster_type": match.group(0).lower() if match else "unknown"}
