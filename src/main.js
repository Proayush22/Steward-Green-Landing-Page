import * as THREE from "three";
import { geoAlbersUsa, geoBounds, geoCentroid, geoContains, geoInterpolate } from "d3-geo";
import { animate, inView, scroll, stagger } from "motion";
import { feature, neighbors } from "topojson-client";
import statesTopology from "us-atlas/states-10m.json";
import { getMapStoryProgress } from "./map-story-progress.js";
import "./style.css";

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
if (!reducedMotion) document.documentElement.classList.add("motion-ready");
const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const formatNumber = (value) => Math.round(value).toLocaleString("en-US");

const targetStateCatalog = [
  { fips: "34", code: "NJ", name: "New Jersey" },
  { fips: "42", code: "PA", name: "Pennsylvania" },
  { fips: "44", code: "RI", name: "Rhode Island" },
  { fips: "09", code: "CT", name: "Connecticut" },
  { fips: "17", code: "IL", name: "Illinois" },
  { fips: "29", code: "MO", name: "Missouri" },
  { fips: "05", code: "AR", name: "Arkansas" },
  { fips: "51", code: "VA", name: "Virginia" },
  { fips: "24", code: "MD", name: "Maryland" },
  { fips: "39", code: "OH", name: "Ohio" },
  { fips: "21", code: "KY", name: "Kentucky" },
  { fips: "40", code: "OK", name: "Oklahoma" },
  { fips: "36", code: "NY", name: "New York" },
  { fips: "26", code: "MI", name: "Michigan" },
  { fips: "10", code: "DE", name: "Delaware" },
  { fips: "18", code: "IN", name: "Indiana" },
];

let targetStates = [...targetStateCatalog];
const targetIndex = new Set(targetStateCatalog.map((state) => state.fips));
const preferredAdjacentNext = new Map([
  ["21", "39"], // Kentucky → Ohio
  ["39", "26"], // Ohio → Michigan
  ["26", "18"], // Michigan → Indiana
  ["18", "17"], // Indiana → Illinois
  ["17", "29"], // Illinois → Missouri
  ["29", "05"], // Missouri → Arkansas
  ["05", "40"], // Arkansas → Oklahoma
]);
// Responsive position controls: adjust these ratios to tune the overview and story framing.
const mapLayout = {
  heroShift: 0.045,
  storyAreaBias: 0.68,
  boundsPadding: 0.86,
  rhodeIslandStepScale: 0.9,
};
const mapState = {
  activeCount: -1,
  targetMeshes: new Map(),
  targetDots: new Map(),
  targetCenters: new Map(),
  targetBounds: new Map(),
  arcs: [],
  storyProgress: 0,
  storyEngagement: 0,
  view: {
    currentPosition: new THREE.Vector2(),
    targetPosition: new THREE.Vector2(),
    currentScale: 1,
    targetScale: 1,
    initialized: false,
    heroPosition: new THREE.Vector2(),
    heroScale: 1,
    focalPoint: new THREE.Vector2(),
  },
};

function normalizeFips(value) {
  return String(value).padStart(2, "0");
}

function orderStatesByAdjacency(catalog, topology, stateFeatures, projection) {
  const geometries = topology.objects.states.geometries;
  const stateIndices = new Map(geometries.map((geometry, index) => [normalizeFips(geometry.id), index]));
  const featureByFips = new Map(stateFeatures.map((stateFeature) => [normalizeFips(stateFeature.id), stateFeature]));
  const adjacentIndices = neighbors(geometries);
  const centers = new Map(catalog.map((state) => {
    const stateFeature = featureByFips.get(state.fips);
    const center = stateFeature ? projection(geoCentroid(stateFeature)) : null;
    return [state.fips, center ? new THREE.Vector2(center[0], -center[1]) : null];
  }));
  const remaining = new Map(catalog.map((state) => [state.fips, state]));
  const sequence = [];
  let current = remaining.get("34");
  if (!current) return [...catalog];

  sequence.push(current);
  remaining.delete(current.fips);

  while (remaining.size) {
    const currentIndex = stateIndices.get(current.fips);
    const neighboringIndices = new Set(adjacentIndices[currentIndex] ?? []);
    const touchingStates = [...remaining.values()].filter((state) => {
      const index = stateIndices.get(state.fips);
      return index !== undefined && neighboringIndices.has(index);
    });
    const preferredNext = remaining.get(preferredAdjacentNext.get(current.fips));
    const candidates = preferredNext && touchingStates.includes(preferredNext)
      ? [preferredNext]
      : touchingStates.length
        ? touchingStates
        : [...remaining.values()];
    const currentCenter = centers.get(current.fips);
    candidates.sort((a, b) => {
      const centerA = centers.get(a.fips);
      const centerB = centers.get(b.fips);
      if (!currentCenter || !centerA || !centerB) return a.fips.localeCompare(b.fips);
      return centerA.distanceToSquared(currentCenter) - centerB.distanceToSquared(currentCenter);
    });

    current = candidates[0];
    sequence.push(current);
    remaining.delete(current.fips);
  }

  return sequence;
}

function syncStateSequenceList() {
  const list = document.getElementById("state-sequence");
  if (!list) return;
  const items = new Map([...list.children].map((item) => [item.dataset.fips, item]));
  targetStates.forEach((state) => {
    const item = items.get(state.fips);
    if (item) list.appendChild(item);
  });
}

