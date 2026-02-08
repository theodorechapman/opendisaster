from pydantic import BaseModel


class SimulateRequest(BaseModel):
    prompt: str


class Location(BaseModel):
    name: str
    lat: float
    lng: float


class SimulateResponse(BaseModel):
    location: Location | None = None
    disaster_type: str = "unknown"
