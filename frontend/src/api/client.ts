import type { SimulateResponse } from "../types/api";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

export async function simulate(prompt: string): Promise<SimulateResponse> {
  const res = await fetch(`${API_URL}/api/simulate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });

  if (!res.ok) {
    throw new Error(`Backend error: ${res.status} ${res.statusText}`);
  }

  return res.json();
}