function setPathFromRing(ring, projection, expectClockwise) {
  const points = ring
    .slice(0, -1)
    .map((coordinate) => projection(coordinate))
    .filter(Boolean)
    .map(([x, y]) => new THREE.Vector2(x, -y));

  if (points.length < 3) return null;
  const isClockwise = THREE.ShapeUtils.isClockWise(points);
  if (isClockwise !== expectClockwise) points.reverse();
  return points;
}

function geometryForFeature(mapFeature, projection) {
  const polygons = mapFeature.geometry.type === "MultiPolygon"
    ? mapFeature.geometry.coordinates
    : [mapFeature.geometry.coordinates];
  const shapes = [];

  polygons.forEach((polygon) => {
    const outer = setPathFromRing(polygon[0], projection, true);
    if (!outer) return;
    const shape = new THREE.Shape(outer);

    polygon.slice(1).forEach((ring) => {
      const hole = setPathFromRing(ring, projection, false);
      if (hole) shape.holes.push(new THREE.Path(hole));
    });
    shapes.push(shape);
  });

  return shapes.length ? new THREE.ShapeGeometry(shapes) : null;
}

function createMapScene() {
  const mount = document.getElementById("webgl-scene");
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  mount.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  camera.position.set(0, 0, 9);

  const mapGroup = new THREE.Group();
  mapGroup.rotation.x = -0.08;
  mapGroup.rotation.z = -0.018;
  scene.add(mapGroup);
  const densityDeer = [];
  const raycaster = new THREE.Raycaster();
  const pointerNdc = new THREE.Vector2();
  const heatPlane = new THREE.Plane();
  const heatPoint = new THREE.Vector3();
  let densityHeatActive = false;
  const heatTextureCanvas = document.createElement("canvas");
  heatTextureCanvas.width = 128;
  heatTextureCanvas.height = 128;
  const heatContext = heatTextureCanvas.getContext("2d");
  const heatGradient = heatContext.createRadialGradient(64, 64, 0, 64, 64, 64);
  heatGradient.addColorStop(0, "rgba(255, 100, 72, 0.62)");
  heatGradient.addColorStop(0.24, "rgba(224, 73, 58, 0.34)");
  heatGradient.addColorStop(1, "rgba(224, 73, 58, 0)");
  heatContext.fillStyle = heatGradient;
  heatContext.fillRect(0, 0, 128, 128);
  const heatTexture = new THREE.CanvasTexture(heatTextureCanvas);
  const densityHeat = new THREE.Sprite(new THREE.SpriteMaterial({
    map: heatTexture,
    color: 0xff684f,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }));
  densityHeat.scale.set(0.98, 0.98, 1);
  densityHeat.position.z = 0.18;
  mapGroup.add(densityHeat);
  const stateLayers = [];

  const states = feature(statesTopology, statesTopology.objects.states).features;
  const collection = { type: "FeatureCollection", features: states };
  const projection = geoAlbersUsa().fitExtent([[-3.7, -2.35], [3.7, 2.35]], collection);
  targetStates = orderStatesByAdjacency(targetStateCatalog, statesTopology, states, projection);
  syncStateSequenceList();

  states.forEach((stateFeature) => {
    const fips = normalizeFips(stateFeature.id);
    const isTarget = targetIndex.has(fips);
    const geometry = geometryForFeature(stateFeature, projection);
    if (!geometry) return;
    geometry.computeBoundingBox();

    const material = new THREE.MeshBasicMaterial({
      color: isTarget ? 0x5a2522 : 0x232326,
      transparent: true,
      opacity: isTarget ? 0.36 : 0.12,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.z = isTarget ? 0.006 : 0;
    mapGroup.add(mesh);

    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry, 18),
      new THREE.LineBasicMaterial({
        color: isTarget ? 0x9a4a44 : 0x4a4849,
        transparent: true,
        opacity: isTarget ? 0.34 : 0.16,
        depthWrite: false,
      }),
    );
    edges.position.z = 0.012;
    mapGroup.add(edges);
    stateLayers.push({ fips, isTarget, material, edgeMaterial: edges.material });

    if (isTarget) {
      mapState.targetMeshes.set(fips, { material, edgeMaterial: edges.material });
      if (geometry.boundingBox) {
        mapState.targetBounds.set(fips, {
          minX: geometry.boundingBox.min.x,
          maxX: geometry.boundingBox.max.x,
          minY: geometry.boundingBox.min.y,
          maxY: geometry.boundingBox.max.y,
        });
      }
      const center = projection(geoCentroid(stateFeature));
      if (center) {
        mapState.targetCenters.set(fips, new THREE.Vector2(center[0], -center[1]));
        const dot = new THREE.Mesh(
          new THREE.CircleGeometry(0.045, 24),
          new THREE.MeshBasicMaterial({ color: 0xd9685e, transparent: true, opacity: 0.1, depthWrite: false }),
        );
        dot.position.set(center[0], -center[1], 0.035);
        dot.scale.setScalar(0.2);
        mapGroup.add(dot);
        mapState.targetDots.set(fips, dot);
      }
    }
  });

  // Use the actual study-state polygons to seed the deer markers; every marker is
  // sampled inside a state boundary instead of being scattered over a rectangle.
  const studyFeatures = states.filter((stateFeature) => targetIndex.has(normalizeFips(stateFeature.id)));
  const deerIconCanvas = document.createElement("canvas");
  deerIconCanvas.width = 128;
  deerIconCanvas.height = 128;
  const deerIconContext = deerIconCanvas.getContext("2d");
  deerIconContext.font = '92px "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
  deerIconContext.textAlign = "center";
  deerIconContext.textBaseline = "middle";
  deerIconContext.fillText("🦌", 64, 68);
  const deerTexture = new THREE.CanvasTexture(deerIconCanvas);
  deerTexture.colorSpace = THREE.SRGBColorSpace;
  studyFeatures.forEach((stateFeature, stateIndex) => {
    const [[minLon, minLat], [maxLon, maxLat]] = geoBounds(stateFeature);
    let placed = 0;
    let attempts = 0;
    while (placed < 7 && attempts < 600) {
      attempts += 1;
      const coordinate = [minLon + Math.random() * (maxLon - minLon), minLat + Math.random() * (maxLat - minLat)];
      const projected = projection(coordinate);
      if (!projected || !geoContains(stateFeature, coordinate)) continue;
      const size = 0.15 + Math.random() * 0.045;
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: deerTexture,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      }));
      sprite.position.set(projected[0], -projected[1], 0.1 + stateIndex * 0.0001);
      sprite.scale.set(size, size, 1);
      mapGroup.add(sprite);
      densityDeer.push({ sprite, x: projected[0], y: -projected[1], size, baseOpacity: 0.9 });
      placed += 1;
    }
  });

  const njToSanFrancisco = geoInterpolate([-74.4057, 40.0583], [-122.4194, 37.7749]);
  const flightCoordinates = Array.from({ length: 49 }, (_, index) => njToSanFrancisco(index / 48));
  flightCoordinates.push(...flightCoordinates.slice(0, -1).reverse());
  const flightWaypoints = flightCoordinates.map((coordinate) => {
    const point = projection(coordinate);
    return new THREE.Vector3(point[0], -point[1], 0.22);
  });
  const flightCurve = new THREE.CatmullRomCurve3(flightWaypoints);
  const flightPoints = flightCurve.getPoints(200);
  const flightGeometry = new THREE.BufferGeometry().setFromPoints(flightPoints);
  flightGeometry.setDrawRange(0, 0);
  const flightLine = new THREE.Line(
    flightGeometry,
    new THREE.LineDashedMaterial({
      color: 0xf07865,
      dashSize: 0.09,
      gapSize: 0.055,
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
    }),
  );
  flightLine.computeLineDistances();
  mapGroup.add(flightLine);

  const droneCanvas = document.createElement("canvas");
  droneCanvas.width = 128;
  droneCanvas.height = 128;
  const droneContext = droneCanvas.getContext("2d");
  droneContext.strokeStyle = "#171717";
  droneContext.fillStyle = "#f3eee7";
  droneContext.lineWidth = 7;
  droneContext.lineCap = "round";
  droneContext.lineJoin = "round";
  droneContext.beginPath();
  droneContext.moveTo(51, 50);
  droneContext.lineTo(28, 30);
  droneContext.moveTo(77, 50);
  droneContext.lineTo(100, 30);
  droneContext.moveTo(51, 76);
  droneContext.lineTo(28, 98);
  droneContext.moveTo(77, 76);
  droneContext.lineTo(100, 98);
  droneContext.stroke();
  droneContext.beginPath();
  droneContext.moveTo(51, 38);
  droneContext.quadraticCurveTo(64, 34, 77, 38);
  droneContext.lineTo(84, 76);
  droneContext.quadraticCurveTo(82, 87, 72, 89);
  droneContext.lineTo(56, 89);
  droneContext.quadraticCurveTo(46, 87, 44, 76);
  droneContext.closePath();
  droneContext.fill();
  droneContext.stroke();
  droneContext.fillStyle = "#f07865";
  droneContext.beginPath();
  droneContext.roundRect(53, 87, 22, 11, 3);
  droneContext.fill();
  droneContext.stroke();
  [[28, 30], [100, 30], [28, 98], [100, 98]].forEach(([x, y]) => {
    droneContext.beginPath();
    droneContext.ellipse(x, y, 19, 7, Math.PI / 4, 0, Math.PI * 2);
    droneContext.stroke();
    droneContext.beginPath();
    droneContext.arc(x, y, 5, 0, Math.PI * 2);
    droneContext.fill();
  });
  const droneTexture = new THREE.CanvasTexture(droneCanvas);
  const flightDrone = new THREE.Sprite(new THREE.SpriteMaterial({ map: droneTexture, transparent: true, opacity: 0, depthWrite: false }));
  flightDrone.scale.set(0.34, 0.34, 1);
  flightDrone.position.copy(flightCurve.getPoint(0));
  mapGroup.add(flightDrone);

  targetStates.slice(1).forEach((state, index) => {
    const previousCenter = mapState.targetCenters.get(targetStates[index].fips);
    const destinationCenter = mapState.targetCenters.get(state.fips);
    if (!previousCenter || !destinationCenter) return;

    const start = new THREE.Vector3(previousCenter.x, previousCenter.y, 0.05);
    const end = new THREE.Vector3(destinationCenter.x, destinationCenter.y, 0.05);
    const midpoint = start.clone().lerp(end, 0.5);
    midpoint.z = 0.22 + start.distanceTo(end) * 0.08;
    const curve = new THREE.QuadraticBezierCurve3(start, midpoint, end);
    const points = curve.getPoints(54);
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    geometry.setDrawRange(0, 0);
    const line = new THREE.Line(
      geometry,
      new THREE.LineBasicMaterial({ color: 0xd9685e, transparent: true, opacity: 0.34, depthWrite: false }),
    );
    mapGroup.add(line);
    mapState.arcs.push({ line, stateIndex: index + 1, pointCount: points.length });
  });

  const particleCount = 210;
  const positions = new Float32Array(particleCount * 3);
  for (let index = 0; index < particleCount; index += 1) {
    positions[index * 3] = (Math.random() - 0.5) * 12;
    positions[index * 3 + 1] = (Math.random() - 0.5) * 7;
    positions[index * 3 + 2] = (Math.random() - 0.5) * 2 - 0.5;
  }
  const particlesGeometry = new THREE.BufferGeometry();
  particlesGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const particles = new THREE.Points(
    particlesGeometry,
    new THREE.PointsMaterial({ color: 0xc14a42, size: 0.01, transparent: true, opacity: 0.14, depthWrite: false }),
  );
  scene.add(particles);

  const pointer = { x: 0, y: 0 };
  window.addEventListener("pointermove", (event) => {
    pointer.x = event.clientX / window.innerWidth - 0.5;
    pointer.y = event.clientY / window.innerHeight - 0.5;
  }, { passive: true });

  function setStoryView(progress = mapState.storyProgress, engagement = mapState.storyEngagement) {
    const activeCount = Math.max(1, Math.min(targetStates.length, Math.floor(progress * targetStates.length) + 1));
    const indianaIndex = targetStates.findIndex((state) => state.fips === "18");
    const frameCount = Math.min(activeCount, indianaIndex + 1);
    const revealedCenters = targetStates
      .slice(0, frameCount)
      .map((state) => mapState.targetCenters.get(state.fips))
      .filter(Boolean);

    if (!revealedCenters.length) return;

    const boundsFor = (stateList) => stateList
      .map((state) => mapState.targetBounds.get(state.fips))
      .filter(Boolean)
      .reduce((result, item) => ({
        minX: Math.min(result.minX, item.minX),
        maxX: Math.max(result.maxX, item.maxX),
        minY: Math.min(result.minY, item.minY),
        maxY: Math.max(result.maxY, item.maxY),
      }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
    const bounds = boundsFor(targetStates.slice(0, frameCount));
    const center = new THREE.Vector2(
      (bounds.minX + bounds.maxX) / 2,
      (bounds.minY + bounds.maxY) / 2,
    );
    const viewHeight = 2 * camera.position.z * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const viewWidth = viewHeight * camera.aspect;
    const copyWidth = Math.min(640, window.innerWidth * 0.48);
    const openMapLeft = -viewWidth / 2 + viewWidth * (copyWidth / window.innerWidth) + viewWidth * 0.04;
    const openMapRight = viewWidth / 2 - viewWidth * 0.04;
    const openMapCenter = THREE.MathUtils.lerp(openMapLeft, openMapRight, mapLayout.storyAreaBias);
    const openMapWidth = 2 * Math.min(openMapCenter - openMapLeft, openMapRight - openMapCenter) * mapLayout.boundsPadding;
    const fitScale = Math.min(
      openMapWidth / Math.max(0.01, bounds.maxX - bounds.minX),
      (viewHeight * 0.7) / Math.max(0.01, bounds.maxY - bounds.minY),
      5.2,
    );
    const rhodeIslandIsVisible = targetStates
      .slice(0, frameCount)
      .some((state) => state.fips === "44");
    const northeastScale = rhodeIslandIsVisible ? mapLayout.rhodeIslandStepScale : 1;
    const storyScale = fitScale * northeastScale;
    const storyPosition = mapState.view.focalPoint.clone().setX(openMapCenter).sub(center.multiplyScalar(storyScale));

    mapState.view.targetScale = THREE.MathUtils.lerp(mapState.view.heroScale, storyScale, engagement);
    mapState.view.targetPosition.lerpVectors(mapState.view.heroPosition, storyPosition, engagement);
  }

  function setDensityView(progress = 0, deerVisibility = progress, flightZoomOut = 0) {
    const amount = clamp(progress);
    const flightAmount = clamp(flightZoomOut);
    // Leave the national-footprint story's own target untouched outside this section.
    if (amount <= 0 && flightAmount <= 0) {
      densityDeer.forEach(({ sprite }) => {
        sprite.userData.densityOpacity = 0;
      });
      return;
    }
    const storyScale = mapState.view.targetScale;
    const storyPosition = mapState.view.targetPosition.clone();
    const bounds = targetStateCatalog
      .map(({ fips }) => mapState.targetBounds.get(fips))
      .filter(Boolean)
      .reduce((result, item) => ({
        minX: Math.min(result.minX, item.minX),
        maxX: Math.max(result.maxX, item.maxX),
        minY: Math.min(result.minY, item.minY),
        maxY: Math.max(result.maxY, item.maxY),
      }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
    if (!Number.isFinite(bounds.minX)) return;
    const center = new THREE.Vector2((bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2);
    const viewHeight = 2 * camera.position.z * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const viewWidth = viewHeight * camera.aspect;
    const zoom = Math.min(viewWidth * 0.78 / (bounds.maxX - bounds.minX), viewHeight * 0.72 / (bounds.maxY - bounds.minY), 3.4);
    const densityPosition = center.clone().multiplyScalar(-zoom);
    const densityScale = THREE.MathUtils.lerp(storyScale, zoom, amount);
    const densityTargetPosition = storyPosition.clone().lerp(densityPosition, amount);
    const fullMapScale = Math.min((viewWidth * 0.84) / 7.4, (viewHeight * 0.82) / 4.7);
    mapState.view.targetScale = THREE.MathUtils.lerp(densityScale, fullMapScale, flightAmount);
    mapState.view.targetPosition.copy(densityTargetPosition).lerp(new THREE.Vector2(), flightAmount);
    densityDeer.forEach(({ sprite, baseOpacity }) => {
      sprite.userData.densityOpacity = baseOpacity * clamp(deerVisibility);
    });
  }

  function setDensityPointer(event, active = true) {
    densityHeatActive = active;
    if (!active) return;
    pointerNdc.set((event.clientX / window.innerWidth) * 2 - 1, -(event.clientY / window.innerHeight) * 2 + 1);
    mapGroup.updateMatrixWorld(true);
    camera.updateMatrixWorld();
    raycaster.setFromCamera(pointerNdc, camera);
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(mapGroup.getWorldQuaternion(new THREE.Quaternion()));
    heatPlane.setFromNormalAndCoplanarPoint(normal, mapGroup.position);
    if (raycaster.ray.intersectPlane(heatPlane, heatPoint)) {
      const localPoint = mapGroup.worldToLocal(heatPoint.clone());
      densityHeat.position.set(localPoint.x, localPoint.y, 0.18);
      densityHeat.userData.targetX = localPoint.x;
      densityHeat.userData.targetY = localPoint.y;
    }
  }

  function setTargetDotVisibility(hiddenProgress = 0) {
    const visibility = 1 - clamp(hiddenProgress);
    mapState.targetDots.forEach((dot, fips) => {
      const stateIndex = targetStates.findIndex((state) => state.fips === fips);
      const active = stateIndex >= 0 && stateIndex < mapState.activeCount;
      dot.material.opacity = (active ? 0.95 : 0.1) * visibility;
      dot.scale.setScalar((active ? 1 : 0.2) * visibility);
    });
  }

  function setFlightTheme(progress = 0) {
    const amount = clamp(progress);
    stateLayers.forEach(({ fips, isTarget, material, edgeMaterial }) => {
      const stateIndex = targetStates.findIndex((state) => state.fips === fips);
      const active = isTarget && stateIndex >= 0 && stateIndex < mapState.activeCount;
      const baseFill = isTarget ? new THREE.Color(active ? 0xa93630 : 0x542522) : new THREE.Color(0x232326);
      const baseEdge = isTarget ? new THREE.Color(active ? 0xe07167 : 0x8a4a45) : new THREE.Color(0x4a4849);
      const flightFill = isTarget ? new THREE.Color(0x82a779) : new THREE.Color(0x2b5862);
      const flightEdge = isTarget ? new THREE.Color(0xc4d5a3) : new THREE.Color(0x6e9da2);
      material.color.copy(baseFill).lerp(flightFill, amount);
      edgeMaterial.color.copy(baseEdge).lerp(flightEdge, amount);
      material.opacity = THREE.MathUtils.lerp(isTarget ? (active ? 0.82 : 0.32) : 0.12, isTarget ? 0.92 : 0.68, amount);
      edgeMaterial.opacity = THREE.MathUtils.lerp(isTarget ? (active ? 0.86 : 0.28) : 0.16, isTarget ? 0.98 : 0.58, amount);
    });
    mapState.targetDots.forEach((dot, fips) => {
      const stateIndex = targetStates.findIndex((state) => state.fips === fips);
      const active = stateIndex >= 0 && stateIndex < mapState.activeCount;
      dot.material.color.setHex(0xd9685e);
      dot.material.opacity = THREE.MathUtils.lerp(active ? 0.95 : 0.1, 0, amount);
      dot.scale.setScalar(THREE.MathUtils.lerp(active ? 1 : 0.2, 0, amount));
    });
  }

  function setFlightProgress(progress = 0, visibility = 0) {
    const amount = clamp(progress);
    const visible = clamp(visibility);
    flightLine.geometry.setDrawRange(0, Math.floor(flightPoints.length * amount));
    flightLine.material.opacity = 0.82 * visible;
    flightDrone.position.copy(flightCurve.getPoint(amount));
    flightDrone.userData.targetOpacity = visible;
  }

  function resize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    const viewHeight = 2 * camera.position.z * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const viewWidth = viewHeight * camera.aspect;

    if (width < 760) {
      mapState.view.heroPosition.set(viewWidth * mapLayout.heroShift, 0);
      mapState.view.heroScale = Math.min(0.92, (viewWidth * 0.9) / 7.4, (viewHeight * 0.88) / 4.7);
      mapState.view.focalPoint.set(0, 0);
    } else if (width < 1080) {
      mapState.view.heroPosition.set(viewWidth * mapLayout.heroShift, 0);
      mapState.view.heroScale = Math.min(0.92, (viewWidth * 0.9) / 7.4, (viewHeight * 0.88) / 4.7);
      const copyWidth = Math.min(640, width * 0.48);
      const openMapLeft = -viewWidth / 2 + viewWidth * (copyWidth / width) + viewWidth * 0.04;
      const openMapRight = viewWidth / 2 - viewWidth * 0.04;
      mapState.view.focalPoint.set(THREE.MathUtils.lerp(openMapLeft, openMapRight, mapLayout.storyAreaBias), 0);
    } else {
      mapState.view.heroPosition.set(viewWidth * mapLayout.heroShift, 0);
      mapState.view.heroScale = Math.min(0.92, (viewWidth * 0.9) / 7.4, (viewHeight * 0.88) / 4.7);
      const copyWidth = Math.min(640, width * 0.48);
      const openMapLeft = -viewWidth / 2 + viewWidth * (copyWidth / width) + viewWidth * 0.04;
      const openMapRight = viewWidth / 2 - viewWidth * 0.04;
      mapState.view.focalPoint.set(THREE.MathUtils.lerp(openMapLeft, openMapRight, mapLayout.storyAreaBias), 0);
    }

    if (!mapState.view.initialized) {
      mapState.view.currentScale = mapState.view.heroScale;
      mapState.view.currentPosition.copy(mapState.view.heroPosition);
      mapState.view.initialized = true;
    }
    setStoryView();
  }

  function render(time) {
    const seconds = time * 0.001;
    const drift = reducedMotion ? 0 : Math.sin(seconds * 0.18) * 0.015;
    mapGroup.rotation.y += ((pointer.x * 0.06) - mapGroup.rotation.y) * 0.035;
    mapGroup.rotation.x += ((-0.08 - pointer.y * 0.035 + drift) - mapGroup.rotation.x) * 0.035;
    const viewEase = reducedMotion ? 1 : 0.07;
    mapState.view.currentScale += (mapState.view.targetScale - mapState.view.currentScale) * viewEase;
    mapState.view.currentPosition.lerp(mapState.view.targetPosition, viewEase);
    mapGroup.position.set(mapState.view.currentPosition.x, mapState.view.currentPosition.y, 0);
    mapGroup.scale.setScalar(mapState.view.currentScale);
    densityHeat.material.opacity += ((densityHeatActive ? 0.46 : 0) - densityHeat.material.opacity) * 0.14;
    flightDrone.material.opacity += ((flightDrone.userData.targetOpacity ?? 0) - flightDrone.material.opacity) * 0.16;
    densityDeer.forEach(({ sprite, x, y, size }) => {
      const distance = Math.hypot(x - (densityHeat.userData.targetX ?? 100), y - (densityHeat.userData.targetY ?? 100));
      const isHovered = densityHeatActive && distance < Math.max(0.09, size * 0.95);
      const goalOpacity = sprite.userData.densityOpacity ?? 0;
      sprite.material.opacity += (Math.min(1, goalOpacity + (isHovered ? 0.1 : 0)) - sprite.material.opacity) * 0.2;
      const scale = size * (isHovered ? 1.42 : 1);
      sprite.scale.x += (scale - sprite.scale.x) * 0.2;
      sprite.scale.y += (scale - sprite.scale.y) * 0.2;
    });
    particles.rotation.z = reducedMotion ? 0 : seconds * 0.002;
    renderer.render(scene, camera);
    requestAnimationFrame(render);
  }

  resize();
  window.addEventListener("resize", resize, { passive: true });
  requestAnimationFrame(render);

  return { mapGroup, mount, setStoryView, setDensityView, setDensityPointer, setTargetDotVisibility, setFlightProgress, setFlightTheme };
}

function setMapProgress(progress, engagement, setStoryView) {
  mapState.storyProgress = progress;
  mapState.storyEngagement = engagement;
  const activeCount = reducedMotion
    ? targetStates.length
    : engagement >= 0.98
      ? Math.min(targetStates.length, Math.floor(progress * targetStates.length) + 1)
      : 0;
  setStoryView(progress, engagement);
  if (activeCount === mapState.activeCount) return;
  mapState.activeCount = activeCount;

  targetStates.forEach((state, index) => {
    const active = index < activeCount;
    const entry = mapState.targetMeshes.get(state.fips);
    if (entry) {
      entry.material.color.setHex(active ? 0xa93630 : 0x542522);
      entry.material.opacity = active ? 0.82 : 0.32;
      entry.edgeMaterial.color.setHex(active ? 0xe07167 : 0x8a4a45);
      entry.edgeMaterial.opacity = active ? 0.86 : 0.28;
    }

    const dot = mapState.targetDots.get(state.fips);
    if (dot) {
      dot.material.opacity = active ? 0.95 : 0.1;
      dot.scale.setScalar(active ? 1 : 0.2);
    }
  });

  mapState.arcs.forEach(({ line, stateIndex, pointCount }) => {
    line.geometry.setDrawRange(0, stateIndex < activeCount ? pointCount : 0);
  });

  document.querySelectorAll("#state-sequence li").forEach((item, index) => {
    item.classList.toggle("is-active", index < activeCount);
  });
  document.getElementById("map-progress-count").textContent = `${activeCount} of 16`;
}

function createDeerField(setDensityPointer) {
  const canvas = document.getElementById("deer-canvas");
  const context = canvas.getContext("2d");
  const readout = document.getElementById("deer-count");
  const totalDeer = 112;
  let activeDeer = reducedMotion ? totalDeer : 0;
  let cachedWidth = 0;
  let cachedHeight = 0;
  let heatFrame = 0;
  const heat = {
    active: false,
    x: 0,
    y: 0,
    targetX: 0,
    targetY: 0,
    intensity: 0,
  };

  function draw() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio, 2);
    if (rect.width !== cachedWidth || rect.height !== cachedHeight) {
      cachedWidth = rect.width;
      cachedHeight = rect.height;
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
    }
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, rect.width, rect.height);

    const heatRadius = Math.max(85, Math.min(170, rect.width * 0.14));
    if (heat.intensity > 0.01) {
      const heatGlow = context.createRadialGradient(heat.x, heat.y, 0, heat.x, heat.y, heatRadius);
      heatGlow.addColorStop(0, `rgba(243, 98, 74, ${0.25 * heat.intensity})`);
      heatGlow.addColorStop(0.38, `rgba(208, 67, 55, ${0.15 * heat.intensity})`);
      heatGlow.addColorStop(1, "rgba(224, 115, 85, 0)");
      context.fillStyle = heatGlow;
      context.fillRect(0, 0, rect.width, rect.height);
    }

    readout.textContent = formatNumber((activeDeer / totalDeer) * 54820);
  }

  function setProgress(progress) {
    activeDeer = Math.round(totalDeer * clamp(progress));
    draw();
  }

  function setHeatTarget(event) {
    const rect = canvas.getBoundingClientRect();
    heat.targetX = clamp(event.clientX - rect.left, 0, rect.width);
    heat.targetY = clamp(event.clientY - rect.top, 0, rect.height);
    if (!heat.active) {
      heat.x = heat.targetX;
      heat.y = heat.targetY;
    }
    heat.active = true;
    setDensityPointer(event, true);
    startHeatAnimation();
  }

  function animateHeat() {
    heatFrame = 0;
    const easing = reducedMotion ? 1 : 0.16;
    heat.x += (heat.targetX - heat.x) * easing;
    heat.y += (heat.targetY - heat.y) * easing;
    heat.intensity += ((heat.active ? 1 : 0) - heat.intensity) * (heat.active ? 0.12 : 0.08);
    draw();
    if (heat.active || heat.intensity > 0.01) startHeatAnimation();
  }

  function startHeatAnimation() {
    if (!heatFrame) heatFrame = requestAnimationFrame(animateHeat);
  }

  canvas.addEventListener("pointermove", setHeatTarget, { passive: true });
  canvas.addEventListener("pointerdown", setHeatTarget, { passive: true });
  canvas.addEventListener("pointerenter", setHeatTarget, { passive: true });
  canvas.addEventListener("pointerleave", () => {
    heat.active = false;
    setDensityPointer(null, false);
    startHeatAnimation();
  }, { passive: true });

  window.addEventListener("resize", draw, { passive: true });
  draw();
  return { setProgress };
}

