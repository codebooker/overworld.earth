import { NextRequest } from "next/server";

type NominatimAddress = Partial<
  Record<
    | "city"
    | "town"
    | "village"
    | "municipality"
    | "hamlet"
    | "borough"
    | "suburb"
    | "city_district"
    | "district"
    | "quarter"
    | "neighbourhood"
    | "subdivision"
    | "residential"
    | "locality"
    | "place"
    | "farm"
    | "county"
    | "state"
    | "country",
    string
  >
>;

type NominatimReverseResult = {
  address?: NominatimAddress;
  display_name?: string;
  name?: string;
};

function coordinate(value: string | null, limit: number) {
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= limit ? number : null;
}

function exploredPlace(result: NominatimReverseResult) {
  const address = result.address ?? {};
  return (
    address.neighbourhood ??
    address.quarter ??
    address.suburb ??
    address.subdivision ??
    address.residential ??
    address.locality ??
    address.borough ??
    address.city_district ??
    address.district ??
    address.town ??
    address.village ??
    address.hamlet ??
    address.city ??
    address.municipality ??
    address.place ??
    address.farm ??
    address.county ??
    address.state ??
    address.country ??
    result.name ??
    result.display_name?.split(",")[0]
  )?.trim();
}

export async function GET(request: NextRequest) {
  const lat = coordinate(request.nextUrl.searchParams.get("lat"), 90);
  const lon = coordinate(request.nextUrl.searchParams.get("lon"), 180);
  if (lat == null || lon == null) {
    return Response.json({ message: "Valid latitude and longitude are required." }, { status: 400 });
  }

  const endpoint = new URL("https://nominatim.openstreetmap.org/reverse");
  endpoint.searchParams.set("lat", String(lat));
  endpoint.searchParams.set("lon", String(lon));
  endpoint.searchParams.set("format", "jsonv2");
  endpoint.searchParams.set("addressdetails", "1");
  endpoint.searchParams.set("zoom", "15");
  endpoint.searchParams.set("layer", "address");

  try {
    const response = await fetch(endpoint, {
      headers: {
        Accept: "application/json",
        Referer: "https://overworld-earth-map.jacktawes.chatgpt.site/",
        "User-Agent":
          "OverworldMinecraftMap/1.0 (https://overworld-earth-map.jacktawes.chatgpt.site)",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      return Response.json({ message: "Place lookup is unavailable." }, { status: 502 });
    }

    const result = (await response.json()) as NominatimReverseResult;
    const title = exploredPlace(result);
    if (!title) return Response.json({ message: "No named place was found." }, { status: 404 });

    return Response.json(
      { title },
      {
        headers: {
          "Cache-Control": "public, max-age=3600, s-maxage=604800, stale-while-revalidate=86400",
        },
      },
    );
  } catch {
    return Response.json({ message: "Place lookup is unavailable." }, { status: 502 });
  }
}
