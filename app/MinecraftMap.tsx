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

type Material =
  | "grass"
  | "farmland"
  | "built"
  | "forest"
  | "sand"
  | "ice"
  | "park"
  | "water"
  | "road"
  | "building";

type MapGeometry = {
  type: string;
  coordinates: unknown;
};

// Java Edition map colors use one base color at four fixed brightness levels.
// Keeping those shades explicit is important: every output cell is a map-color
// block, never a blurred or averaged pixel from the vector map underneath.
const mapPalettes: Record<Material, readonly [string, string, string, string]> = {
  grass: ["#597d27", "#6d9930", "#7fb238", "#435e1d"],
  farmland: ["#6a4c36", "#825e42", "#976d4d", "#4f3928"],
  built: ["#73757f", "#8d909e", "#a4a8b8", "#565861"],
  forest: ["#005700", "#006b00", "#007c00", "#004100"],
  sand: ["#aea473", "#d5c98c", "#f7e9a3", "#827b56"],
  ice: ["#7070b3", "#8989dc", "#a0a0ff", "#545487"],
  park: ["#456b24", "#54832c", "#629933", "#334f1b"],
  water: ["#2d2db4", "#3737dc", "#4040ff", "#222287"],
  road: ["#4e4e4e", "#606060", "#707070", "#3b3b3b"],
  building: ["#4e4e4e", "#606060", "#707070", "#3b3b3b"],
};

const layerMaterials: ReadonlyArray<{ layer: string; material: Material; kind: "fill" | "line" }> = [
  { layer: "farmland", material: "farmland", kind: "fill" },
  { layer: "built-land", material: "built", kind: "fill" },
  { layer: "grass", material: "grass", kind: "fill" },
  { layer: "wood", material: "forest", kind: "fill" },
  { layer: "sand", material: "sand", kind: "fill" },
  { layer: "ice", material: "ice", kind: "fill" },
  { layer: "parks", material: "park", kind: "fill" },
  { layer: "water", material: "water", kind: "fill" },
  { layer: "rivers", material: "water", kind: "line" },
  { layer: "roads", material: "road", kind: "line" },
  { layer: "buildings", material: "building", kind: "fill" },
];

