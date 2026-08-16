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
  | "scrub"
  | "sand"
  | "ice"
  | "snow"
  | "rock"
  | "park"
  | "water"
  | "road"
  | "building";

type MapGeometry = {
  type: string;
  coordinates: unknown;
};

type TerrainShadeCache = {
  key: string;
  values: Float32Array | null;
};

type TerrainTile = {
  state: "loading" | "ready" | "error";
  pixels?: Uint8ClampedArray;
};

type TerrainTileCache = Map<string, TerrainTile>;

type NavigationDestination = {
  title: string;
  center: [number, number];
};

type RouteStep = {
  distance: number;
  duration: number;
  name: string;
  maneuver: {
    bearing_after: number;
    location: [number, number];
    modifier?: string;
    type: string;
  };
};

type RouteSummary = {
  distance: number;
  duration: number;
  origin: "GPS location" | "map center";
};

type OsrmRouteResponse = {
  code: string;
  message?: string;
  routes?: Array<{
    distance: number;
    duration: number;
    geometry: { coordinates: Array<[number, number]>; type: "LineString" };
    legs: Array<{ steps: RouteStep[] }>;
  }>;
};

function terrainElevationAt(
  lng: number,
  lat: number,
  zoom: number,
  tiles: TerrainTileCache,
  onReady: () => void,
) {
  const scale = 2 ** zoom;
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const latitude = clampedLat * (Math.PI / 180);
  const tilePositionX = ((lng + 180) / 360) * scale;
  const tilePositionY =
    ((1 - Math.log(Math.tan(latitude) + 1 / Math.cos(latitude)) / Math.PI) / 2) * scale;
  const rawTileX = Math.floor(tilePositionX);
  const tileX = ((rawTileX % scale) + scale) % scale;
  const tileY = Math.max(0, Math.min(scale - 1, Math.floor(tilePositionY)));
  const key = `${zoom}/${tileX}/${tileY}`;
  let tile = tiles.get(key);

  if (!tile) {
    tile = { state: "loading" };
    tiles.set(key, tile);
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = 256;
      canvas.height = 256;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        tile!.state = "error";
        return;
      }
      try {
        context.drawImage(image, 0, 0, 256, 256);
        tile!.pixels = context.getImageData(0, 0, 256, 256).data;
        tile!.state = "ready";
        onReady();
      } catch {
        tile!.state = "error";
      }
    };
    image.onerror = () => {
      tile!.state = "error";
    };
    image.src = `https://demotiles.maplibre.org/terrain-tiles/${zoom}/${tileX}/${tileY}.png`;
    return null;
  }

  if (tile.state !== "ready" || !tile.pixels) return null;
  const pixelX = Math.max(0, Math.min(255, Math.floor((tilePositionX - rawTileX) * 256)));
  const pixelY = Math.max(0, Math.min(255, Math.floor((tilePositionY - Math.floor(tilePositionY)) * 256)));
  const offset = (pixelY * 256 + pixelX) * 4;
  const encoded = tile.pixels[offset] * 65536 + tile.pixels[offset + 1] * 256 + tile.pixels[offset + 2];
  return -10000 + encoded * 0.1;
}

// Java Edition map colors use one base color at four fixed brightness levels.
// Keeping those shades explicit is important: every output cell is a map-color
// block, never a blurred or averaged pixel from the vector map underneath.
const mapPalettes: Record<Material, readonly [string, string, string, string]> = {
  grass: ["#597d27", "#6d9930", "#7fb238", "#435e1d"],
  farmland: ["#6a4c36", "#825e42", "#976d4d", "#4f3928"],
  built: ["#73757f", "#8d909e", "#a4a8b8", "#565861"],
  forest: ["#005700", "#006b00", "#007c00", "#004100"],
  scrub: ["#456b24", "#54832c", "#629933", "#334f1b"],
  sand: ["#aea473", "#d5c98c", "#f7e9a3", "#827b56"],
  ice: ["#7070b3", "#8989dc", "#a0a0ff", "#545487"],
  snow: ["#b2b2b2", "#dadada", "#ffffff", "#858585"],
  rock: ["#4e4e4e", "#606060", "#707070", "#3b3b3b"],
  park: ["#456b24", "#54832c", "#629933", "#334f1b"],
  water: ["#2d2db4", "#3737dc", "#4040ff", "#222287"],
  road: ["#4e4e4e", "#606060", "#707070", "#3b3b3b"],
  building: ["#4e4e4e", "#606060", "#707070", "#3b3b3b"],
};

const mapPaletteRgb = Object.fromEntries(
  (Object.entries(mapPalettes) as Array<[Material, readonly string[]]>).map(([material, palette]) => [
    material,
    palette.map((color) => [
      Number.parseInt(color.slice(1, 3), 16),
      Number.parseInt(color.slice(3, 5), 16),
      Number.parseInt(color.slice(5, 7), 16),
    ]),
  ]),
) as Record<Material, Array<[number, number, number]>>;