function animateCounter(element) {
  if (element.dataset.animated === "true") return;
  element.dataset.animated = "true";
  const target = Number(element.dataset.counter);
  if (!Number.isFinite(target)) return;

  if (reducedMotion) {
    element.textContent = formatNumber(target);
    return;
  }

  animate(0, target, {
    duration: 1.25,
    ease: [0.22, 1, 0.36, 1],
    onUpdate: (value) => {
      element.textContent = formatNumber(value);
    },
  });
}

const { mount: mapMount, setStoryView, setDensityView, setDensityPointer, setTargetDotVisibility, setFlightProgress, setFlightTheme } = createMapScene();
const deerField = createDeerField(setDensityPointer);
const hero = document.getElementById("top");
const mapStory = document.getElementById("reach");
const evidence = document.getElementById("evidence");
const flight = document.getElementById("flight");
const coverage = document.getElementById("coverage");
const closing = document.querySelector(".closing");
const siteHeader = document.getElementById("site-header");

function setupMotionAnimations() {
  if (reducedMotion) {
    document.documentElement.classList.remove("motion-ready");
    document.querySelectorAll("[data-counter]").forEach(animateCounter);
    return;
  }

  const entranceEase = [0.22, 1, 0.36, 1];
  const heroItems = [...hero.querySelectorAll(":scope > .reveal, .hero__copy > .reveal")];

  animate(heroItems, {
    opacity: [0, 1],
    y: [34, 0],
  }, {
    duration: 0.9,
    delay: stagger(0.1, { startDelay: 0.12 }),
    ease: entranceEase,
  });

  animate(".hero__credentials > div", {
    opacity: [0, 1],
    y: [22, 0],
  }, {
    duration: 0.72,
    delay: stagger(0.09, { startDelay: 0.66 }),
    ease: entranceEase,
  });

  hero.querySelectorAll("[data-counter]").forEach(animateCounter);

  document.querySelectorAll(".reveal").forEach((element) => {
    if (element.closest(".hero")) return;
    inView(element, (target) => {
      const isParallaxTarget = target.matches(".evidence__intro, .deer-field, .coverage__visual");
      animate(target, isParallaxTarget ? {
        opacity: [0, 1],
      } : {
        opacity: [0, 1],
        y: [42, 0],
      }, {
        duration: 0.88,
        ease: entranceEase,
      });
      target.querySelectorAll?.("[data-counter]").forEach(animateCounter);
    }, { amount: 0.14, margin: "0px 0px -8% 0px" });
  });

  inView("[data-counter]", (element) => animateCounter(element), { amount: 0.4 });

  [
    [".stat-ribbon", ".stat-ribbon article"],
    [".flight__stats", ".flight__stats article"],
    [".deliverables__grid", ".deliverables__grid article"],
  ].forEach(([containerSelector, itemSelector]) => {
    const container = document.querySelector(containerSelector);
    const items = [...document.querySelectorAll(itemSelector)];
    if (!container || !items.length) return;
    inView(container, () => {
      animate(items, {
        opacity: [0, 1],
        y: [28, 0],
      }, {
        duration: 0.72,
        delay: stagger(0.1),
        ease: entranceEase,
      });
    }, { amount: 0.2 });
  });

  inView(".coverage__visual", () => {
    animate(".coverage__rings span", {
      opacity: [0, 1],
      scale: [0.72, 1],
    }, {
      duration: 0.85,
      delay: stagger(0.08, { from: "center" }),
      ease: entranceEase,
    });
  }, { amount: 0.3 });

  const linkToScroll = (element, keyframes, target, offset = ["start start", "end start"]) => {
    if (!element || !target) return;
    scroll(animate(element, keyframes, { ease: "linear" }), { target, offset });
  };

  linkToScroll(document.querySelector(".hero__title-line--primary"), { x: [0, -72], opacity: [1, 0.12] }, hero);
  linkToScroll(document.querySelector(".hero__title-line--accent"), { x: [0, 64], opacity: [1, 0.12] }, hero);
  linkToScroll(document.querySelector(".hero__copy"), { y: [0, -64], opacity: [1, 0.14], scale: [1, 0.975] }, hero);
  linkToScroll(document.querySelector(".hero__proof-value"), { y: [0, -46], opacity: [1, 0.08], scale: [1, 0.9] }, hero);
  linkToScroll(document.querySelector(".hero__scroll"), { opacity: [1, 0], scale: [1, 0.92] }, hero, ["start start", "45% start"]);

  linkToScroll(document.querySelector(".map-story__sticky"), { y: [32, -34] }, mapStory, ["start end", "end start"]);
  linkToScroll(document.querySelector(".evidence__intro"), { y: [54, -32] }, evidence, ["start end", "end start"]);
  linkToScroll(document.querySelector(".deer-field"), { y: [40, -24], scale: [0.96, 1.015] }, evidence, ["start end", "end start"]);
  linkToScroll(document.querySelector(".coverage__visual"), { y: [68, -40], rotate: [-1.5, 1.5] }, coverage, ["start end", "end start"]);
  linkToScroll(document.querySelector(".closing__glow"), { scale: [0.72, 1.18], opacity: [0.2, 1] }, closing, ["start end", "center center"]);
}