function drawGeometry(
  context: CanvasRenderingContext2D,
  geometry: MapGeometry,
  map: MapLibreMap,
  cellSize: number,
  kind: "fill" | "line",
) {
  const project = (position: unknown) => {
    if (!Array.isArray(position) || position.length < 2) return null;
    const lng = Number(position[0]);
    const lat = Number(position[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    const point = map.project([lng, lat]);
    return { x: point.x / cellSize, y: point.y / cellSize };
  };

  const traceLine = (line: unknown) => {
    if (!Array.isArray(line)) return;
    let started = false;
    for (const position of line) {
      const point = project(position);
      if (!point) continue;
      if (!started) {
        context.moveTo(point.x, point.y);
        started = true;
      } else {
        context.lineTo(point.x, point.y);
      }
    }
  };

  context.beginPath();
  switch (geometry.type) {
    case "Polygon":
      if (Array.isArray(geometry.coordinates)) geometry.coordinates.forEach(traceLine);
      break;
    case "MultiPolygon":
      if (Array.isArray(geometry.coordinates)) {
        geometry.coordinates.forEach((polygon) => {
          if (Array.isArray(polygon)) polygon.forEach(traceLine);
        });
      }
      break;
    case "LineString":
      traceLine(geometry.coordinates);
      break;
    case "MultiLineString":
      if (Array.isArray(geometry.coordinates)) geometry.coordinates.forEach(traceLine);
      break;
    default:
      return;
  }

  if (kind === "fill") context.fill("evenodd");
  else context.stroke();
}

function renderMinecraftCells(map: MapLibreMap, target: HTMLCanvasElement) {
  const source = map.getCanvas();
  if (!map.isStyleLoaded() || source.clientWidth === 0 || source.clientHeight === 0) return;

  const cellSize = window.innerWidth < 720 ? 4 : 4;
  const width = Math.max(1, Math.ceil(source.clientWidth / cellSize));
  const height = Math.max(1, Math.ceil(source.clientHeight / cellSize));
  if (target.width !== width) target.width = width;
  if (target.height !== height) target.height = height;

  const context = target.getContext("2d", { willReadFrequently: true });
  if (!context) return;
  context.imageSmoothingEnabled = false;
  context.lineCap = "square";
  context.lineJoin = "miter";

  const visibleLayers = layerMaterials.map(({ layer }) => layer);
  const features = map.queryRenderedFeatures(undefined, { layers: visibleLayers });
  const featuresByLayer = new Map<string, typeof features>();
  for (const feature of features) {
    const layerFeatures = featuresByLayer.get(feature.layer.id) ?? [];
    layerFeatures.push(feature);
    featuresByLayer.set(feature.layer.id, layerFeatures);
  }

  const materials = new Array<Material>(width * height).fill("grass");
  for (const { layer, material, kind } of layerMaterials) {
    context.clearRect(0, 0, width, height);
    context.fillStyle = "#ffffff";
    context.strokeStyle = "#ffffff";
    if (layer === "roads") {
      context.lineWidth = Math.max(1, (map.getZoom() - 8) / 4);
    } else if (layer === "rivers") {
      context.lineWidth = Math.max(1, (map.getZoom() - 7) / 5);
    } else {
      context.lineWidth = 1;
    }
    for (const feature of featuresByLayer.get(layer) ?? []) {
      drawGeometry(context, feature.geometry as MapGeometry, map, cellSize, kind);
    }
    const mask = context.getImageData(0, 0, width, height).data;
    for (let index = 0; index < materials.length; index += 1) {
      if (mask[index * 4 + 3] >= 128) materials[index] = material;
    }
  }

  // Convert the semantic material grid to the same four brightness bands used
  // by Minecraft maps. Edges get north/south-facing shades, while sparse,
  // geographically anchored shade cells keep large areas from looking flat.
  const materialImage = context.createImageData(width, height);
  const materialPixels = materialImage.data;
  const anchor = map.project([0, 0]);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const material = materials[index];
      const north = y > 0 ? materials[index - width] : material;
      const south = y < height - 1 ? materials[index + width] : material;
      const worldX = Math.floor((x * cellSize - anchor.x) / cellSize);
      const worldY = Math.floor((y * cellSize - anchor.y) / cellSize);
      const hash = Math.abs((Math.floor(worldX / 3) * 73428767) ^ (Math.floor(worldY / 3) * 912931));
      let shade = 1;
      if (north !== material) shade = 2;
      else if (south !== material) shade = 0;
      else if (hash % 89 === 0) shade = 2;
      else if (hash % 113 === 0) shade = 0;

      const color = mapPalettes[material][shade];
      materialPixels[index * 4] = Number.parseInt(color.slice(1, 3), 16);
      materialPixels[index * 4 + 1] = Number.parseInt(color.slice(3, 5), 16);
      materialPixels[index * 4 + 2] = Number.parseInt(color.slice(5, 7), 16);
      materialPixels[index * 4 + 3] = 255;
    }
  }
  context.putImageData(materialImage, 0, 0);
  target.hidden = false;
}

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
    { id: "earth", type: "background", paint: { "background-color": "#5b873d" } },
    {
      id: "farmland",
      type: "fill",
      source: "world",
      "source-layer": "landuse",
      filter: ["in", ["get", "class"], ["literal", ["farmland", "farm", "orchard", "vineyard"]]],
      paint: { "fill-color": "#829346", "fill-opacity": 0.92, "fill-antialias": false },
    },
    {
      id: "built-land",
      type: "fill",
      source: "world",
      "source-layer": "landuse",
      filter: ["in", ["get", "class"], ["literal", ["residential", "commercial", "industrial"]]],
      paint: { "fill-color": "#8f7961", "fill-opacity": 0.88, "fill-antialias": false },
    },
    {
      id: "grass",
      type: "fill",
      source: "world",
      "source-layer": "landcover",
      filter: ["==", ["get", "class"], "grass"],
      paint: { "fill-color": "#64923f", "fill-antialias": false },
    },
    {
      id: "wood",
      type: "fill",
      source: "world",
      "source-layer": "landcover",
      filter: ["==", ["get", "class"], "wood"],
      paint: { "fill-color": "#2f6b2f", "fill-opacity": 0.97, "fill-antialias": false },
    },
    {
      id: "sand",
      type: "fill",
      source: "world",
      "source-layer": "landcover",
      filter: ["==", ["get", "class"], "sand"],
      paint: { "fill-color": "#ded29a", "fill-antialias": false },
    },
    {
      id: "ice",
      type: "fill",
      source: "world",
      "source-layer": "landcover",
      filter: ["==", ["get", "class"], "ice"],
      paint: { "fill-color": "#e5e8e1", "fill-antialias": false },
    },
    {
      id: "parks",
      type: "fill",
      source: "world",
      "source-layer": "park",
      paint: { "fill-color": "#4b7d35", "fill-opacity": 0.9, "fill-antialias": false },
    },
    {
      id: "water",
      type: "fill",
      source: "world",
      "source-layer": "water",
      filter: ["!=", ["get", "brunnel"], "tunnel"],
      paint: { "fill-color": "#354cb8", "fill-antialias": false },
    },
    {
      id: "rivers",
      type: "line",
      source: "world",
      "source-layer": "waterway",
      paint: {
        "line-color": "#354cb8",
        "line-width": ["interpolate", ["linear"], ["zoom"], 7, 0.5, 14, 2.5, 18, 8],
      },
    },
    {
      id: "roads",
      type: "line",
      source: "world",
      "source-layer": "transportation",
      filter: ["in", ["get", "class"], ["literal", ["motorway", "trunk", "primary"]]],
      layout: { "line-cap": "butt", "line-join": "bevel" },
      paint: {
        "line-color": "#cdbc82",
        "line-width": ["interpolate", ["linear"], ["zoom"], 5, 0.4, 12, 1.2, 18, 5],
        "line-opacity": ["interpolate", ["linear"], ["zoom"], 5, 0.48, 10, 0.8],
      },
    },
    {
      id: "buildings",
      type: "fill",
      source: "world",
      "source-layer": "building",
      minzoom: 13,
      paint: { "fill-color": "#756453", "fill-antialias": false },
    },
  ],
};