const layerMaterials: ReadonlyArray<{ layer: string; material: Material; kind: "fill" | "line" }> = [
  { layer: "farmland", material: "farmland", kind: "fill" },
  { layer: "built-land", material: "built", kind: "fill" },
  { layer: "scrub", material: "scrub", kind: "fill" },
  { layer: "wood", material: "forest", kind: "fill" },
  { layer: "rock", material: "rock", kind: "fill" },
  { layer: "sand", material: "sand", kind: "fill" },
  { layer: "ice", material: "ice", kind: "fill" },
  { layer: "snow", material: "snow", kind: "fill" },
  { layer: "parks", material: "park", kind: "fill" },
  { layer: "water", material: "water", kind: "fill" },
  { layer: "rivers", material: "water", kind: "line" },
  { layer: "roads", material: "road", kind: "line" },
  { layer: "secondary-roads", material: "road", kind: "line" },
  { layer: "local-roads", material: "road", kind: "line" },
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

function minecraftCellSize() {
  return 4;
}

function cellNoise(x: number, y: number, salt = 0) {
  let value = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(salt, 1442695041);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return (value ^ (value >>> 16)) >>> 0;
}

function smoothCellNoise(x: number, y: number, scale: number, salt: number) {
  const scaledX = x / scale;
  const scaledY = y / scale;
  const x0 = Math.floor(scaledX);
  const y0 = Math.floor(scaledY);
  const tx = scaledX - x0;
  const ty = scaledY - y0;
  const smoothX = tx * tx * (3 - 2 * tx);
  const smoothY = ty * ty * (3 - 2 * ty);
  const sample = (sampleX: number, sampleY: number) => cellNoise(sampleX, sampleY, salt) / 0xffffffff;
  const northwest = sample(x0, y0);
  const northeast = sample(x0 + 1, y0);
  const southwest = sample(x0, y0 + 1);
  const southeast = sample(x0 + 1, y0 + 1);
  const north = northwest + (northeast - northwest) * smoothX;
  const south = southwest + (southeast - southwest) * smoothX;
  return north + (south - north) * smoothY;
}

function distanceFromCells(
  width: number,
  height: number,
  isOrigin: (index: number) => boolean,
  maxDistance = 16,
) {
  const distances = new Uint8Array(width * height);
  for (let index = 0; index < distances.length; index += 1) {
    distances[index] = isOrigin(index) ? 0 : maxDistance;
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      let distance = distances[index];
      if (x > 0) distance = Math.min(distance, distances[index - 1] + 1);
      if (y > 0) distance = Math.min(distance, distances[index - width] + 1);
      distances[index] = distance;
    }
  }
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const index = y * width + x;
      let distance = distances[index];
      if (x + 1 < width) distance = Math.min(distance, distances[index + 1] + 1);
      if (y + 1 < height) distance = Math.min(distance, distances[index + width] + 1);
      distances[index] = distance;
    }
  }
  return distances;
}

