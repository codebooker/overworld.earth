import { NextRequest } from "next/server";

function parseCoordinate(value: string | null) {
  if (!value) return null;
  const parts = value.split(",").map(Number);
  if (
    parts.length !== 2 ||
    !Number.isFinite(parts[0]) ||
    !Number.isFinite(parts[1]) ||
    Math.abs(parts[0]) > 180 ||
    Math.abs(parts[1]) > 90
  ) {
    return null;
  }
  return parts as [number, number];
}

export async function GET(request: NextRequest) {
  const from = parseCoordinate(request.nextUrl.searchParams.get("from"));
  const to = parseCoordinate(request.nextUrl.searchParams.get("to"));
  if (!from || !to) {
    return Response.json({ code: "InvalidQuery", message: "Valid from and to coordinates are required." }, { status: 400 });
  }

  const coordinates = `${from[0]},${from[1]};${to[0]},${to[1]}`;
  const endpoint = new URL(`https://router.project-osrm.org/route/v1/driving/${coordinates}`);
  endpoint.searchParams.set("steps", "true");
  endpoint.searchParams.set("geometries", "geojson");
  endpoint.searchParams.set("overview", "full");
  endpoint.searchParams.set("alternatives", "false");

  try {
    const response = await fetch(endpoint, {
      headers: { Accept: "application/json", "User-Agent": "Overworld Minecraft Map" },
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) {
      return Response.json({ code: "RoutingUnavailable", message: "The routing service is unavailable." }, { status: 502 });
    }
    const result = await response.json();
    return Response.json(result, { headers: { "Cache-Control": "private, max-age=30" } });
  } catch {
    return Response.json({ code: "RoutingUnavailable", message: "The routing service is unavailable." }, { status: 502 });
  }
}
