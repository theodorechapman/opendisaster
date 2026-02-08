export interface Location {
  name: string;
  lat: number;
  lng: number;
}

export interface SimulateResponse {
  location: Location | null;
  disaster_type: string;
}
