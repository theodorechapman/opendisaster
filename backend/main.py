from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from agents.disaster_type_agent import DisasterTypeAgent
from agents.geocoding_agent import GeocodingAgent
from models.schemas import SimulateRequest, SimulateResponse, Location
from orchestrator import Orchestrator

app = FastAPI(title="open_disaster")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

orchestrator = Orchestrator([DisasterTypeAgent(), GeocodingAgent()])


@app.post("/api/simulate", response_model=SimulateResponse)
async def simulate(req: SimulateRequest) -> SimulateResponse:
    result = await orchestrator.run(req.prompt)

    location = None
    if result.get("location"):
        location = Location(**result["location"])

    return SimulateResponse(
        location=location,
        disaster_type=result.get("disaster_type", "unknown"),
    )
