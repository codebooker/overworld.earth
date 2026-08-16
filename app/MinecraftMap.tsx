"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { Map as MapLibreMap } from "maplibre-gl";

type SearchResult = {
  place_id: number;
  display_name: string;
  lat: string;
  lon: string;
  boundingbox: [string, string, string, string];
  type: string;
};

const destinations = [
  { label: "New York", center: [-74.006, 40.7128] as [number, number], zoom: 10 },
  { label: "The Alps", center: [10.1, 46.5] as [number, number], zoom: 7 },
  { label: "Amazon", center: [-62.2, -3.1] as [number, number], zoom: 6 },
  { label: "Tokyo", center: [139.6917, 35.6895] as [number, number], zoom: 10 },
];

const minecraftStyle: maplibregl.StyleSpecification = {
  version: 8,
  glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
  sources: {
    world: {
      type: "vector",
      url: "https://tiles.openfreemap.org/planet",
      attribution:
        '<a href="https://openfreemap.org">OpenFreeMap</a> · <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    },
  },
  layers: [
    { id: "earth", type: "background", paint: { "background-color": "#6b8d45" } },
    {
      id: "farmland",
      type: "fill",
      source: "world",
      "source-layer": "landuse",
      filter: ["in", ["get", "class"], ["literal", ["farmland", "farm", "orchard", "vineyard"]]],
      paint: { "fill-color": "#9aa653", "fill-opacity": 0.9, "fill-antialias": false },
    },
    {
      id: "built-land",
      type: "fill",
      source: "world",
      "source-layer": "landuse",
      filter: ["in", ["get", "class"], ["literal", ["residential", "commercial", "industrial"]]],
      paint: { "fill-color": "#aa9d79", "fill-opacity": 0.78, "fill-antialias": false },
    },
    {
      id: "grass",
      type: "fill",
      source: "world",
      "source-layer": "landcover",
      filter: ["==", ["get", "class"], "grass"],
      paint: { "fill-color": "#7e9c4b", "fill-antialias": false },
    },
    {
      id: "wood",
      type: "fill",
      source: "world",
      "source-layer": "landcover",
      filter: ["==", ["get", "class"], "wood"],
      paint: { "fill-color": "#486b37", "fill-opacity": 0.95, "fill-antialias": false },
    },
    {
      id: "sand",
      type: "fill",
      source: "world",
      "source-layer": "landcover",
      filter: ["==", ["get", "class"], "sand"],
      paint: { "fill-color": "#d7cb83", "fill-antialias": false },
    },
    {
      id: "ice",
      type: "fill",
      source: "world",
      "source-layer": "landcover",
      filter: ["==", ["get", "class"], "ice"],
      paint: { "fill-color": "#d9e7d5", "fill-antialias": false },
    },
    {
      id: "parks",
      type: "fill",
      source: "world",
      "source-layer": "park",
      paint: { "fill-color": "#668b42", "fill-opacity": 0.85, "fill-antialias": false },
    },
    {
      id: "water",
      type: "fill",
      source: "world",
      "source-layer": "water",
      filter: ["!=", ["get", "brunnel"], "tunnel"],
      paint: { "fill-color": "#3f76a8", "fill-antialias": false },
    },
    {
      id: "rivers",
      type: "line",
      source: "world",
      "source-layer": "waterway",
      paint: {
        "line-color": "#3f76a8",
        "line-width": ["interpolate", ["linear"], ["zoom"], 7, 0.5, 14, 2.5, 18, 8],
      },
    },
    {
      id: "roads",
      type: "line",
      source: "world",
      "source-layer": "transportation",
      filter: ["in", ["get", "class"], ["literal", ["motorway", "trunk", "primary", "secondary", "tertiary", "minor"]]],
      layout: { "line-cap": "butt", "line-join": "bevel" },
      paint: {
        "line-color": "#c9b47a",
        "line-width": ["interpolate", ["linear"], ["zoom"], 5, 0.4, 12, 1.4, 18, 7],
        "line-opacity": ["interpolate", ["linear"], ["zoom"], 5, 0.55, 9, 0.9],
      },
    },
    {
      id: "buildings",
      type: "fill",
      source: "world",
      "source-layer": "building",
      minzoom: 13,
      paint: { "fill-color": "#89735b", "fill-outline-color": "#5e5143", "fill-antialias": false },
    },
    {
      id: "place-labels",
      type: "symbol",
      source: "world",
      "source-layer": "place",
      filter: ["in", ["get", "class"], ["literal", ["country", "state", "city", "town", "village"]]],
      layout: {
        "text-field": ["coalesce", ["get", "name_en"], ["get", "name"]],
        "text-font": ["Noto Sans Bold"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 3, 10, 10, 14, 16, 16],
        "text-transform": "uppercase",
        "text-letter-spacing": 0.08,
      },
      paint: {
        "text-color": "#29251e",
        "text-halo-color": "#d8cda9",
        "text-halo-width": 1.4,
      },
    },
  ],
};

export default function MinecraftMap() {
  const mapNode = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [zoom, setZoom] = useState(10);
  const [coordinates, setCoordinates] = useState({ lng: -74.006, lat: 40.7128 });
  const [place, setPlace] = useState({ title: "New York", detail: "Real terrain · block by block" });
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [message, setMessage] = useState("");
  const [legendOpen, setLegendOpen] = useState(true);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!mapNode.current || mapRef.current) return;

    const hashParts = window.location.hash.slice(1).split("/").map(Number);
    const hasSharedView = hashParts.length === 3 && hashParts.every(Number.isFinite);
    const map = new maplibregl.Map({
      container: mapNode.current,
      style: minecraftStyle,
      center: hasSharedView ? [hashParts[2], hashParts[1]] : [-74.006, 40.7128],
      zoom: hasSharedView ? hashParts[0] : 10,
      minZoom: 2,
      maxZoom: 18,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
    });

    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    map.on("load", () => setReady(true));
    map.on("move", () => {
      const center = map.getCenter();
      setCoordinates({ lng: center.lng, lat: center.lat });
      setZoom(Math.round(map.getZoom()));
    });
    map.on("moveend", () => {
      const center = map.getCenter();
      window.history.replaceState(
        null,
        "",
        `#${map.getZoom().toFixed(1)}/${center.lat.toFixed(4)}/${center.lng.toFixed(4)}`,
      );
    });
    map.on("click", (event) => {
      markerRef.current?.remove();
      const markerNode = document.createElement("div");
      markerNode.className = "pixel-marker";
      markerRef.current = new maplibregl.Marker({ element: markerNode, anchor: "bottom" })
        .setLngLat(event.lngLat)
        .addTo(map);
      setPlace({
        title: "Dropped pin",
        detail: `${event.lngLat.lat.toFixed(4)}, ${event.lngLat.lng.toFixed(4)}`,
      });
    });
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === "Escape") {
        setResults([]);
        searchRef.current?.blur();
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  const goTo = (title: string, center: [number, number], destinationZoom = 10, detail = "Real terrain · block by block") => {
    mapRef.current?.flyTo({ center, zoom: destinationZoom, duration: 1300, essential: true });
    markerRef.current?.remove();
    setPlace({ title, detail });
    setResults([]);
  };

  const searchWorld = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const term = query.trim();
    if (!term || searching) return;
    setSearching(true);
    setMessage("");
    try {
      const params = new URLSearchParams({ q: term, format: "jsonv2", limit: "5" });
      const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`);
      if (!response.ok) throw new Error("Search unavailable");
      const data = (await response.json()) as SearchResult[];
      setResults(data);
      if (data.length === 0) setMessage("No places found. Try a city, landmark, or address.");
    } catch {
      setMessage("World search is resting. Try one of the portals below.");
    } finally {
      setSearching(false);
    }
  };

  const chooseResult = (result: SearchResult) => {
    const south = Number(result.boundingbox[0]);
    const north = Number(result.boundingbox[1]);
    const west = Number(result.boundingbox[2]);
    const east = Number(result.boundingbox[3]);
    const nameParts = result.display_name.split(",").map((part) => part.trim());
    mapRef.current?.fitBounds([[west, south], [east, north]], { padding: 90, maxZoom: 14, duration: 1300 });
    markerRef.current?.remove();
    const markerNode = document.createElement("div");
    markerNode.className = "pixel-marker";
    markerRef.current = new maplibregl.Marker({ element: markerNode, anchor: "bottom" })
      .setLngLat([Number(result.lon), Number(result.lat)])
      .addTo(mapRef.current!);
    setPlace({ title: nameParts[0], detail: nameParts.slice(1, 3).join(", ") || result.type });
    setQuery(result.display_name);
    setResults([]);
  };

  const locateMe = () => {
    if (!navigator.geolocation) {
      setMessage("Location is not available on this device.");
      return;
    }
    setMessage("Finding your spawn point…");
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        goTo("Your location", [coords.longitude, coords.latitude], 13, "Current spawn point");
        setMessage("");
      },
      () => setMessage("Location permission was not granted."),
      { enableHighAccuracy: true, timeout: 8000 },
    );
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" aria-label="Overworld home">
          <span className="brand-cube" aria-hidden="true" />
          <span>OVERWORLD</span>
        </a>
        <div className="search-area">
          <form className="search-shell" onSubmit={searchWorld} role="search">
            <button className="search-button" type="submit" aria-label="Search map">⌕</button>
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search the real world..."
              aria-label="Search for a place"
              autoComplete="off"
            />
            {searching ? <span className="searching" aria-hidden="true" /> : <kbd>⌘ K</kbd>}
          </form>
          {results.length > 0 && (
            <div className="search-results" role="listbox" aria-label="Place search results">
              {results.map((result) => (
                <button key={result.place_id} onClick={() => chooseResult(result)} role="option">
                  <span className="result-pin" aria-hidden="true" />
                  <span>
                    <strong>{result.display_name.split(",")[0]}</strong>
                    <small>{result.display_name.split(",").slice(1).join(",")}</small>
                  </span>
                </button>
              ))}
              <div className="geocode-credit">Search by OpenStreetMap</div>
            </div>
          )}
        </div>
        <div className="header-note">EARTH · SEED 2026</div>
      </header>

      <section className="map-frame" aria-label="Interactive Minecraft-style world map">
        <div ref={mapNode} className="map" />
        <div className="pixel-grid" aria-hidden="true" />
        {!ready && <div className="map-loading"><span />GENERATING CHUNKS…</div>}
        <div className="map-title-card">
          <span className="eyebrow">YOU ARE EXPLORING</span>
          <strong>{place.title}</strong>
          <span>{place.detail}</span>
        </div>
        <div className="zoom-controls" aria-label="Map zoom controls">
          <button onClick={() => mapRef.current?.zoomIn()} aria-label="Zoom in">+</button>
          <span>{zoom}</span>
          <button onClick={() => mapRef.current?.zoomOut()} aria-label="Zoom out">−</button>
        </div>
        <div className="map-tools">
          <button onClick={locateMe} aria-label="Find my location" title="Find my location">◎</button>
          <button onClick={() => setLegendOpen((open) => !open)} aria-label="Toggle map key" title="Map key">▦</button>
        </div>

        {legendOpen && (
          <aside className="map-key" aria-label="Map color key">
            <div className="key-heading">
              <strong>MAP KEY</strong>
              <button onClick={() => setLegendOpen(false)} aria-label="Close map key">×</button>
            </div>
            <div className="key-grid">
              <span><i className="swatch water" /> Water</span>
              <span><i className="swatch forest" /> Forest</span>
              <span><i className="swatch grass" /> Grass</span>
              <span><i className="swatch sand" /> Sand</span>
              <span><i className="swatch built" /> Built</span>
              <span><i className="swatch road" /> Roads</span>
            </div>
          </aside>
        )}

        <nav className="destinations" aria-label="Quick destinations">
          <span>PORTALS</span>
          {destinations.map((destination) => (
            <button
              key={destination.label}
              onClick={() => goTo(destination.label, destination.center, destination.zoom)}
            >
              {destination.label}
            </button>
          ))}
        </nav>

        <div className="coordinates">X {coordinates.lng.toFixed(4)}&nbsp;&nbsp; Z {coordinates.lat.toFixed(4)}</div>
        <div className="map-message" aria-live="polite">{message}</div>
      </section>
    </main>
  );
}