function renderMinecraftCells(
  map: MapLibreMap,
  target: HTMLCanvasElement,
  terrainCache: TerrainShadeCache,
  terrainTiles: TerrainTileCache,
  onTerrainReady: () => void,
) {
  const source = map.getCanvas();
  if (source.clientWidth === 0 || source.clientHeight === 0) return;

  const cellSize = minecraftCellSize();
  const width = Math.max(1, Math.ceil(source.clientWidth / cellSize));
  const height = Math.max(1, Math.ceil(source.clientHeight / cellSize));
  // The same bitmap hosts the cheap moving preview. Reset it before the
  // semantic pass so mask reads always happen on a clean canvas.
  target.width = width;
  target.height = height;

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
  let buildingCells: Uint8Array | undefined;
  for (const { layer, material, kind } of layerMaterials) {
    const layerFeatures = featuresByLayer.get(layer);
    if (!layerFeatures?.length) continue;
    context.clearRect(0, 0, width, height);
    context.fillStyle = "#ffffff";
    context.strokeStyle = "#ffffff";
    if (layer === "roads" || layer === "secondary-roads" || layer === "local-roads") {
      context.lineWidth = map.getZoom() >= 17.5 ? 1.5 : 1;
    } else if (layer === "rivers") {
      context.lineWidth = map.getZoom() >= 18 ? 1.5 : 1;
    } else {
      context.lineWidth = 1;
    }
    for (const feature of layerFeatures) {
      drawGeometry(context, feature.geometry as MapGeometry, map, cellSize, kind);
    }
    const mask = context.getImageData(0, 0, width, height).data;
    const occupied = layer === "buildings" ? new Uint8Array(width * height) : undefined;
    for (let index = 0; index < materials.length; index += 1) {
      if (mask[index * 4 + 3] >= 128) {
        materials[index] = material;
        if (occupied) occupied[index] = 1;
      }
    }
    if (occupied) buildingCells = occupied;
  }

  // Open map data often omits an explicit residential polygon at close zooms.
  // Where building footprints form a cluster, infer the paved/constructed
  // surface between them instead of pretending central-city blocks are grass.
  if (buildingCells && map.getZoom() >= 13) {
    const radius = Math.min(7, Math.max(3, Math.round(map.getZoom() - 11)));
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        if (materials[index] !== "grass") continue;
        let left = false;
        let right = false;
        let up = false;
        let down = false;
        for (let distance = 1; distance <= radius; distance += 1) {
          if (x - distance >= 0 && buildingCells[index - distance]) left = true;
          if (x + distance < width && buildingCells[index + distance]) right = true;
          if (y - distance >= 0 && buildingCells[index - distance * width]) up = true;
          if (y + distance < height && buildingCells[index + distance * width]) down = true;
        }
        if ((left && right) || (up && down)) materials[index] = "built";
      }
    }
    // Restore the roof material after inferring the surrounding urban surface.
    for (let index = 0; index < materials.length; index += 1) {
      if (buildingCells[index]) materials[index] = "building";
    }
  }

  // Minecraft coastlines are rarely a single hard blue/green edge. Infer a
  // narrow, irregular beach from the real shoreline, while preserving mapped
  // roads, structures, cliffs, and snow. Water depth is retained separately
  // for the stepped blue bands visible on filled maps.
  const anchor = map.project([0, 0]);
  const distanceToWater = distanceFromCells(
    width,
    height,
    (index) => materials[index] === "water",
    4,
  );
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const material = materials[index];
      const distance = distanceToWater[index];
      if (distance < 1 || distance > 2) continue;
      const worldX = Math.floor((x * cellSize - anchor.x) / cellSize);
      const worldY = Math.floor((y * cellSize - anchor.y) / cellSize);
      const noise = cellNoise(worldX, worldY, 19);
      const openShore = material === "grass" || material === "park" || material === "scrub";
      const woodedShore = material === "forest" || material === "farmland";
      if (
        (openShore && (distance === 1 ? noise % 5 !== 0 : noise % 4 === 0)) ||
        (woodedShore && distance === 1 && noise % 6 === 0)
      ) {
        materials[index] = "sand";
      }
    }
  }
  const waterDepth = distanceFromCells(
    width,
    height,
    (index) => materials[index] !== "water",
    16,
  );

  // Sample cached DEM tiles for the current view. Minecraft's
  // four map shades are chosen from the elevation change toward the north, so
  // hills form irregular bands instead of vector-style feature outlines.
  const elevations = new Float32Array(width * height);
  elevations.fill(Number.NaN);
  const center = map.getCenter();
  const terrainKey = `${map.getZoom().toFixed(3)}/${center.lng.toFixed(5)}/${center.lat.toFixed(5)}/${width}/${height}`;
  if (terrainCache.key === terrainKey && terrainCache.values?.length === elevations.length) {
    elevations.set(terrainCache.values);
  } else if (!map.isMoving()) {
    // DEM lookups are sampled on a small grid and interpolated. That mirrors
    // the coarse elevation averaging used by zoomed Minecraft maps and keeps
    // panning responsive even on a large display.
    const step = 6;
    const sampleWidth = Math.ceil(width / step) + 1;
    const sampleHeight = Math.ceil(height / step) + 1;
    const samples = new Float32Array(sampleWidth * sampleHeight);
    samples.fill(Number.NaN);
    let terrainSamples = 0;
    for (let sy = 0; sy < sampleHeight; sy += 1) {
      for (let sx = 0; sx < sampleWidth; sx += 1) {
        const x = Math.min(width - 1, sx * step);
        const y = Math.min(height - 1, sy * step);
        const location = map.unproject([(x + 0.5) * cellSize, (y + 0.5) * cellSize]);
        const terrainZoom = Math.min(12, Math.max(2, Math.floor(map.getZoom())));
        const elevation = terrainElevationAt(location.lng, location.lat, terrainZoom, terrainTiles, onTerrainReady);
        if (elevation != null) {
          samples[sy * sampleWidth + sx] = elevation;
          terrainSamples += 1;
        }
      }
    }
    for (let y = 0; y < height; y += 1) {
      const sy = Math.floor(y / step);
      const ty = (y % step) / step;
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        if (materials[index] === "water") continue;
        const sx = Math.floor(x / step);
        const tx = (x % step) / step;
        const a = samples[sy * sampleWidth + sx];
        const b = samples[sy * sampleWidth + sx + 1];
        const c = samples[(sy + 1) * sampleWidth + sx];
        const d = samples[(sy + 1) * sampleWidth + sx + 1];
        if ([a, b, c, d].every(Number.isFinite)) {
          const north = a + (b - a) * tx;
          const south = c + (d - c) * tx;
          elevations[index] = north + (south - north) * ty;
        }
      }
    }
    if (terrainSamples > sampleWidth * sampleHeight * 0.8) {
      terrainCache.key = terrainKey;
      terrainCache.values = elevations.slice();
    }
  }

  // Convert the semantic material grid to the same four brightness bands used
  // by the game. Gentle, clustered biome variation supplies the fine texture
  // visible on a filled map without outlining the source polygons.
  const materialImage = context.createImageData(width, height);
  const materialPixels = materialImage.data;
  const latitude = map.getCenter().lat * (Math.PI / 180);
  const metersPerCell = (156543.03392 * Math.cos(latitude) * cellSize) / 2 ** map.getZoom();
  const slopeThreshold = Math.max(1, metersPerCell * 0.015);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const material = materials[index];
      const worldX = Math.floor((x * cellSize - anchor.x) / cellSize);
      const worldY = Math.floor((y * cellSize - anchor.y) / cellSize);
      const hash = cellNoise(worldX, worldY, 31);
      const terrainNoise =
        smoothCellNoise(worldX, worldY, 11, 47) * 0.7 +
        smoothCellNoise(worldX, worldY, 4, 71) * 0.3;
      let shade = 1;
      if (material === "water") {
        const depth = waterDepth[index];
        if (depth <= 1) shade = 2;
        else if (depth <= 3) shade = 1;
        else if (depth <= 8) shade = 0;
        else shade = terrainNoise < 0.25 || hash % 31 === 0 ? 3 : 0;
        if (depth > 2 && hash % 23 === 0) shade = shade === 3 ? 0 : 1;
      } else if (material === "forest") {
        shade = terrainNoise < 0.34 || hash % 7 < 2 ? 0 : 1;
        if (hash % 29 === 0) shade = 2;
        else if (hash % 41 === 0) shade = 3;
      } else if (material === "scrub") {
        shade = terrainNoise < 0.32 || hash % 8 < 2 ? 0 : 1;
        if (hash % 31 === 0) shade = 2;
      } else if (material === "grass" || material === "park") {
        shade = terrainNoise < 0.29 || hash % 11 < 2 ? 0 : 1;
        if (hash % 23 === 0) shade = 2;
        else if (hash % 97 === 0) shade = 3;
      } else if (material === "sand") {
        shade = hash % 9 < 3 ? 0 : hash % 17 < 3 ? 2 : 1;
        if (hash % 101 === 0) shade = 3;
      } else if (material === "built") {
        shade = hash % 8 < 2 ? 0 : hash % 19 === 0 ? 2 : 1;
      } else if (material === "building") {
        shade = hash % 7 === 0 ? 3 : hash % 5 === 0 ? 1 : 0;
      } else if (material === "farmland") {
        const rowBand = ((worldX + worldY) % 7 + 7) % 7;
        shade = rowBand < 2 || hash % 13 === 0 ? 0 : 1;
        if (hash % 37 === 0) shade = 2;
      } else if (material === "rock") {
        shade = hash % 7 < 2 ? 0 : hash % 23 === 0 ? 2 : 1;
      } else if (material === "road") {
        shade = hash % 17 === 0 ? 0 : 1;
      } else if (hash % 29 === 0) {
        shade = 0;
      }

      const elevation = elevations[index];
      const northElevation = y > 0 ? elevations[index - width] : elevation;
      if (material !== "water" && Number.isFinite(elevation) && Number.isFinite(northElevation)) {
        const rise = elevation - northElevation;
        if (rise > slopeThreshold) shade = 2;
        else if (rise < -slopeThreshold * 2) shade = 3;
        else if (rise < -slopeThreshold) shade = 0;
      }

      const [red, green, blue] = mapPaletteRgb[material][shade];
      materialPixels[index * 4] = red;
      materialPixels[index * 4 + 1] = green;
      materialPixels[index * 4 + 2] = blue;
      materialPixels[index * 4 + 3] = 255;
    }
  }
  context.putImageData(materialImage, 0, 0);
  target.hidden = false;
}

