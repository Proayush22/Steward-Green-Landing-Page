import * as THREE from "three";
import { geoAlbersUsa, geoCentroid } from "d3-geo";
import { feature, neighbors } from "topojson-client";
import statesTopology from "us-atlas/states-10m.json";
import { getMapStoryProgress } from "./map-story-progress.js";
import "./style.css";

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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
    particles.rotation.z = reducedMotion ? 0 : seconds * 0.002;
    renderer.render(scene, camera);
    requestAnimationFrame(render);
  }

  resize();
  window.addEventListener("resize", resize, { passive: true });
  requestAnimationFrame(render);

  return { mapGroup, mount, setStoryView };
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

function createDeerField() {
  const canvas = document.getElementById("deer-canvas");
  const context = canvas.getContext("2d");
  const readout = document.getElementById("deer-count");
  const totalDots = 549;
  let activeDots = reducedMotion ? totalDots : 0;
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

  function randomFor(index) {
    const value = Math.sin(index * 12.9898 + 78.233) * 43758.5453;
    return value - Math.floor(value);
  }

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

    const columns = rect.width < 640 ? 19 : 31;
    const rows = Math.ceil(totalDots / columns);
    const marginX = rect.width < 640 ? 18 : 32;
    const marginY = 34;
    const spacingX = (rect.width - marginX * 2) / Math.max(1, columns - 1);
    const spacingY = (rect.height - marginY * 2) / Math.max(1, rows - 1);
    const radius = Math.max(1.7, Math.min(4.2, spacingX * 0.13));
    const heatRadius = Math.max(105, Math.min(190, rect.width * 0.18));

    if (heat.intensity > 0.01) {
      const halo = context.createRadialGradient(heat.x, heat.y, 0, heat.x, heat.y, heatRadius * 1.22);
      halo.addColorStop(0, `rgba(224, 69, 59, ${0.34 * heat.intensity})`);
      halo.addColorStop(0.3, `rgba(181, 58, 50, ${0.24 * heat.intensity})`);
      halo.addColorStop(0.62, `rgba(217, 104, 94, ${0.1 * heat.intensity})`);
      halo.addColorStop(1, "rgba(181, 58, 50, 0)");
      context.fillStyle = halo;
      context.fillRect(0, 0, rect.width, rect.height);
    }

    for (let index = 0; index < totalDots; index += 1) {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const offsetX = (randomFor(index) - 0.5) * spacingX * 0.34;
      const offsetY = (randomFor(index + 1000) - 0.5) * spacingY * 0.34;
      const x = marginX + column * spacingX + offsetX;
      const y = marginY + row * spacingY + offsetY;
      const active = index < activeDots;
      const distance = Math.hypot(x - heat.x, y - heat.y);
      const proximity = heat.intensity * Math.max(0, 1 - distance / heatRadius);
      const heatStrength = Math.pow(proximity, 1.45);
      const red = Math.round(196 + 55 * heatStrength);
      const green = Math.round(195 - 87 * heatStrength);
      const blue = Math.round(190 - 92 * heatStrength);

      context.beginPath();
      context.arc(x, y, active ? radius * (1 + heatStrength * 1.15) : radius * 0.72, 0, Math.PI * 2);
      context.fillStyle = active
        ? `rgba(${red}, ${green}, ${blue}, ${0.84 + heatStrength * 0.16})`
        : "rgba(210, 205, 202, 0.1)";
      context.fill();

      if (active && (index % 17 === 0 || heatStrength > 0.64)) {
        context.beginPath();
        context.arc(x, y, radius * (2.8 + heatStrength * 1.8), 0, Math.PI * 2);
        context.strokeStyle = `rgba(224, 69, 59, ${0.12 + heatStrength * 0.28})`;
        context.stroke();
      }
    }

    readout.textContent = formatNumber((activeDots / totalDots) * 54820);
  }

  function setProgress(progress) {
    activeDots = Math.round(totalDots * clamp(progress));
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

  const start = performance.now();
  const duration = 1250;
  function frame(now) {
    const progress = clamp((now - start) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    element.textContent = formatNumber(target * eased);
    if (progress < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

const { mount: mapMount, setStoryView } = createMapScene();
const deerField = createDeerField();
const mapStory = document.getElementById("reach");
const evidence = document.getElementById("evidence");
const flight = document.getElementById("flight");
const siteHeader = document.getElementById("site-header");
const flightRoute = document.getElementById("flight-route");

const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (!entry.isIntersecting) return;
    entry.target.classList.add("is-visible");
    entry.target.querySelectorAll?.("[data-counter]").forEach(animateCounter);
    if (entry.target.matches?.("[data-counter]")) animateCounter(entry.target);
    revealObserver.unobserve(entry.target);
  });
}, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });

document.querySelectorAll(".reveal, [data-counter]").forEach((element) => revealObserver.observe(element));

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

  const flightRect = flight.getBoundingClientRect();
  const flightProgress = clamp((viewportHeight * 0.78 - flightRect.top) / Math.max(1, flightRect.height * 0.52));
  flightRoute.style.setProperty("--route-progress", `${(reducedMotion ? 1 : flightProgress) * 100}%`);

  const pageProgress = window.scrollY / Math.max(1, document.documentElement.scrollHeight - viewportHeight);
  mapMount.style.opacity = String(clamp(1 - pageProgress * 0.8, 0.22, 1));
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