export default function MinecraftMap() {
  const mapNode = useRef<HTMLDivElement>(null);
  const pixelCanvasRef = useRef<HTMLCanvasElement>(null);
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

    // MapLibre normally resolves its module worker beside the application
    // bundle. Vinext fingerprints that bundle without copying the worker, so
    // point it at the worker files shipped from /public instead.
    maplibregl.setWorkerUrl(`${window.location.origin}/maplibre-gl-worker.mjs`);

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
    let pixelFrame: number | null = null;
    let lastPixelRender = 0;
    const renderPixels = () => {
      if (pixelFrame !== null) return;
      pixelFrame = window.requestAnimationFrame((time) => {
        pixelFrame = null;
        if (time - lastPixelRender < 70) return;
        lastPixelRender = time;
        const target = pixelCanvasRef.current;
        if (!target) return;
        try {
          renderMinecraftCells(map, target);
        } catch {
          target.hidden = true;
          map.getCanvas().classList.add("pixel-fallback");
        }
      });
    };
    map.on("render", renderPixels);
    const loadingTimeout = window.setTimeout(() => setReady(true), 10000);
    map.on("load", () => {
      window.clearTimeout(loadingTimeout);
      const center = map.getCenter();
      setCoordinates({ lng: center.lng, lat: center.lat });
      setZoom(Math.round(map.getZoom()));
      setReady(true);
    });
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
      window.clearTimeout(loadingTimeout);
      if (pixelFrame !== null) window.cancelAnimationFrame(pixelFrame);
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
        <canvas ref={pixelCanvasRef} className="pixel-map-canvas" aria-hidden="true" />
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