function renderMovingPreview(map: MapLibreMap, target: HTMLCanvasElement) {
  const source = map.getCanvas();
  if (source.clientWidth === 0 || source.clientHeight === 0) return;

  const cellSize = minecraftCellSize();
  const width = Math.max(1, Math.ceil(source.clientWidth / cellSize));
  const height = Math.max(1, Math.ceil(source.clientHeight / cellSize));
  if (target.width !== width) target.width = width;
  if (target.height !== height) target.height = height;

  const context = target.getContext("2d");
  if (!context) return;
  context.imageSmoothingEnabled = false;
  context.clearRect(0, 0, width, height);
  context.drawImage(source, 0, 0, source.width, source.height, 0, 0, width, height);
  target.hidden = false;
}

function renderNavigationRoute(
  map: MapLibreMap,
  target: HTMLCanvasElement,
  coordinates: Array<[number, number]>,
) {
  const source = map.getCanvas();
  const cellSize = minecraftCellSize();
  const width = Math.max(1, Math.ceil(source.clientWidth / cellSize));
  const height = Math.max(1, Math.ceil(source.clientHeight / cellSize));
  if (target.width !== width) target.width = width;
  if (target.height !== height) target.height = height;

  const context = target.getContext("2d");
  if (!context) return;
  context.clearRect(0, 0, width, height);
  if (coordinates.length < 2) return;

  context.imageSmoothingEnabled = false;
  context.lineCap = "square";
  context.lineJoin = "miter";
  context.beginPath();
  for (let index = 0; index < coordinates.length; index += 1) {
    const point = map.project(coordinates[index]);
    const x = point.x / cellSize;
    const y = point.y / cellSize;
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.strokeStyle = "#4a211d";
  context.lineWidth = 3.5;
  context.stroke();
  context.strokeStyle = "#f7e9a3";
  context.lineWidth = 1.5;
  context.stroke();
}

function formatRouteDistance(meters: number) {
  const miles = meters / 1609.344;
  if (miles >= 0.2) return `${miles < 10 ? miles.toFixed(1) : Math.round(miles)} mi`;
  return `${Math.max(50, Math.round((meters * 3.28084) / 50) * 50)} ft`;
}

function formatRouteDuration(seconds: number) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} hr ${remainder} min` : `${hours} hr`;
}

function compassDirection(bearing: number) {
  const directions = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
  return directions[Math.round(((bearing % 360) + 360) % 360 / 45) % 8];
}

function routeInstruction(step: RouteStep) {
  const road = step.name ? ` ${step.name}` : " the road";
  const modifier = step.maneuver.modifier?.replace("uturn", "U-turn") ?? "";
  switch (step.maneuver.type) {
    case "depart":
      return `Head ${compassDirection(step.maneuver.bearing_after)} on${road}`;
    case "arrive":
      return "Arrive at your destination";
    case "turn":
      return `Turn ${modifier} onto${road}`;
    case "continue":
      return `Continue ${modifier} on${road}`;
    case "merge":
      return `Merge ${modifier} onto${road}`;
    case "fork":
      return `Keep ${modifier} onto${road}`;
    case "on ramp":
      return `Take the ramp ${modifier} onto${road}`;
    case "off ramp":
      return `Take the exit ${modifier} onto${road}`;
    case "roundabout":
    case "rotary":
      return `Enter the roundabout toward${road}`;
    case "new name":
      return `Continue onto${road}`;
    case "end of road":
      return `At the end of the road, turn ${modifier} onto${road}`;
    default:
      return `Continue on${road}`;
  }
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
        '<a href="https://openfreemap.org">OpenFreeMap</a> · <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · <a href="https://earth.jaxa.jp/en/data/policy/">AW3D30 (JAXA)</a>',
    },
  },
  layers: [
    { id: "earth", type: "background", paint: { "background-color": "#6d9930" } },
    {
      id: "farmland",
      type: "fill",
      source: "world",
      "source-layer": "landuse",
      filter: ["in", ["get", "class"], ["literal", ["agriculture", "farmland", "farm", "orchard", "vineyard"]]],
      paint: { "fill-color": "#825e42", "fill-opacity": 1, "fill-antialias": false },
    },
    {
      id: "built-land",
      type: "fill",
      source: "world",
      "source-layer": "landuse",
      filter: ["in", ["get", "class"], ["literal", ["residential", "commercial", "industrial"]]],
      paint: { "fill-color": "#8d909e", "fill-opacity": 1, "fill-antialias": false },
    },
    {
      id: "grass",
      type: "fill",
      source: "world",
      "source-layer": "landcover",
      filter: ["==", ["get", "class"], "grass"],
      paint: { "fill-color": "#6d9930", "fill-antialias": false },
    },
    {
      id: "scrub",
      type: "fill",
      source: "world",
      "source-layer": "landcover",
      filter: ["in", ["get", "class"], ["literal", ["scrub", "shrub"]]],
      paint: { "fill-color": "#54832c", "fill-antialias": false },
    },
    {
      id: "wood",
      type: "fill",
      source: "world",
      "source-layer": "landcover",
      filter: ["==", ["get", "class"], "wood"],
      paint: { "fill-color": "#006b00", "fill-opacity": 1, "fill-antialias": false },
    },
    {
      id: "sand",
      type: "fill",
      source: "world",
      "source-layer": "landcover",
      filter: ["==", ["get", "class"], "sand"],
      paint: { "fill-color": "#d5c98c", "fill-antialias": false },
    },
    {
      id: "rock",
      type: "fill",
      source: "world",
      "source-layer": "landcover",
      filter: ["in", ["get", "class"], ["literal", ["rock", "bare_rock"]]],
      paint: { "fill-color": "#606060", "fill-antialias": false },
    },
    {
      id: "ice",
      type: "fill",
      source: "world",
      "source-layer": "landcover",
      filter: ["in", ["get", "class"], ["literal", ["ice", "glacier"]]],
      paint: { "fill-color": "#8989dc", "fill-antialias": false },
    },
    {
      id: "snow",
      type: "fill",
      source: "world",
      "source-layer": "landcover",
      filter: ["==", ["get", "class"], "snow"],
      paint: { "fill-color": "#ffffff", "fill-antialias": false },
    },
    {
      id: "parks",
      type: "fill",
      source: "world",
      "source-layer": "park",
      paint: { "fill-color": "#54832c", "fill-opacity": 1, "fill-antialias": false },
    },
    {
      id: "water",
      type: "fill",
      source: "world",
      "source-layer": "water",
      filter: ["!=", ["get", "brunnel"], "tunnel"],
      paint: { "fill-color": "#3737dc", "fill-antialias": false },
    },
    {
      id: "rivers",
      type: "line",
      source: "world",
      "source-layer": "waterway",
      paint: {
        "line-color": "#3737dc",
        "line-width": ["interpolate", ["linear"], ["zoom"], 7, 0.5, 14, 2.5, 18, 8],
      },
    },
    {
      id: "roads",
      type: "line",
      source: "world",
      "source-layer": "transportation",
      minzoom: 11,
      filter: ["in", ["get", "class"], ["literal", ["motorway", "trunk", "primary"]]],
      layout: { "line-cap": "butt", "line-join": "bevel" },
      paint: {
        "line-color": "#606060",
        "line-width": ["interpolate", ["linear"], ["zoom"], 11, 0.6, 15, 1.5, 18, 3],
        "line-opacity": 1,
      },
    },
    {
      id: "secondary-roads",
      type: "line",
      source: "world",
      "source-layer": "transportation",
      minzoom: 13.5,
      filter: ["==", ["get", "class"], "secondary"],
      layout: { "line-cap": "butt", "line-join": "bevel" },
      paint: {
        "line-color": "#606060",
        "line-width": ["interpolate", ["linear"], ["zoom"], 13.5, 0.5, 18, 2],
      },
    },
    {
      id: "local-roads",
      type: "line",
      source: "world",
      "source-layer": "transportation",
      minzoom: 15,
      filter: ["in", ["get", "class"], ["literal", ["tertiary", "minor"]]],
      layout: { "line-cap": "butt", "line-join": "bevel" },
      paint: {
        "line-color": "#606060",
        "line-width": ["interpolate", ["linear"], ["zoom"], 15, 0.5, 18, 1.25],
      },
    },
    {
      id: "buildings",
      type: "fill",
      source: "world",
      "source-layer": "building",
      minzoom: 13,
      paint: { "fill-color": "#606060", "fill-antialias": false },
    },
  ],
};

export default function MinecraftMap() {
  const mapNode = useRef<HTMLDivElement>(null);
  const pixelCanvasRef = useRef<HTMLCanvasElement>(null);
  const routeCanvasRef = useRef<HTMLCanvasElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const destinationMarkerRef = useRef<maplibregl.Marker | null>(null);
  const userMarkerRef = useRef<maplibregl.Marker | null>(null);
  const locationWatchRef = useRef<number | null>(null);
  const followingLocationRef = useRef(false);
  const navigationOpenRef = useRef(false);
  const navigationOriginRef = useRef<[number, number] | null>(null);
  const routeCoordinatesRef = useRef<Array<[number, number]>>([]);
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
  const [gpsMode, setGpsMode] = useState<"idle" | "locating" | "tracking">("idle");
  const [followingLocation, setFollowingLocation] = useState(false);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [navigationDestination, setNavigationDestination] = useState<NavigationDestination | null>(null);
  const [routeSummary, setRouteSummary] = useState<RouteSummary | null>(null);
  const [routeSteps, setRouteSteps] = useState<RouteStep[]>([]);
  const [routeActive, setRouteActive] = useState(false);
  const [routing, setRouting] = useState(false);
  const [routeError, setRouteError] = useState("");

  useEffect(() => {
    if (!mapNode.current || mapRef.current) return;

    // MapLibre normally resolves its module worker beside the application
    // bundle. Vinext fingerprints that bundle without copying the worker, so
    // point it at the worker files shipped from /public instead.
    maplibregl.setWorkerUrl(`${window.location.origin}/maplibre-gl-worker.mjs`);

    const hashParts = window.location.hash.slice(1).split("/").map(Number);
    const hasSharedView = hashParts.length === 3 && hashParts.every(Number.isFinite);
    if (hasSharedView) {
      setPlace({
        title: "World view",
        detail: `${hashParts[1].toFixed(4)}, ${hashParts[2].toFixed(4)}`,
      });
    }
    const map = new maplibregl.Map({
      container: mapNode.current,
      style: minecraftStyle,
      center: hasSharedView ? [hashParts[2], hashParts[1]] : [-74.006, 40.7128],
      zoom: hasSharedView ? hashParts[0] : 10,
      minZoom: 2,
      maxZoom: 18,
      pixelRatio: 1,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
    });

    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    let pixelFrame: number | null = null;
    let previewFrame: number | null = null;
    let pixelTimer: number | null = null;
    const terrainCache: TerrainShadeCache = { key: "", values: null };
    const terrainTiles: TerrainTileCache = new Map();
    mapNode.current.classList.add("map-moving");
    const renderPixels = (delay = 80) => {
      if (pixelTimer !== null) window.clearTimeout(pixelTimer);
      pixelTimer = window.setTimeout(() => {
        pixelTimer = null;
        if (map.isMoving() || pixelFrame !== null) return;
        pixelFrame = window.requestAnimationFrame(() => {
          pixelFrame = null;
          const target = pixelCanvasRef.current;
          if (!target) return;
          try {
            renderMinecraftCells(map, target, terrainCache, terrainTiles, () => renderPixels(100));
            const routeTarget = routeCanvasRef.current;
            if (routeTarget) renderNavigationRoute(map, routeTarget, routeCoordinatesRef.current);
            mapNode.current?.classList.remove("map-moving");
          } catch {
            renderMovingPreview(map, target);
            const routeTarget = routeCanvasRef.current;
            if (routeTarget) renderNavigationRoute(map, routeTarget, routeCoordinatesRef.current);
            mapNode.current?.classList.remove("map-moving");
          }
        });
      }, delay);
    };
    const renderPreview = () => {
      if (previewFrame !== null) return;
      previewFrame = window.requestAnimationFrame(() => {
        previewFrame = null;
        const target = pixelCanvasRef.current;
        if (target) renderMovingPreview(map, target);
        const routeTarget = routeCanvasRef.current;
        if (routeTarget) renderNavigationRoute(map, routeTarget, routeCoordinatesRef.current);
      });
    };
    const loadingTimeout = window.setTimeout(() => setReady(true), 10000);
    map.on("load", () => {
      window.clearTimeout(loadingTimeout);
      const center = map.getCenter();
      setCoordinates({ lng: center.lng, lat: center.lat });
      setZoom(Math.round(map.getZoom()));
      setReady(true);
      renderPixels(0);
    });
    map.on("idle", () => renderPixels(0));
    map.on("movestart", () => {
      mapNode.current?.classList.add("map-moving");
      if (pixelTimer !== null) window.clearTimeout(pixelTimer);
      pixelTimer = null;
      renderPreview();
    });
    map.on("render", () => {
      if (map.isMoving()) renderPreview();
    });
    map.on("dragstart", () => {
      if (!followingLocationRef.current) return;
      followingLocationRef.current = false;
      setFollowingLocation(false);
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
      terrainCache.key = "";
      renderPixels(40);
    });
    map.on("click", (event) => {
      if (navigationOpenRef.current) {
        destinationMarkerRef.current?.remove();
        const destinationNode = document.createElement("div");
        destinationNode.className = "pixel-marker route-destination-marker";
        destinationMarkerRef.current = new maplibregl.Marker({ element: destinationNode, anchor: "bottom" })
          .setLngLat(event.lngLat)
          .addTo(map);
        setNavigationDestination({
          title: "Dropped destination",
          center: [event.lngLat.lng, event.lngLat.lat],
        });
        routeCoordinatesRef.current = [];
        setRouteSummary(null);
        setRouteSteps([]);
        setRouteActive(false);
        setRouteError("");
        const routeTarget = routeCanvasRef.current;
        if (routeTarget) renderNavigationRoute(map, routeTarget, []);
        setMessage("Destination set. Select START ROUTE when ready.");
        return;
      }
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
      if (pixelTimer !== null) window.clearTimeout(pixelTimer);
      if (pixelFrame !== null) window.cancelAnimationFrame(pixelFrame);
      if (previewFrame !== null) window.cancelAnimationFrame(previewFrame);
      if (locationWatchRef.current !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(locationWatchRef.current);
        locationWatchRef.current = null;
      }
      userMarkerRef.current?.remove();
      destinationMarkerRef.current?.remove();
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

  const setNavigationVisible = (open: boolean) => {
    const wasOpen = navigationOpenRef.current;
    navigationOpenRef.current = open;
    setNavigationOpen(open);
    if (open) {
      if (!wasOpen && mapRef.current) {
        const center = mapRef.current.getCenter();
        navigationOriginRef.current = [center.lng, center.lat];
      }
      setLegendOpen(false);
      setMessage("Search above or click the map to choose a destination.");
      window.setTimeout(() => searchRef.current?.focus(), 0);
    }
  };

  const resetRoute = (removeDestination = false) => {
    routeCoordinatesRef.current = [];
    setRouteSummary(null);
    setRouteSteps([]);
    setRouteActive(false);
    setRouteError("");
    const map = mapRef.current;
    const target = routeCanvasRef.current;
    if (map && target) renderNavigationRoute(map, target, []);
    if (removeDestination) {
      destinationMarkerRef.current?.remove();
      destinationMarkerRef.current = null;
      setNavigationDestination(null);
    }
  };

  const selectNavigationDestination = (title: string, center: [number, number]) => {
    const map = mapRef.current;
    if (!map) return;
    resetRoute(false);
    destinationMarkerRef.current?.remove();
    const destinationNode = document.createElement("div");
    destinationNode.className = "pixel-marker route-destination-marker";
    destinationMarkerRef.current = new maplibregl.Marker({ element: destinationNode, anchor: "bottom" })
      .setLngLat(center)
      .addTo(map);
    setNavigationDestination({ title, center });
    setMessage("Destination set. Select START ROUTE when ready.");
  };

  const endNavigation = () => {
    resetRoute(true);
    setNavigationVisible(false);
    setMessage("Navigation ended.");
  };

  const goTo = (title: string, center: [number, number], destinationZoom = 10, detail = "Real terrain · block by block") => {
    setLocationFollowing(false);
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
    const resultCenter: [number, number] = [Number(result.lon), Number(result.lat)];
    if (navigationOpenRef.current) {
      selectNavigationDestination(nameParts[0], resultCenter);
      mapRef.current?.fitBounds([[west, south], [east, north]], { padding: 90, maxZoom: 15, duration: 900 });
      setQuery(result.display_name);
      setResults([]);
      return;
    }
    setLocationFollowing(false);
    mapRef.current?.fitBounds([[west, south], [east, north]], { padding: 90, maxZoom: 14, duration: 1300 });
    markerRef.current?.remove();
    const markerNode = document.createElement("div");
    markerNode.className = "pixel-marker";
    markerRef.current = new maplibregl.Marker({ element: markerNode, anchor: "bottom" })
      .setLngLat(resultCenter)
      .addTo(mapRef.current!);
    setPlace({ title: nameParts[0], detail: nameParts.slice(1, 3).join(", ") || result.type });
    setQuery(result.display_name);
    setResults([]);
  };

  const setLocationFollowing = (following: boolean) => {
    followingLocationRef.current = following;
    setFollowingLocation(following);
  };

  const stopGps = () => {
    if (locationWatchRef.current !== null) {
      navigator.geolocation.clearWatch(locationWatchRef.current);
      locationWatchRef.current = null;
    }
    userMarkerRef.current?.remove();
    userMarkerRef.current = null;
    setLocationFollowing(false);
    setGpsMode("idle");
    setPlace((current) =>
      current.title === "Your location"
        ? { title: current.title, detail: "GPS stopped · last known position" }
        : current,
    );
    setMessage("GPS stopped.");
  };

  const locateMe = () => {
    if (!navigator.geolocation) {
      setMessage("Location is not available on this device.");
      return;
    }

    if (locationWatchRef.current !== null) {
      if (followingLocationRef.current) {
        stopGps();
      } else if (userMarkerRef.current && mapRef.current) {
        setLocationFollowing(true);
        mapRef.current.easeTo({
          center: userMarkerRef.current.getLngLat(),
          duration: 650,
          essential: true,
        });
        setMessage("Following your live GPS position.");
      }
      return;
    }

    setGpsMode("locating");
    setLocationFollowing(true);
    setMessage("Finding your spawn point…");
    locationWatchRef.current = navigator.geolocation.watchPosition(
      ({ coords }) => {
        const map = mapRef.current;
        if (!map) return;
        const location: [number, number] = [coords.longitude, coords.latitude];
        const isFirstFix = userMarkerRef.current === null;

        if (!userMarkerRef.current) {
          const markerNode = document.createElement("div");
          markerNode.className = "player-marker-shell";
          const arrowNode = document.createElement("div");
          arrowNode.className = "player-marker-arrow";
          markerNode.appendChild(arrowNode);
          userMarkerRef.current = new maplibregl.Marker({ element: markerNode, anchor: "center" })
            .setLngLat(location)
            .addTo(map);
        } else {
          userMarkerRef.current.setLngLat(location);
        }

        const arrow = userMarkerRef.current.getElement().querySelector<HTMLElement>(".player-marker-arrow");
        if (arrow && coords.heading != null && Number.isFinite(coords.heading)) {
          arrow.style.setProperty("--player-heading", `${coords.heading}deg`);
        }

        if (followingLocationRef.current) {
          const distanceFromCenter = map.getCenter().distanceTo(location);
          const movementThreshold = Math.max(8, coords.accuracy * 0.15);
          if (isFirstFix || distanceFromCenter > movementThreshold) {
            map.easeTo({
              center: location,
              zoom: isFirstFix ? Math.max(15, map.getZoom()) : map.getZoom(),
              duration: isFirstFix ? 800 : 500,
              essential: true,
            });
          }
        }

        setGpsMode("tracking");
        setPlace({
          title: "Your location",
          detail: `GPS live · accurate to ±${Math.round(coords.accuracy)} m`,
        });
        setMessage("");
      },
      (error) => {
        if (locationWatchRef.current !== null) {
          navigator.geolocation.clearWatch(locationWatchRef.current);
          locationWatchRef.current = null;
        }
        setLocationFollowing(false);
        setGpsMode("idle");
        setMessage(
          error.code === error.PERMISSION_DENIED
            ? "Location permission was not granted."
            : "Your GPS position is unavailable right now.",
        );
      },
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 },
    );
  };

  const startNavigation = async () => {
    const map = mapRef.current;
    if (!map || !navigationDestination || routing) return;
    setRouting(true);
    setRouteError("");
    setMessage("Charting the fastest route…");

    let origin: [number, number];
    let originLabel: RouteSummary["origin"] = "map center";
    const liveMarker = userMarkerRef.current;
    if (liveMarker) {
      const location = liveMarker.getLngLat();
      origin = [location.lng, location.lat];
      originLabel = "GPS location";
    } else if (navigator.geolocation) {
      try {
        const position = await new Promise<GeolocationPosition>((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: true,
            maximumAge: 5000,
            timeout: 8000,
          });
        });
        origin = [position.coords.longitude, position.coords.latitude];
        originLabel = "GPS location";
        if (locationWatchRef.current === null) {
          locateMe();
          setLocationFollowing(false);
        }
      } catch {
        const center: [number, number] = navigationOriginRef.current ?? [map.getCenter().lng, map.getCenter().lat];
        origin = center;
      }
    } else {
      const center: [number, number] = navigationOriginRef.current ?? [map.getCenter().lng, map.getCenter().lat];
      origin = center;
    }

    try {
      const params = new URLSearchParams({
        from: `${origin[0]},${origin[1]}`,
        to: `${navigationDestination.center[0]},${navigationDestination.center[1]}`,
      });
      const response = await fetch(`/api/route?${params}`);
      const result = (await response.json()) as OsrmRouteResponse;
      const route = result.routes?.[0];
      if (!response.ok || result.code !== "Ok" || !route) {
        throw new Error(result.message || "No route found");
      }

      routeCoordinatesRef.current = route.geometry.coordinates;
      setRouteSummary({ distance: route.distance, duration: route.duration, origin: originLabel });
      setRouteSteps(route.legs.flatMap((leg) => leg.steps));
      setRouteActive(true);
      setLocationFollowing(false);
      const routeTarget = routeCanvasRef.current;
      if (routeTarget) renderNavigationRoute(map, routeTarget, route.geometry.coordinates);

      const bounds = route.geometry.coordinates.reduce(
        (current, coordinate) => current.extend(coordinate),
        new maplibregl.LngLatBounds(route.geometry.coordinates[0], route.geometry.coordinates[0]),
      );
      map.fitBounds(bounds, {
        padding: { top: 70, right: 70, bottom: 90, left: window.innerWidth > 720 ? 360 : 70 },
        maxZoom: 16,
        duration: 900,
      });
      setPlace({
        title: navigationDestination.title,
        detail: `${formatRouteDistance(route.distance)} · ${formatRouteDuration(route.duration)}`,
      });
      setMessage(originLabel === "GPS location" ? "Route ready · GPS position is live." : "Route starts from the map center.");
    } catch (error) {
      setRouteError(error instanceof Error ? error.message : "A route could not be calculated.");
      setMessage("Navigation could not chart that route.");
    } finally {
      setRouting(false);
    }
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
              placeholder={navigationOpen ? "Search for a destination..." : "Search the real world..."}
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
        <canvas ref={routeCanvasRef} className="route-map-canvas" aria-hidden="true" />
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
          <button
            className={gpsMode === "tracking" ? "gps-active" : ""}
            onClick={locateMe}
            aria-label={
              gpsMode === "idle"
                ? "Start live GPS"
                : followingLocation
                  ? "Stop live GPS"
                  : "Follow my live GPS position"
            }
            aria-pressed={gpsMode === "tracking"}
            title={
              gpsMode === "idle"
                ? "Start live GPS"
                : followingLocation
                  ? "GPS live — tap to stop"
                  : "Recenter on my location"
            }
          >
            {gpsMode === "locating" ? <span className="gps-loading" /> : "◎"}
          </button>
          <button
            className={navigationOpen || routeActive ? "navigation-active" : ""}
            onClick={() => setNavigationVisible(!navigationOpenRef.current)}
            aria-label={navigationOpen ? "Close navigation panel" : "Open navigation"}
            aria-pressed={navigationOpen}
            title="Navigation"
          >
            ➤
          </button>
          <button onClick={() => setLegendOpen((open) => !open)} aria-label="Toggle map key" title="Map key">▦</button>
        </div>

        {navigationOpen && (
          <aside className="navigation-panel" aria-label="Route navigation">
            <div className="navigation-heading">
              <span>NAVIGATION</span>
              <button onClick={() => setNavigationVisible(false)} aria-label="Close navigation">×</button>
            </div>
            <div className="navigation-locations">
              <div>
                <span className="location-symbol start" aria-hidden="true" />
                <span><small>START</small><strong>{gpsMode === "tracking" ? "Live GPS position" : "Your position / map center"}</strong></span>
              </div>
              <div>
                <span className="location-symbol finish" aria-hidden="true" />
                <span><small>DESTINATION</small><strong>{navigationDestination?.title ?? "Search above or click the map"}</strong></span>
              </div>
            </div>

            {!navigationDestination && (
              <p className="navigation-hint">Choose a destination with the search bar, or click anywhere on the map.</p>
            )}

            {navigationDestination && !routeActive && (
              <button className="route-action" onClick={startNavigation} disabled={routing}>
                {routing ? "CHARTING ROUTE…" : "START ROUTE"}
              </button>
            )}

            {routeError && <p className="route-error">{routeError}</p>}

            {routeSummary && (
              <>
                <div className="route-summary">
                  <strong>{formatRouteDuration(routeSummary.duration)}</strong>
                  <span>{formatRouteDistance(routeSummary.distance)}</span>
                  <small>FROM {routeSummary.origin.toUpperCase()}</small>
                </div>
                <ol className="route-steps">
                  {routeSteps.map((step, index) => (
                    <li key={`${step.maneuver.location.join(",")}-${index}`}>
                      <span className="step-arrow" aria-hidden="true">{step.maneuver.type === "arrive" ? "◆" : "➤"}</span>
                      <span><strong>{routeInstruction(step)}</strong><small>{formatRouteDistance(step.distance)}</small></span>
                    </li>
                  ))}
                </ol>
                <button className="route-action end" onClick={endNavigation}>END NAVIGATION</button>
              </>
            )}
            <div className="route-credit">Routing by OSRM · Map data © OpenStreetMap</div>
          </aside>
        )}

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