setupMotionAnimations();

let scrollTicking = false;

function updateScrollStory() {
  scrollTicking = false;
  const viewportHeight = window.innerHeight;
  const mapRect = mapStory.getBoundingClientRect();
  const mapRange = Math.max(1, mapRect.height - viewportHeight);
  // Show the full U.S. until the story panel is in place, then zoom to the first state
  // before beginning the one-by-one illumination sequence.
  const storyStartTop = -viewportHeight * 0.05;
  const storyTravel = storyStartTop - mapRect.top;
  const zoomRange = viewportHeight * 0.08;
  const mapProgress = getMapStoryProgress(storyTravel, mapRange, zoomRange);
  const mapEngagement = reducedMotion ? 1 : clamp(storyTravel / zoomRange);
  setMapProgress(mapProgress, mapEngagement, setStoryView);

  const evidenceRect = evidence.getBoundingClientRect();
  const evidenceProgress = clamp((viewportHeight * 0.82 - evidenceRect.top) / Math.max(1, evidenceRect.height * 0.54));
  deerField.setProgress(reducedMotion ? 1 : evidenceProgress);
  const densityIn = clamp((viewportHeight * 0.82 - evidenceRect.top) / Math.max(1, evidenceRect.height * 0.2));
  const densityOut = clamp((evidenceRect.bottom - viewportHeight * 0.38) / Math.max(1, evidenceRect.height * 0.2));

  const flightRect = flight.getBoundingClientRect();
  const flightTriggerY = viewportHeight * 0.55;
  const flightProgress = clamp((flightTriggerY - flightRect.top) / Math.max(1, flightRect.height * 0.85));
  const flightViewIn = clamp((viewportHeight * 0.82 - flightRect.top) / Math.max(1, flightRect.height * 0.2));
  const flightViewOut = clamp((flightRect.bottom - viewportHeight * 0.38) / Math.max(1, flightRect.height * 0.2));
  const flightViewProgress = Math.min(flightViewIn, flightViewOut);
  const flightAnimationIn = clamp((flightTriggerY - flightRect.top) / Math.max(1, viewportHeight * 0.12));
  const flightAnimationOut = clamp((flightRect.bottom - viewportHeight * 0.12) / Math.max(1, viewportHeight * 0.14));
  const flightAnimationVisibility = Math.min(flightAnimationIn, flightAnimationOut);
  const deerVisibility = 1 - flightAnimationIn;
  const densitySectionProgress = Math.min(densityIn, densityOut);
  const densityViewProgress = Math.max(densitySectionProgress, flightViewProgress);
  setDensityView(densityViewProgress, deerVisibility, flightViewProgress);
  setFlightProgress(reducedMotion ? 1 : flightProgress, reducedMotion ? flightViewProgress : flightAnimationVisibility);
  setFlightTheme(flightViewProgress);
  const coverageRect = coverage.getBoundingClientRect();
  const coverageDotsIn = clamp((viewportHeight * 0.82 - coverageRect.top) / Math.max(1, coverageRect.height * 0.2));
  const coverageDotsOut = clamp((coverageRect.bottom - viewportHeight * 0.38) / Math.max(1, coverageRect.height * 0.2));
  const coverageDotsProgress = Math.min(coverageDotsIn, coverageDotsOut);
  setTargetDotVisibility(Math.max(densityViewProgress, coverageDotsProgress));

  const pageProgress = window.scrollY / Math.max(1, document.documentElement.scrollHeight - viewportHeight);
  mapMount.style.opacity = String(Math.max(clamp(1 - pageProgress * 0.8, 0.22, 1), densityViewProgress * 0.95));
  siteHeader.classList.toggle("is-scrolled", window.scrollY > 32);
}

function requestScrollUpdate() {
  if (scrollTicking) return;
  scrollTicking = true;
  requestAnimationFrame(updateScrollStory);
}

window.addEventListener("scroll", requestScrollUpdate, { passive: true });
window.addEventListener("resize", requestScrollUpdate, { passive: true });
document.getElementById("year").textContent = new Date().getFullYear();
updateScrollStory();
