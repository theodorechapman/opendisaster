/** Server-side: fetch all urban features from Overpass API and convert to GeoJSON layers. */

import type { FeatureCollection, BuildingFeature } from "./tiles.ts";

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

export interface OverpassLayers {
  buildings: FeatureCollection;
  roads: FeatureCollection;
  parks: FeatureCollection;
  water: FeatureCollection;
  trees: FeatureCollection;
  railways: FeatureCollection;
  barriers: FeatureCollection;
}

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
  members?: {
    type: string;
    role: string;
    geometry?: { lat: number; lon: number }[];
  }[];
}

interface OverpassResponse {
  elements: OverpassElement[];
}

/**
 * Fetch all urban features in a bounding box from Overpass and return as categorized GeoJSON layers.
 */
export async function fetchFromOverpass(
  south: number,
  west: number,
  north: number,
  east: number,
): Promise<OverpassLayers> {
  const bbox = `${south},${west},${north},${east}`;
  const query = `[out:json][timeout:60][bbox:${bbox}];
(
  // Buildings
  way["building"];
  relation["building"]["type"="multipolygon"];

  // Roads
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|service|unclassified|living_street|pedestrian|footway|cycleway|path|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"];

  // Parks and green areas
  way["leisure"~"^(park|garden|playground|pitch)$"];
  relation["leisure"="park"];
  way["landuse"~"^(grass|meadow|forest|village_green|recreation_ground)$"];
  relation["landuse"~"^(grass|meadow|forest)$"];
  way["natural"="wood"];
  relation["natural"="wood"];

  // Water
  way["natural"="water"];
  relation["natural"="water"];
  way["waterway"~"^(river|stream|canal|drain)$"];

  // Trees
  node["natural"="tree"];
  way["natural"="tree_row"];

  // Railways
  way["railway"~"^(rail|tram|light_rail|narrow_gauge)$"];

  // Barriers
  way["barrier"~"^(fence|wall|hedge|guard_rail|retaining_wall)$"];
);
out body geom;`;

  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const res = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(query)}`,
    });

    if (res.ok) {
      const data = (await res.json()) as OverpassResponse;
      return categorize(data);
    }

    const body = await res.text();
    if (attempt < maxRetries && (res.status === 429 || res.status === 504)) {
      console.log(`  Overpass ${res.status}, retrying in ${attempt * 2}s... (attempt ${attempt}/${maxRetries})`);
      await new Promise((r) => setTimeout(r, attempt * 2000));
      continue;
    }
    throw new Error(`Overpass returned ${res.status}: ${body}`);
  }
  throw new Error("Overpass: max retries exceeded");
}

function categorize(data: OverpassResponse): OverpassLayers {
  const layers: OverpassLayers = {
    buildings: { type: "FeatureCollection", features: [] },
    roads: { type: "FeatureCollection", features: [] },
    parks: { type: "FeatureCollection", features: [] },
    water: { type: "FeatureCollection", features: [] },
    trees: { type: "FeatureCollection", features: [] },
    railways: { type: "FeatureCollection", features: [] },
    barriers: { type: "FeatureCollection", features: [] },
  };

  for (const el of data.elements) {
    const tags = el.tags ?? {};
    const layer = classifyLayer(tags);
    if (!layer) continue;

    const feature = elementToFeature(el, layer);
    if (feature) layers[layer].features.push(feature);
  }

  return layers;
}

type LayerName = keyof OverpassLayers;

function classifyLayer(tags: Record<string, string>): LayerName | null {
  if (tags.building) return "buildings";
  if (tags.highway) return "roads";
  if (tags.railway) return "railways";
  if (tags.natural === "water" || tags.waterway) return "water";
  if (tags.natural === "tree" || tags.natural === "tree_row") return "trees";
  if (tags.leisure && /^(park|garden|playground|pitch)$/.test(tags.leisure)) return "parks";
  if (tags.landuse && /^(grass|meadow|forest|village_green|recreation_ground)$/.test(tags.landuse)) return "parks";
  if (tags.natural === "wood") return "parks";
  if (tags.barrier) return "barriers";
  return null;
}

function elementToFeature(el: OverpassElement, layer: LayerName): BuildingFeature | null {
  const tags = el.tags ?? {};
  const properties: Record<string, unknown> = { id: el.id };

  // Copy all tags into properties
  for (const [k, v] of Object.entries(tags)) {
    properties[k] = v;
  }

  // Parse numeric heights
  if (tags.height) properties._height = parseFloat(tags.height);
  if (tags["building:levels"]) properties._height = parseFloat(tags["building:levels"]) * 3.5;
  if (tags.height) properties._height = parseFloat(tags.height); // height overrides levels
  if (tags.min_height) properties._minHeight = parseFloat(tags.min_height);
  if (tags.width) properties._width = parseFloat(tags.width);
  if (tags.lanes) properties._lanes = parseInt(tags.lanes, 10);

  // Node → Point (trees)
  if (el.type === "node" && el.lat != null && el.lon != null) {
    return {
      type: "Feature",
      properties,
      geometry: { type: "Point", coordinates: [el.lon, el.lat] },
    } as unknown as BuildingFeature;
  }

  // Way → linestring or polygon
  if (el.type === "way" && el.geometry) {
    const coords = el.geometry.map((p) => [p.lon, p.lat]);

    // Determine if this is a closed polygon or a linestring
    const isClosed =
      coords.length > 3 &&
      coords[0]![0] === coords[coords.length - 1]![0] &&
      coords[0]![1] === coords[coords.length - 1]![1];

    const isAreaType = layer === "buildings" || layer === "parks" || layer === "water";

    if (isClosed && isAreaType) {
      return {
        type: "Feature",
        properties,
        geometry: { type: "Polygon", coordinates: [coords] },
      };
    }

    // Roads, railways, barriers, waterways, tree rows → LineString
    return {
      type: "Feature",
      properties,
      geometry: { type: "LineString", coordinates: coords },
    } as unknown as BuildingFeature;
  }

  // Relation → multipolygon
  if (el.type === "relation" && el.members) {
    const outerRings: number[][][] = [];
    for (const member of el.members) {
      if (member.role === "outer" && member.geometry) {
        const coords = member.geometry.map((p) => [p.lon, p.lat]);
        if (
          coords.length > 2 &&
          (coords[0]![0] !== coords[coords.length - 1]![0] ||
            coords[0]![1] !== coords[coords.length - 1]![1])
        ) {
          coords.push([...coords[0]!]);
        }
        if (coords.length >= 4) outerRings.push(coords);
      }
    }
    if (outerRings.length === 0) return null;

    if (outerRings.length === 1) {
      return {
        type: "Feature",
        properties,
        geometry: { type: "Polygon", coordinates: [outerRings[0]!] },
      };
    }
    return {
      type: "Feature",
      properties,
      geometry: {
        type: "MultiPolygon",
        coordinates: outerRings.map((ring) => [ring]),
      },
    };
  }

  return null;
}
