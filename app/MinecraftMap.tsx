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
  name?: string;
  address?: Partial<
    Record<
      | "house_number"
      | "road"
      | "pedestrian"
      | "footway"
      | "path"
      | "neighbourhood"
      | "quarter"
      | "suburb"
      | "borough"
      | "city_district"
      | "city"
      | "town"
      | "village"
      | "county"
      | "state"
      | "country",
      string
    >
  >;
};

type PlaceLookupResponse = {
  title?: string;
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

type MinecraftViewCache = {
  canvas: HTMLCanvasElement | null;
  origin: [number, number];
  axisX: [number, number];
  axisY: [number, number];
  zoom: number;
  bearing: number;
  paddingCells: number;
  renderedAt: number;
};

type NavigationDestination = {
  title: string;
  center: [number, number];
};

type RouteStep = {
  distance: number;
  duration: number;
  geometry?: { coordinates: Array<[number, number]>; type: "LineString" };
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

type NavigationStatus = "preview" | "navigating" | "rerouting" | "arrived";

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

function exploredPlaceDetailZoom(zoom: number) {
  if (zoom < 4) return 3;
  if (zoom < 6) return 5;
  if (zoom < 9) return 8;
  if (zoom < 11) return 10;
  if (zoom < 13) return 12;
  if (zoom < 14) return 13;
  if (zoom < 15) return 14;
  return 15;
}

function searchResultLabels(result: SearchResult) {
  const parts = result.display_name.split(",").map((part) => part.trim()).filter(Boolean);
  const address = result.address ?? {};
  const houseNumber = address.house_number?.trim();
  const road = (address.road ?? address.pedestrian ?? address.footway ?? address.path)?.trim();
  const streetAddress = houseNumber && road ? `${houseNumber} ${road}` : undefined;
  const resultName = result.name?.trim();
  const namedPlace =
    resultName && resultName !== houseNumber && !/^\d+[A-Za-z]?(?:[-–/]\d+[A-Za-z]?)?$/.test(resultName)
      ? resultName
      : undefined;

  let consumedParts = 1;
  let primary = namedPlace ?? streetAddress;
  if (!primary && /^\d+[A-Za-z]?(?:[-–/]\d+[A-Za-z]?)?$/.test(parts[0] ?? "") && parts[1]) {
    primary = `${parts[0]} ${parts[1]}`;
    consumedParts = 2;
  }
  primary ??= parts[0] ?? "Unnamed place";

  const locality =
    address.neighbourhood ??
    address.quarter ??
    address.suburb ??
    address.borough ??
    address.city_district;
  const settlement = address.city ?? address.town ?? address.village;
  const semanticDetails = [
    namedPlace ? streetAddress : undefined,
    locality,
    settlement,
    address.county,
    address.state,
    address.state ? undefined : address.country,
  ]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part) && part !== primary)
    .filter((part, index, values) => values.indexOf(part) === index);
  const secondary = semanticDetails.length > 0
    ? semanticDetails.join(", ")
    : parts.slice(consumedParts).join(", ");

  return { primary, secondary };
}

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
  projectPosition: (lng: number, lat: number) => { x: number; y: number },
  kind: "fill" | "line",
) {
  const project = (position: unknown) => {
    if (!Array.isArray(position) || position.length < 2) return null;
    const lng = Number(position[0]);
    const lat = Number(position[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    return projectPosition(lng, lat);
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

function minecraftWorldGrid(map: MapLibreMap) {
  const cellSize = minecraftCellSize();
  const zoom = map.getZoom();
  const worldSize = 512 * 2 ** zoom;
  const worldCellScale = worldSize / cellSize;
  const source = map.getCanvas();
  const centerMercatorX = maplibregl.MercatorCoordinate.fromLngLat(map.getCenter()).x;
  const unwrapX = (value: number) => {
    let unwrapped = value;
    while (unwrapped - centerMercatorX > 0.5) unwrapped -= 1;
    while (unwrapped - centerMercatorX < -0.5) unwrapped += 1;
    return unwrapped;
  };
  const corners = [
    [0, 0],
    [source.clientWidth, 0],
    [source.clientWidth, source.clientHeight],
    [0, source.clientHeight],
  ].map(([x, y]) => {
    const coordinate = maplibregl.MercatorCoordinate.fromLngLat(map.unproject([x, y]));
    return { x: unwrapX(coordinate.x) * worldCellScale, y: coordinate.y * worldCellScale };
  });
  const originCellX = Math.floor(Math.min(...corners.map((corner) => corner.x))) - 1;
  const originCellY = Math.floor(Math.min(...corners.map((corner) => corner.y))) - 1;
  const maximumCellX = Math.ceil(Math.max(...corners.map((corner) => corner.x))) + 1;
  const maximumCellY = Math.ceil(Math.max(...corners.map((corner) => corner.y))) + 1;
  const origin = new maplibregl.MercatorCoordinate(
    originCellX / worldCellScale,
    originCellY / worldCellScale,
  ).toLngLat();
  const axisX = new maplibregl.MercatorCoordinate(
    (originCellX + 1) / worldCellScale,
    originCellY / worldCellScale,
  ).toLngLat();
  const axisY = new maplibregl.MercatorCoordinate(
    originCellX / worldCellScale,
    (originCellY + 1) / worldCellScale,
  ).toLngLat();
  return {
    origin: [origin.lng, origin.lat] as [number, number],
    axisX: [axisX.lng, axisX.lat] as [number, number],
    axisY: [axisY.lng, axisY.lat] as [number, number],
    originCellX,
    originCellY,
    width: Math.max(1, maximumCellX - originCellX),
    height: Math.max(1, maximumCellY - originCellY),
    worldCellScale,
    centerMercatorX,
  };
}

function mapViewportOverscan(map: MapLibreMap) {
  const frameWidth = map.getContainer().parentElement?.clientWidth ?? map.getCanvas().clientWidth;
  return Math.max(0, Math.round((map.getCanvas().clientWidth - frameWidth) / 2));
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
  viewCache: MinecraftViewCache,
  onTerrainReady: () => void,
) {
  const source = map.getCanvas();
  if (source.clientWidth === 0 || source.clientHeight === 0) return;

  const cellSize = minecraftCellSize();
  const grid = minecraftWorldGrid(map);
  const width = grid.width;
  const height = grid.height;
  const paddingCells = Math.max(
    0,
    Math.floor((source.clientWidth - target.clientWidth) / (cellSize * 2)),
  );
  const renderTarget = document.createElement("canvas");
  renderTarget.width = width;
  renderTarget.height = height;

  const context = renderTarget.getContext("2d", { willReadFrequently: true });
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
  const projectToGrid = (lng: number, lat: number) => {
    const coordinate = maplibregl.MercatorCoordinate.fromLngLat([lng, lat]);
    let mercatorX = coordinate.x;
    while (mercatorX - grid.centerMercatorX > 0.5) mercatorX -= 1;
    while (mercatorX - grid.centerMercatorX < -0.5) mercatorX += 1;
    return {
      x: mercatorX * grid.worldCellScale - grid.originCellX,
      y: coordinate.y * grid.worldCellScale - grid.originCellY,
    };
  };
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
      drawGeometry(context, feature.geometry as MapGeometry, projectToGrid, kind);
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
      const worldX = grid.originCellX + x;
      const worldY = grid.originCellY + y;
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
  const terrainKey = `${map.getZoom().toFixed(3)}/${grid.originCellX}/${grid.originCellY}/${width}/${height}`;
  if (terrainCache.key === terrainKey && terrainCache.values?.length === elevations.length) {
    elevations.set(terrainCache.values);
  } else {
    // DEM lookups are sampled only when the semantic cache refreshes, never
    // on every animation frame. This preserves terrain shading during GPS
    // movement while keeping camera motion responsive.
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
        const location = new maplibregl.MercatorCoordinate(
          (grid.originCellX + x + 0.5) / grid.worldCellScale,
          (grid.originCellY + y + 0.5) / grid.worldCellScale,
        ).toLngLat();
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
      const worldX = grid.originCellX + x;
      const worldY = grid.originCellY + y;
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
  viewCache.canvas = renderTarget;
  viewCache.origin = grid.origin;
  viewCache.axisX = grid.axisX;
  viewCache.axisY = grid.axisY;
  viewCache.zoom = map.getZoom();
  viewCache.bearing = map.getBearing();
  viewCache.paddingCells = paddingCells;
  viewCache.renderedAt = performance.now();
  renderCachedMinecraftPreview(map, target, viewCache);
  target.hidden = false;
}

function renderMovingPreview(map: MapLibreMap, target: HTMLCanvasElement) {
  const source = map.getCanvas();
  if (source.clientWidth === 0 || source.clientHeight === 0) return;

  const cellSize = minecraftCellSize();
  const viewportWidth = target.clientWidth || source.clientWidth;
  const viewportHeight = target.clientHeight || source.clientHeight;
  const width = Math.max(1, Math.ceil(viewportWidth / cellSize));
  const height = Math.max(1, Math.ceil(viewportHeight / cellSize));
  if (target.width !== width) target.width = width;
  if (target.height !== height) target.height = height;

  const context = target.getContext("2d");
  if (!context) return;
  context.imageSmoothingEnabled = false;
  context.clearRect(0, 0, width, height);
  const sourceScaleX = source.width / source.clientWidth;
  const sourceScaleY = source.height / source.clientHeight;
  const cropX = Math.max(0, (source.clientWidth - viewportWidth) / 2) * sourceScaleX;
  const cropY = Math.max(0, (source.clientHeight - viewportHeight) / 2) * sourceScaleY;
  context.drawImage(
    source,
    cropX,
    cropY,
    viewportWidth * sourceScaleX,
    viewportHeight * sourceScaleY,
    0,
    0,
    width,
    height,
  );
  target.hidden = false;
}

function renderCachedMinecraftPreview(
  map: MapLibreMap,
  target: HTMLCanvasElement,
  cache: MinecraftViewCache,
) {
  // Keep a cheap source preview underneath only for newly exposed edge cells.
  // The opaque semantic cache covers the full viewport during ordinary travel.
  renderMovingPreview(map, target);
  if (!cache.canvas) return;

  const context = target.getContext("2d");
  if (!context) return;
  const cellSize = minecraftCellSize();
  const source = map.getCanvas();
  const viewportOffsetX = Math.max(0, (source.clientWidth - target.clientWidth) / 2);
  const viewportOffsetY = Math.max(0, (source.clientHeight - target.clientHeight) / 2);
  const cacheOrigin = map.project(cache.origin);
  const cacheAxisX = map.project(cache.axisX);
  const cacheAxisY = map.project(cache.axisY);
  const transform = {
    a: (cacheAxisX.x - cacheOrigin.x) / cellSize,
    b: (cacheAxisX.y - cacheOrigin.y) / cellSize,
    c: (cacheAxisY.x - cacheOrigin.x) / cellSize,
    d: (cacheAxisY.y - cacheOrigin.y) / cellSize,
    e: (cacheOrigin.x - viewportOffsetX) / cellSize,
    f: (cacheOrigin.y - viewportOffsetY) / cellSize,
  };
  context.imageSmoothingEnabled = false;
  context.save();
  context.setTransform(
    transform.a,
    transform.b,
    transform.c,
    transform.d,
    transform.e,
    transform.f,
  );
  context.drawImage(cache.canvas, 0, 0);
  context.restore();
  target.hidden = false;
}

function minecraftCacheNeedsRefresh(
  map: MapLibreMap,
  target: HTMLCanvasElement,
  cache: MinecraftViewCache,
) {
  if (!cache.canvas) return true;
  const cellSize = minecraftCellSize();
  const source = map.getCanvas();
  const viewportWidth = Math.max(1, Math.ceil(target.clientWidth / cellSize));
  const viewportHeight = Math.max(1, Math.ceil(target.clientHeight / cellSize));
  const viewportOffsetX = Math.max(0, (source.clientWidth - target.clientWidth) / 2);
  const viewportOffsetY = Math.max(0, (source.clientHeight - target.clientHeight) / 2);
  if (Math.abs(map.getZoom() - cache.zoom) > 0.25) return true;
  const bearingDelta = Math.abs((((map.getBearing() - cache.bearing + 540) % 360) - 180));
  if (bearingDelta > 12) return true;

  const cacheOrigin = map.project(cache.origin);
  const cacheAxisX = map.project(cache.axisX);
  const cacheAxisY = map.project(cache.axisY);
  const a = (cacheAxisX.x - cacheOrigin.x) / cellSize;
  const b = (cacheAxisX.y - cacheOrigin.y) / cellSize;
  const c = (cacheAxisY.x - cacheOrigin.x) / cellSize;
  const d = (cacheAxisY.y - cacheOrigin.y) / cellSize;
  const e = (cacheOrigin.x - viewportOffsetX) / cellSize;
  const f = (cacheOrigin.y - viewportOffsetY) / cellSize;
  const determinant = a * d - b * c;
  if (Math.abs(determinant) < 0.0001) return true;
  const viewportCorners = [
    [0, 0],
    [viewportWidth, 0],
    [viewportWidth, viewportHeight],
    [0, viewportHeight],
  ];
  const scale = 2 ** (map.getZoom() - cache.zoom);
  const minimumBuffer = Math.max(4, cache.paddingCells * 0.35 / Math.max(0.25, scale));
  if (map.isMoving() && performance.now() - cache.renderedAt > 900) return true;
  return viewportCorners.some(([x, y]) => {
    const offsetX = x - e;
    const offsetY = y - f;
    const cacheX = (d * offsetX - c * offsetY) / determinant;
    const cacheY = (-b * offsetX + a * offsetY) / determinant;
    return (
      cacheX < minimumBuffer ||
      cacheY < minimumBuffer ||
      cacheX > cache.canvas!.width - minimumBuffer ||
      cacheY > cache.canvas!.height - minimumBuffer
    );
  });
}

function renderNavigationRoute(
  map: MapLibreMap,
  target: HTMLCanvasElement,
  coordinates: Array<[number, number]>,
) {
  const source = map.getCanvas();
  const cellSize = minecraftCellSize();
  const viewportWidth = target.clientWidth || source.clientWidth;
  const viewportHeight = target.clientHeight || source.clientHeight;
  const viewportOffsetX = Math.max(0, (source.clientWidth - viewportWidth) / 2);
  const viewportOffsetY = Math.max(0, (source.clientHeight - viewportHeight) / 2);
  const width = Math.max(1, Math.ceil(viewportWidth / cellSize));
  const height = Math.max(1, Math.ceil(viewportHeight / cellSize));
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
    const x = (point.x - viewportOffsetX) / cellSize;
    const y = (point.y - viewportOffsetY) / cellSize;
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
  if (meters <= 0) return "0 ft";
  const miles = meters / 1609.344;
  if (miles >= 0.2) return `${miles < 10 ? miles.toFixed(1) : Math.round(miles)} mi`;
  return `${Math.max(50, Math.round((meters * 3.28084) / 50) * 50)} ft`;
}

function formatRouteDuration(seconds: number) {
  if (seconds <= 0) return "0 min";
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

function distanceMeters(from: [number, number], to: [number, number]) {
  const earthRadius = 6371008.8;
  const latitude1 = from[1] * (Math.PI / 180);
  const latitude2 = to[1] * (Math.PI / 180);
  const latitudeDelta = (to[1] - from[1]) * (Math.PI / 180);
  const longitudeDelta = (to[0] - from[0]) * (Math.PI / 180);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(longitudeDelta / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function normalizeBearing(bearing: number) {
  return ((bearing % 360) + 360) % 360;
}

function bearingBetween(from: [number, number], to: [number, number]) {
  const latitude1 = from[1] * (Math.PI / 180);
  const latitude2 = to[1] * (Math.PI / 180);
  const longitudeDelta = (to[0] - from[0]) * (Math.PI / 180);
  const y = Math.sin(longitudeDelta) * Math.cos(latitude2);
  const x =
    Math.cos(latitude1) * Math.sin(latitude2) -
    Math.sin(latitude1) * Math.cos(latitude2) * Math.cos(longitudeDelta);
  return normalizeBearing(Math.atan2(y, x) * (180 / Math.PI));
}

function routeBearingAt(coordinates: Array<[number, number]>, index: number) {
  if (coordinates.length < 2) return null;
  const startIndex = Math.min(Math.max(0, index), coordinates.length - 2);
  const start = coordinates[startIndex];
  const searchEnd = Math.min(coordinates.length - 1, startIndex + 20);
  for (let nextIndex = startIndex + 1; nextIndex <= searchEnd; nextIndex += 1) {
    if (distanceMeters(start, coordinates[nextIndex]) >= 12) {
      return bearingBetween(start, coordinates[nextIndex]);
    }
  }
  return bearingBetween(start, coordinates[startIndex + 1]);
}

function smoothNavigationBearing(previous: number | null, next: number) {
  const normalized = normalizeBearing(next);
  if (previous == null) return normalized;
  const difference = ((normalized - previous + 540) % 360) - 180;
  if (Math.abs(difference) < 1) return normalizeBearing(previous);
  const response = Math.abs(difference) > 75 ? 0.65 : 0.42;
  return normalizeBearing(previous + difference * response);
}

function cumulativeRouteDistances(coordinates: Array<[number, number]>) {
  const distances = new Float64Array(coordinates.length);
  for (let index = 1; index < coordinates.length; index += 1) {
    distances[index] = distances[index - 1] + distanceMeters(coordinates[index - 1], coordinates[index]);
  }
  return distances;
}

function closestRoutePoint(
  location: [number, number],
  coordinates: Array<[number, number]>,
  previousIndex: number,
) {
  if (coordinates.length === 0) return { index: 0, distance: Number.POSITIVE_INFINITY };

  const findClosest = (start: number, end: number) => {
    let closestIndex = start;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (let index = start; index <= end; index += 1) {
      const distance = distanceMeters(location, coordinates[index]);
      if (distance < closestDistance) {
        closestIndex = index;
        closestDistance = distance;
      }
    }
    return { index: closestIndex, distance: closestDistance };
  };

  const windowStart = Math.max(0, previousIndex - 80);
  const windowEnd = Math.min(coordinates.length - 1, previousIndex + 500);
  const nearby = findClosest(windowStart, windowEnd);
  return nearby.distance <= 140 ? nearby : findClosest(0, coordinates.length - 1);
}

function speakNavigation(text: string) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 0.98;
  utterance.pitch = 0.92;
  window.speechSynthesis.speak(utterance);
}

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
  const navigationDestinationRef = useRef<NavigationDestination | null>(null);
  const selectedPointRef = useRef<NavigationDestination | null>(null);
  const routeCoordinatesRef = useRef<Array<[number, number]>>([]);
  const routeDistancesRef = useRef(new Float64Array());
  const routeStepsRef = useRef<RouteStep[]>([]);
  const routeStepStartsRef = useRef<number[]>([]);
  const routeDistanceRef = useRef(0);
  const routeDurationRef = useRef(0);
  const routeProgressIndexRef = useRef(0);
  const routeTrackingRef = useRef(false);
  const navigationBearingRef = useRef<number | null>(null);
  const activeStepIndexRef = useRef(0);
  const offRouteFixesRef = useRef(0);
  const rerouteCooldownFixesRef = useRef(0);
  const routingRef = useRef(false);
  const voiceEnabledRef = useRef(false);
  const lastSpokenCueRef = useRef("");
  const navigationPositionHandlerRef = useRef<
    (location: [number, number], coords: GeolocationCoordinates) => void
  >(() => undefined);
  const rerouteFromRef = useRef<(location: [number, number]) => void>(() => undefined);
  const locateMeRef = useRef<() => void>(() => undefined);
  const brandMenuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [zoom, setZoom] = useState(10);
  const [coordinates, setCoordinates] = useState({ lng: -74.006, lat: 40.7128 });
  const [place, setPlace] = useState({ title: "New York", detail: "Real terrain · block by block" });
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [message, setMessage] = useState("");
  const [appMenuOpen, setAppMenuOpen] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);
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
  const [navigationStatus, setNavigationStatus] = useState<NavigationStatus>("preview");
  const [activeStepIndex, setActiveStepIndex] = useState(0);
  const [distanceToStep, setDistanceToStep] = useState<number | null>(null);
  const [voiceEnabled, setVoiceEnabled] = useState(false);

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
    const collapseAttribution = () => {
      const attribution = mapNode.current?.querySelector<HTMLDetailsElement>(".maplibregl-ctrl-attrib");
      if (!attribution) return;
      attribution.open = false;
      attribution.classList.remove("maplibregl-compact-show");
    };
    collapseAttribution();
    let pixelFrame: number | null = null;
    let previewFrame: number | null = null;
    let pixelTimer: number | null = null;
    let movingDetailTimer: number | null = null;
    let lastMovingDetailAt = 0;
    let placeLookupTimer: number | null = null;
    let placeLookupController: AbortController | null = null;
    let lastPlaceLookupAt = 0;
    const placeCache = new Map<string, string>();
    const terrainCache: TerrainShadeCache = { key: "", values: null };
    const terrainTiles: TerrainTileCache = new Map();
    const viewCache: MinecraftViewCache = {
      canvas: null,
      origin: [0, 0],
      axisX: [0, 0],
      axisY: [0, 0],
      zoom: 10,
      bearing: 0,
      paddingCells: 0,
      renderedAt: 0,
    };
    const centerLookup = () => {
      const center = map.getCenter();
      const lng = ((center.lng + 180) % 360 + 360) % 360 - 180;
      const lat = Math.max(-85.051, Math.min(85.051, center.lat));
      const detailZoom = exploredPlaceDetailZoom(map.getZoom());
      return {
        key: `${detailZoom}/${lat.toFixed(3)},${lng.toFixed(3)}`,
        lat: lat.toFixed(3),
        lng: lng.toFixed(3),
        zoom: String(detailZoom),
      };
    };
    const updateExploredPlace = (delay = 700) => {
      if (placeLookupTimer !== null) window.clearTimeout(placeLookupTimer);
      placeLookupTimer = null;
      placeLookupController?.abort();
      placeLookupController = null;

      const lookup = centerLookup();
      const cached = placeCache.get(lookup.key);
      if (cached) {
        setPlace((current) => ({ ...current, title: cached }));
        return;
      }

      placeLookupTimer = window.setTimeout(async () => {
        placeLookupTimer = null;
        const rateLimitDelay = Math.max(0, 1050 - (performance.now() - lastPlaceLookupAt));
        if (rateLimitDelay > 0) {
          updateExploredPlace(rateLimitDelay);
          return;
        }

        const controller = new AbortController();
        placeLookupController = controller;
        lastPlaceLookupAt = performance.now();
        try {
          const params = new URLSearchParams({
            lat: lookup.lat,
            lon: lookup.lng,
            zoom: lookup.zoom,
            v: "3",
          });
          const response = await fetch(`/api/place?${params}`, { signal: controller.signal });
          if (!response.ok) return;
          const result = (await response.json()) as PlaceLookupResponse;
          const title = result.title?.trim();
          if (!title) return;
          placeCache.set(lookup.key, title);
          if (centerLookup().key === lookup.key) {
            setPlace((current) => ({ ...current, title }));
          }
        } catch {
          // Keep the last useful place name if reverse geocoding is unavailable.
        } finally {
          if (placeLookupController === controller) placeLookupController = null;
        }
      }, delay);
    };
    mapNode.current.classList.add("map-moving");
    const renderSemanticFrame = () => {
      if (pixelFrame !== null) return;
      pixelFrame = window.requestAnimationFrame(() => {
        pixelFrame = null;
        const target = pixelCanvasRef.current;
        if (!target) return;
        try {
          renderMinecraftCells(map, target, terrainCache, terrainTiles, viewCache, () => renderPixels(100));
          const routeTarget = routeCanvasRef.current;
          if (routeTarget) renderNavigationRoute(map, routeTarget, routeCoordinatesRef.current);
          mapNode.current?.classList.remove("map-moving");
        } catch {
          renderCachedMinecraftPreview(map, target, viewCache);
          const routeTarget = routeCanvasRef.current;
          if (routeTarget) renderNavigationRoute(map, routeTarget, routeCoordinatesRef.current);
          mapNode.current?.classList.remove("map-moving");
        }
      });
    };
    const renderPixels = (delay = 80) => {
      if (pixelTimer !== null) window.clearTimeout(pixelTimer);
      pixelTimer = window.setTimeout(() => {
        pixelTimer = null;
        if (map.isMoving() || pixelFrame !== null) return;
        renderSemanticFrame();
      }, delay);
    };
    const renderMovingDetail = () => {
      if (movingDetailTimer !== null || pixelFrame !== null) return;
      const delay = Math.max(40, 280 - (performance.now() - lastMovingDetailAt));
      movingDetailTimer = window.setTimeout(() => {
        movingDetailTimer = null;
        if (!map.isMoving() || pixelFrame !== null) return;
        lastMovingDetailAt = performance.now();
        renderSemanticFrame();
      }, delay);
    };
    const renderPreview = () => {
      if (previewFrame !== null) return;
      previewFrame = window.requestAnimationFrame(() => {
        previewFrame = null;
        const target = pixelCanvasRef.current;
        if (target) {
          renderCachedMinecraftPreview(map, target, viewCache);
          if (minecraftCacheNeedsRefresh(map, target, viewCache)) renderMovingDetail();
        }
        const routeTarget = routeCanvasRef.current;
        if (routeTarget) renderNavigationRoute(map, routeTarget, routeCoordinatesRef.current);
      });
    };
    const loadingTimeout = window.setTimeout(() => setReady(true), 10000);
    map.on("load", () => {
      window.clearTimeout(loadingTimeout);
      collapseAttribution();
      const center = map.getCenter();
      setCoordinates({ lng: center.lng, lat: center.lat });
      setZoom(Math.round(map.getZoom()));
      setReady(true);
      renderPixels(0);
      updateExploredPlace(0);
      if (!hasSharedView && locationWatchRef.current === null) locateMeRef.current();
    });
    map.on("idle", () => renderPixels(0));
    map.on("movestart", () => {
      mapNode.current?.classList.add("map-moving");
      if (placeLookupTimer !== null) window.clearTimeout(placeLookupTimer);
      placeLookupTimer = null;
      placeLookupController?.abort();
      placeLookupController = null;
      if (pixelTimer !== null) window.clearTimeout(pixelTimer);
      pixelTimer = null;
      if (movingDetailTimer !== null) window.clearTimeout(movingDetailTimer);
      movingDetailTimer = null;
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
      updateExploredPlace();
    });
    map.on("click", (event) => {
      if (navigationOpenRef.current) {
        markerRef.current?.remove();
        markerRef.current = null;
        selectedPointRef.current = null;
        destinationMarkerRef.current?.remove();
        const destinationNode = document.createElement("div");
        destinationNode.className = "pixel-marker route-destination-marker";
        destinationMarkerRef.current = new maplibregl.Marker({ element: destinationNode, anchor: "bottom" })
          .setLngLat(event.lngLat)
          .addTo(map);
        const destination = {
          title: "Dropped destination",
          center: [event.lngLat.lng, event.lngLat.lat] as [number, number],
        };
        navigationDestinationRef.current = destination;
        setNavigationDestination(destination);
        routeCoordinatesRef.current = [];
        routeTrackingRef.current = false;
        navigationBearingRef.current = null;
        map.easeTo({ bearing: 0, duration: 450, essential: true });
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
      selectedPointRef.current = {
        title: "Dropped pin",
        center: [event.lngLat.lng, event.lngLat.lat],
      };
    });
    mapRef.current = map;

    return () => {
      window.clearTimeout(loadingTimeout);
      if (pixelTimer !== null) window.clearTimeout(pixelTimer);
      if (movingDetailTimer !== null) window.clearTimeout(movingDetailTimer);
      if (placeLookupTimer !== null) window.clearTimeout(placeLookupTimer);
      placeLookupController?.abort();
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
        setAppMenuOpen(false);
        setResults([]);
        searchRef.current?.blur();
      }
    };
    const closeAppMenu = (event: PointerEvent) => {
      if (!brandMenuRef.current?.contains(event.target as Node)) setAppMenuOpen(false);
    };
    window.addEventListener("keydown", handleShortcut);
    document.addEventListener("pointerdown", closeAppMenu);
    return () => {
      window.removeEventListener("keydown", handleShortcut);
      document.removeEventListener("pointerdown", closeAppMenu);
    };
  }, []);

  const setNavigationVisible = (open: boolean) => {
    const wasOpen = navigationOpenRef.current;
    navigationOpenRef.current = open;
    setNavigationOpen(open);
    if (open) {
      let adoptedSelectedPoint = false;
      if (!wasOpen && mapRef.current) {
        const center = mapRef.current.getCenter();
        navigationOriginRef.current = [center.lng, center.lat];
        const selectedPoint = selectedPointRef.current;
        if (selectedPoint && routeCoordinatesRef.current.length === 0) {
          markerRef.current?.remove();
          markerRef.current = null;
          destinationMarkerRef.current?.remove();
          const destinationNode = document.createElement("div");
          destinationNode.className = "pixel-marker route-destination-marker";
          destinationMarkerRef.current = new maplibregl.Marker({ element: destinationNode, anchor: "bottom" })
            .setLngLat(selectedPoint.center)
            .addTo(mapRef.current);
          navigationDestinationRef.current = selectedPoint;
          setNavigationDestination(selectedPoint);
          selectedPointRef.current = null;
          adoptedSelectedPoint = true;
        }
      }
      setLegendOpen(false);
      setMessage(
        adoptedSelectedPoint
          ? "Dropped pin selected as your destination. Select START ROUTE when ready."
          : navigationDestinationRef.current
            ? "Destination ready. Select START ROUTE when ready."
            : "Search above or click the map to choose a destination.",
      );
      window.setTimeout(() => searchRef.current?.focus(), 0);
    }
  };

  const resetRoute = (removeDestination = false) => {
    routeCoordinatesRef.current = [];
    routeDistancesRef.current = new Float64Array();
    routeStepsRef.current = [];
    routeStepStartsRef.current = [];
    routeDistanceRef.current = 0;
    routeDurationRef.current = 0;
    routeProgressIndexRef.current = 0;
    routeTrackingRef.current = false;
    navigationBearingRef.current = null;
    activeStepIndexRef.current = 0;
    offRouteFixesRef.current = 0;
    lastSpokenCueRef.current = "";
    setRouteSummary(null);
    setRouteSteps([]);
    setRouteActive(false);
    setNavigationStatus("preview");
    setActiveStepIndex(0);
    setDistanceToStep(null);
    setRouteError("");
    const map = mapRef.current;
    const target = routeCanvasRef.current;
    if (map && target) renderNavigationRoute(map, target, []);
    if (map && Math.abs(map.getBearing()) > 0.1) {
      map.easeTo({ bearing: 0, duration: 550, essential: true });
    }
    if (removeDestination) {
      destinationMarkerRef.current?.remove();
      destinationMarkerRef.current = null;
      navigationDestinationRef.current = null;
      setNavigationDestination(null);
    }
  };

  const selectNavigationDestination = (title: string, center: [number, number]) => {
    const map = mapRef.current;
    if (!map) return;
    resetRoute(false);
    markerRef.current?.remove();
    markerRef.current = null;
    selectedPointRef.current = null;
    destinationMarkerRef.current?.remove();
    const destinationNode = document.createElement("div");
    destinationNode.className = "pixel-marker route-destination-marker";
    destinationMarkerRef.current = new maplibregl.Marker({ element: destinationNode, anchor: "bottom" })
      .setLngLat(center)
      .addTo(map);
    const destination = { title, center };
    navigationDestinationRef.current = destination;
    setNavigationDestination(destination);
    setMessage("Destination set. Select START ROUTE when ready.");
  };

  const endNavigation = () => {
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    resetRoute(true);
    setNavigationVisible(false);
    setMessage("Navigation ended.");
  };

  const searchWorld = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const term = query.trim();
    if (!term || searching) return;
    setSearching(true);
    setMessage("");
    try {
      const params = new URLSearchParams({
        q: term,
        format: "jsonv2",
        limit: "5",
        addressdetails: "1",
      });
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
    const labels = searchResultLabels(result);
    const resultCenter: [number, number] = [Number(result.lon), Number(result.lat)];
    if (navigationOpenRef.current) {
      selectNavigationDestination(labels.primary, resultCenter);
      const map = mapRef.current;
      if (map) {
        map.fitBounds([[west, south], [east, north]], {
          padding: 90 + mapViewportOverscan(map),
          maxZoom: 15,
          duration: 900,
        });
      }
      setQuery(result.display_name);
      setResults([]);
      return;
    }
    setLocationFollowing(false);
    const map = mapRef.current;
    if (map) {
      map.fitBounds([[west, south], [east, north]], {
        padding: 90 + mapViewportOverscan(map),
        maxZoom: 14,
        duration: 1300,
      });
    }
    markerRef.current?.remove();
    const markerNode = document.createElement("div");
    markerNode.className = "pixel-marker";
    markerRef.current = new maplibregl.Marker({ element: markerNode, anchor: "bottom" })
      .setLngLat(resultCenter)
      .addTo(mapRef.current!);
    selectedPointRef.current = { title: labels.primary, center: resultCenter };
    setPlace({ title: labels.primary, detail: labels.secondary || result.type });
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
    navigationBearingRef.current = null;
    if (mapRef.current && Math.abs(mapRef.current.getBearing()) > 0.1) {
      mapRef.current.easeTo({ bearing: 0, duration: 550, essential: true });
    }
    setLocationFollowing(false);
    setGpsMode("idle");
    setPlace((current) => ({ ...current, detail: "GPS stopped · last known position" }));
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

        const wasNavigating = routeTrackingRef.current;
        const arrow = userMarkerRef.current.getElement().querySelector<HTMLElement>(".player-marker-arrow");
        if (!wasNavigating && arrow && coords.heading != null && Number.isFinite(coords.heading)) {
          arrow.style.setProperty("--player-heading", `${coords.heading}deg`);
        }

        if (followingLocationRef.current && !wasNavigating) {
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
        setPlace((current) => ({
          ...current,
          detail: `GPS live · accurate to ±${Math.round(coords.accuracy)} m`,
        }));
        navigationPositionHandlerRef.current(location, coords);
        if (!wasNavigating) setMessage("");
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
  useEffect(() => {
    locateMeRef.current = locateMe;
  });

  const refreshApp = () => {
    window.location.reload();
  };

  const startOver = () => {
    const cleanUrl = `${window.location.origin}${window.location.pathname}${window.location.search}`;
    window.location.replace(cleanUrl);
  };

  const calculateNavigationRoute = async (originOverride?: [number, number], rerouting = false) => {
    const map = mapRef.current;
    const destination = navigationDestinationRef.current;
    if (!map || !destination || routingRef.current) return;
    routingRef.current = true;
    setRouting(true);
    setRouteError("");
    setNavigationStatus(rerouting ? "rerouting" : "preview");
    setMessage(rerouting ? "Off route · charting a new path…" : "Charting the fastest route…");

    let origin: [number, number];
    let originLabel: RouteSummary["origin"] = "map center";
    const liveMarker = userMarkerRef.current;
    if (originOverride) {
      origin = originOverride;
      originLabel = "GPS location";
    } else if (liveMarker) {
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
        if (locationWatchRef.current === null) locateMe();
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
        to: `${destination.center[0]},${destination.center[1]}`,
      });
      const response = await fetch(`/api/route?${params}`);
      const result = (await response.json()) as OsrmRouteResponse;
      const route = result.routes?.[0];
      if (!response.ok || result.code !== "Ok" || !route) {
        throw new Error(result.message || "No route found");
      }

      const steps = route.legs.flatMap((leg) => leg.steps);
      const stepStarts: number[] = [];
      let stepDistance = 0;
      for (const step of steps) {
        stepStarts.push(stepDistance);
        stepDistance += step.distance;
      }

      routeCoordinatesRef.current = route.geometry.coordinates;
      routeDistancesRef.current = cumulativeRouteDistances(route.geometry.coordinates);
      routeStepsRef.current = steps;
      routeStepStartsRef.current = stepStarts;
      routeDistanceRef.current = route.distance;
      routeDurationRef.current = route.duration;
      routeProgressIndexRef.current = 0;
      routeTrackingRef.current = originLabel === "GPS location";
      rerouteCooldownFixesRef.current = rerouting ? 20 : 10;
      activeStepIndexRef.current = steps.length > 1 ? 1 : 0;
      offRouteFixesRef.current = 0;
      lastSpokenCueRef.current = "";
      setRouteSummary({ distance: route.distance, duration: route.duration, origin: originLabel });
      setRouteSteps(steps);
      setActiveStepIndex(activeStepIndexRef.current);
      setDistanceToStep(stepStarts[activeStepIndexRef.current] ?? route.distance);
      setRouteActive(true);
      setNavigationStatus(originLabel === "GPS location" ? "navigating" : "preview");
      const routeTarget = routeCanvasRef.current;
      if (routeTarget) renderNavigationRoute(map, routeTarget, route.geometry.coordinates);

      if (originLabel === "GPS location") {
        const routeBearing = routeBearingAt(route.geometry.coordinates, 0) ??
          steps[0]?.maneuver.bearing_after ?? 0;
        navigationBearingRef.current = smoothNavigationBearing(
          rerouting ? navigationBearingRef.current : null,
          routeBearing,
        );
        setLocationFollowing(true);
        map.easeTo({
          center: origin,
          zoom: Math.max(16, map.getZoom()),
          bearing: navigationBearingRef.current,
          duration: rerouting ? 350 : 800,
          essential: true,
        });
      } else {
        navigationBearingRef.current = null;
        if (Math.abs(map.getBearing()) > 0.1) map.setBearing(0);
        const bounds = route.geometry.coordinates.reduce(
          (current, coordinate) => current.extend(coordinate),
          new maplibregl.LngLatBounds(route.geometry.coordinates[0], route.geometry.coordinates[0]),
        );
        const overscan = mapViewportOverscan(map);
        map.fitBounds(bounds, {
          padding: {
            top: 70 + overscan,
            right: 70 + overscan,
            bottom: 90 + overscan,
            left: (window.innerWidth > 720 ? 360 : 70) + overscan,
          },
          maxZoom: 16,
          duration: 900,
        });
      }
      setPlace((current) => ({
        ...current,
        detail: `${formatRouteDistance(route.distance)} · ${formatRouteDuration(route.duration)}`,
      }));
      setMessage(
        originLabel === "GPS location"
          ? rerouting
            ? "New route found · live guidance resumed."
            : "Live turn-by-turn navigation started."
          : "Route preview starts from the map center · enable GPS for live guidance.",
      );
    } catch (error) {
      setRouteError(error instanceof Error ? error.message : "A route could not be calculated.");
      setNavigationStatus(routeTrackingRef.current ? "navigating" : "preview");
      setMessage(rerouting ? "Could not reroute yet · continuing on the current path." : "Navigation could not chart that route.");
    } finally {
      routingRef.current = false;
      setRouting(false);
    }
  };

  const startNavigation = () => {
    void calculateNavigationRoute();
  };

  const handleNavigationPosition = (location: [number, number], coords: GeolocationCoordinates) => {
    if (!routeTrackingRef.current || routeCoordinatesRef.current.length < 2) return;
    const map = mapRef.current;
    const closest = closestRoutePoint(location, routeCoordinatesRef.current, routeProgressIndexRef.current);
    const routeBearing = routeBearingAt(routeCoordinatesRef.current, closest.index);
    const gpsBearing =
      coords.heading != null &&
      Number.isFinite(coords.heading) &&
      (coords.speed == null || coords.speed >= 1.2)
        ? normalizeBearing(coords.heading)
        : null;
    const desiredBearing = gpsBearing ?? routeBearing ?? navigationBearingRef.current ?? 0;
    const cameraBearing = smoothNavigationBearing(navigationBearingRef.current, desiredBearing);
    navigationBearingRef.current = cameraBearing;
    const arrow = userMarkerRef.current?.getElement().querySelector<HTMLElement>(".player-marker-arrow");
    if (arrow) {
      const relativeBearing = followingLocationRef.current
        ? 0
        : ((desiredBearing - (map?.getBearing() ?? 0) + 540) % 360) - 180;
      arrow.style.setProperty("--player-heading", `${relativeBearing}deg`);
    }
    if (map && followingLocationRef.current) {
      map.easeTo({
        center: location,
        zoom: Math.max(16, map.getZoom()),
        bearing: cameraBearing,
        duration: 500,
        essential: true,
      });
    }
    if (routingRef.current) {
      setNavigationStatus("rerouting");
      return;
    }

    const offRouteThreshold = Math.max(90, Math.min(220, coords.accuracy * 2.5));
    if (closest.distance <= offRouteThreshold) {
      routeProgressIndexRef.current = Math.max(routeProgressIndexRef.current, closest.index);
    }
    const routeDistances = routeDistancesRef.current;
    const geometryDistance = routeDistances[routeDistances.length - 1] || routeDistanceRef.current;
    const progressRatio = Math.min(1, (routeDistances[routeProgressIndexRef.current] ?? 0) / geometryDistance);
    const progressedDistance = routeDistanceRef.current * progressRatio;
    const remainingRatio = Math.max(0, 1 - progressRatio);
    const remainingDistance = routeDistanceRef.current * remainingRatio;
    const remainingDuration = routeDurationRef.current * remainingRatio;
    const destination = navigationDestinationRef.current;
    const destinationDistance = destination ? distanceMeters(location, destination.center) : remainingDistance;
    const arrivalRadius = Math.max(30, Math.min(75, coords.accuracy * 1.25));

    if (destinationDistance <= arrivalRadius) {
      routeTrackingRef.current = false;
      navigationBearingRef.current = null;
      if (map && Math.abs(map.getBearing()) > 0.1) {
        map.easeTo({ bearing: 0, duration: 700, essential: true });
      }
      setNavigationStatus("arrived");
      setRouteSummary((current) => current ? { ...current, distance: 0, duration: 0 } : current);
      const arrivedIndex = Math.max(0, routeStepsRef.current.length - 1);
      activeStepIndexRef.current = arrivedIndex;
      setActiveStepIndex(arrivedIndex);
      setDistanceToStep(0);
      setMessage("You have arrived at your destination.");
      if (voiceEnabledRef.current) speakNavigation("You have arrived at your destination.");
      return;
    }

    setRouteSummary((current) =>
      current ? { ...current, distance: remainingDistance, duration: remainingDuration } : current,
    );

    const stepStarts = routeStepStartsRef.current;
    let nextStepIndex = Math.max(0, routeStepsRef.current.length - 1);
    for (let index = 1; index < stepStarts.length; index += 1) {
      if (stepStarts[index] > progressedDistance + 12) {
        nextStepIndex = index;
        break;
      }
    }
    const maneuverDistance = Math.max(
      0,
      (stepStarts[nextStepIndex] ?? routeDistanceRef.current) - progressedDistance,
    );
    if (nextStepIndex !== activeStepIndexRef.current) {
      activeStepIndexRef.current = nextStepIndex;
      setActiveStepIndex(nextStepIndex);
      lastSpokenCueRef.current = "";
    }
    setDistanceToStep(maneuverDistance);

    offRouteFixesRef.current = closest.distance > offRouteThreshold ? offRouteFixesRef.current + 1 : 0;
    rerouteCooldownFixesRef.current = Math.max(0, rerouteCooldownFixesRef.current - 1);
    if (offRouteFixesRef.current >= 3 && rerouteCooldownFixesRef.current === 0 && !routingRef.current) {
      offRouteFixesRef.current = 0;
      rerouteCooldownFixesRef.current = 20;
      setNavigationStatus("rerouting");
      rerouteFromRef.current(location);
      return;
    }

    setNavigationStatus("navigating");
    if (!voiceEnabledRef.current) return;
    const step = routeStepsRef.current[nextStepIndex];
    if (!step) return;
    const cue = maneuverDistance <= 35 ? "now" : maneuverDistance <= 150 ? "near" : maneuverDistance <= 800 ? "early" : "";
    const cueKey = cue ? `${nextStepIndex}:${cue}` : "";
    if (cueKey && cueKey !== lastSpokenCueRef.current) {
      lastSpokenCueRef.current = cueKey;
      speakNavigation(
        cue === "now"
          ? `${routeInstruction(step)} now.`
          : `In ${formatRouteDistance(maneuverDistance)}, ${routeInstruction(step).toLowerCase()}.`,
      );
    }
  };

  useEffect(() => {
    rerouteFromRef.current = (location) => {
      void calculateNavigationRoute(location, true);
    };
    navigationPositionHandlerRef.current = handleNavigationPosition;
  });

  const recenterNavigation = () => {
    const map = mapRef.current;
    const marker = userMarkerRef.current;
    if (!map || !marker) {
      locateMe();
      return;
    }
    setLocationFollowing(true);
    const routeBearing = routeBearingAt(routeCoordinatesRef.current, routeProgressIndexRef.current);
    const bearing = routeTrackingRef.current
      ? navigationBearingRef.current ?? routeBearing ?? map.getBearing()
      : 0;
    map.easeTo({
      center: marker.getLngLat(),
      zoom: Math.max(16, map.getZoom()),
      bearing,
      duration: 600,
      essential: true,
    });
    setMessage(routeTrackingRef.current ? "Following your direction of travel." : "Following your live GPS position.");
  };

  const toggleNavigationVoice = () => {
    if (!("speechSynthesis" in window)) {
      setRouteError("Spoken directions are not supported by this browser.");
      return;
    }
    const enabled = !voiceEnabledRef.current;
    voiceEnabledRef.current = enabled;
    setVoiceEnabled(enabled);
    lastSpokenCueRef.current = "";
    if (!enabled) {
      window.speechSynthesis.cancel();
      return;
    }
    const step = routeStepsRef.current[activeStepIndexRef.current];
    speakNavigation(step ? `Voice guidance on. ${routeInstruction(step)}.` : "Voice guidance on.");
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-menu-wrap" ref={brandMenuRef}>
          <button
            className="brand"
            type="button"
            onClick={() => setAppMenuOpen((open) => !open)}
            aria-label={appMenuOpen ? "Close Overworld menu" : "Open Overworld menu"}
            aria-expanded={appMenuOpen}
            aria-haspopup="menu"
          >
            <span className="brand-cube" aria-hidden="true" />
            <span>OVERWORLD</span>
          </button>
          {appMenuOpen && (
            <div className="app-menu" role="menu" aria-label="Overworld app menu">
              <button type="button" role="menuitem" onClick={refreshApp}>
                <span className="app-menu-icon" aria-hidden="true">↻</span>
                <span><strong>REFRESH MAP</strong><small>Reload this map view</small></span>
              </button>
              <button type="button" role="menuitem" onClick={startOver}>
                <span className="app-menu-icon" aria-hidden="true">⌂</span>
                <span><strong>START OVER</strong><small>Clear everything and use your location</small></span>
              </button>
            </div>
          )}
        </div>
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
              {results.map((result) => {
                const labels = searchResultLabels(result);
                return (
                  <button key={result.place_id} onClick={() => chooseResult(result)} role="option">
                    <span className="result-pin" aria-hidden="true" />
                    <span>
                      <strong>{labels.primary}</strong>
                      <small>{labels.secondary || result.type}</small>
                    </span>
                  </button>
                );
              })}
              <div className="geocode-credit">Search by OpenStreetMap</div>
            </div>
          )}
        </div>
        <div className="header-note">EARTH · SEED 2026</div>
      </header>

      <section
        className={`map-frame ${routeActive ? "route-running" : ""}`}
        aria-label="Interactive Minecraft-style world map"
      >
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
            {gpsMode === "locating"
              ? <span className="gps-loading" />
              : <span className="gps-tool-icon" aria-hidden="true" />}
          </button>
          <button
            className={navigationOpen || routeActive ? "navigation-active" : ""}
            onClick={() => setNavigationVisible(!navigationOpenRef.current)}
            aria-label={navigationOpen ? "Close navigation panel" : "Open navigation"}
            aria-pressed={navigationOpen}
            title="Navigation"
          >
            <span className="navigation-tool-icon" aria-hidden="true" />
          </button>
          <button
            onClick={() => setLegendOpen((open) => !open)}
            aria-label={legendOpen ? "Close map key" : "Open map key"}
            aria-pressed={legendOpen}
            title="Map key"
          >
            <span className="key-tool-icon" aria-hidden="true" />
          </button>
        </div>

        {navigationOpen && (
          <aside className={`navigation-panel ${routeSummary ? "has-route" : ""}`} aria-label="Route navigation">
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
                <div className={`turn-by-turn ${navigationStatus}`} aria-live="polite">
                  <small>
                    {navigationStatus === "arrived"
                      ? "DESTINATION REACHED"
                      : navigationStatus === "rerouting"
                        ? "REROUTING…"
                        : navigationStatus === "preview"
                          ? "ROUTE PREVIEW"
                          : distanceToStep == null
                            ? "NEXT TURN"
                            : `NEXT · ${formatRouteDistance(distanceToStep)}`}
                  </small>
                  <div>
                    <span aria-hidden="true">{navigationStatus === "arrived" ? "◆" : "➤"}</span>
                    <strong>
                      {navigationStatus === "rerouting"
                        ? "Finding a new path"
                        : routeSteps[activeStepIndex]
                          ? routeInstruction(routeSteps[activeStepIndex])
                          : "Follow the highlighted route"}
                    </strong>
                  </div>
                </div>
                <div className="route-summary">
                  <strong>{formatRouteDuration(routeSummary.duration)}</strong>
                  <span>{formatRouteDistance(routeSummary.distance)}</span>
                  <small>
                    {navigationStatus === "preview"
                      ? `FROM ${routeSummary.origin.toUpperCase()}`
                      : navigationStatus === "arrived"
                        ? "ARRIVED"
                        : "LIVE REMAINING"}
                  </small>
                </div>
                <div className="route-controls">
                  <button
                    className={followingLocation ? "enabled" : ""}
                    onClick={recenterNavigation}
                    aria-pressed={followingLocation}
                    title={
                      followingLocation &&
                      navigationStatus !== "preview" &&
                      navigationStatus !== "arrived"
                        ? "Heading-up GPS follow is active"
                        : followingLocation
                          ? "Live GPS follow is active"
                          : "Recenter and follow your GPS position"
                    }
                  >
                    {followingLocation && navigationStatus !== "preview" && navigationStatus !== "arrived"
                      ? "HEADING UP"
                      : followingLocation
                        ? "FOLLOWING"
                        : "RECENTER"}
                  </button>
                  <button className={voiceEnabled ? "enabled" : ""} onClick={toggleNavigationVoice}>
                    {voiceEnabled ? "VOICE ON" : "VOICE OFF"}
                  </button>
                </div>
                <ol className="route-steps">
                  {routeSteps.map((step, index) => (
                    <li
                      className={index === activeStepIndex ? "current" : index < activeStepIndex ? "passed" : ""}
                      key={`${step.maneuver.location.join(",")}-${index}`}
                    >
                      <span className="step-arrow" aria-hidden="true">{step.maneuver.type === "arrive" ? "◆" : "➤"}</span>
                      <span><strong>{routeInstruction(step)}</strong><small>{formatRouteDistance(step.distance)}</small></span>
                    </li>
                  ))}
                </ol>
                <button className="route-action end" onClick={endNavigation}>END NAVIGATION</button>
              </>
            )}
            <div className="route-credit">Follow posted signs · Routing by OSRM · Map data © OpenStreetMap</div>
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

        <div className="coordinates">X {coordinates.lng.toFixed(4)}&nbsp;&nbsp; Z {coordinates.lat.toFixed(4)}</div>
        <div className="map-message" aria-live="polite">{message}</div>
      </section>
    </main>
  );
}
