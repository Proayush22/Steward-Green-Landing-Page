import * as THREE from "three";
import { geoAlbersUsa, geoCentroid } from "d3-geo";
import { feature } from "topojson-client";
import statesTopology from "us-atlas/states-10m.json";
import "./style.css";

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const formatNumber = (value) => Math.round(value).toLocaleString("en-US");

const targetStates = [
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

const targetIndex = new Map(targetStates.map((state, index) => [state.fips, index]));
const mapState = {
  activeCount: -1,
  targetMeshes: new Map(),
  targetDots: new Map(),
  arcs: [],
};

function normalizeFips(value) {
  return String(value).padStart(2, "0");
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

  states.forEach((stateFeature) => {
    const fips = normalizeFips(stateFeature.id);
    const isTarget = targetIndex.has(fips);
    const geometry = geometryForFeature(stateFeature, projection);
    if (!geometry) return;

    const material = new THREE.MeshBasicMaterial({
      color: isTarget ? 0x406b4e : 0x1c3328,
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
        color: isTarget ? 0x93bf75 : 0x567262,
        transparent: true,
        opacity: isTarget ? 0.34 : 0.16,
        depthWrite: false,
      }),
    );
    edges.position.z = 0.012;
    mapGroup.add(edges);

    if (isTarget) {
      mapState.targetMeshes.set(fips, { material, edgeMaterial: edges.material });
      const center = projection(geoCentroid(stateFeature));
      if (center) {
        const dot = new THREE.Mesh(
          new THREE.CircleGeometry(0.045, 24),
          new THREE.MeshBasicMaterial({ color: 0xb7cd80, transparent: true, opacity: 0.1, depthWrite: false }),
        );
        dot.position.set(center[0], -center[1], 0.035);
        dot.scale.setScalar(0.2);
        mapGroup.add(dot);
        mapState.targetDots.set(fips, dot);
      }
    }
  });

  const originFeature = states.find((state) => normalizeFips(state.id) === "34");
  const originPoint = projection(geoCentroid(originFeature));
  if (originPoint) {
    targetStates.slice(1).forEach((state, index) => {
      const destinationFeature = states.find((candidate) => normalizeFips(candidate.id) === state.fips);
      const destinationPoint = destinationFeature ? projection(geoCentroid(destinationFeature)) : null;
      if (!destinationPoint) return;

      const start = new THREE.Vector3(originPoint[0], -originPoint[1], 0.05);
      const end = new THREE.Vector3(destinationPoint[0], -destinationPoint[1], 0.05);
      const midpoint = start.clone().lerp(end, 0.5);
      midpoint.z = 0.22 + start.distanceTo(end) * 0.08;
      const curve = new THREE.QuadraticBezierCurve3(start, midpoint, end);
      const points = curve.getPoints(54);
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      geometry.setDrawRange(0, 0);
      const line = new THREE.Line(
        geometry,
        new THREE.LineBasicMaterial({ color: 0xb7cd80, transparent: true, opacity: 0.34, depthWrite: false }),
      );
      mapGroup.add(line);
      mapState.arcs.push({ line, stateIndex: index + 1, pointCount: points.length });
    });
  }

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
    new THREE.PointsMaterial({ color: 0xb7cd80, size: 0.01, transparent: true, opacity: 0.14, depthWrite: false }),
  );
  scene.add(particles);

  const pointer = { x: 0, y: 0 };
  window.addEventListener("pointermove", (event) => {
    pointer.x = event.clientX / window.innerWidth - 0.5;
    pointer.y = event.clientY / window.innerHeight - 0.5;
  }, { passive: true });

  function resize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();

    if (width < 760) {
      mapGroup.position.set(0.1, 0.8, 0);
      mapGroup.scale.setScalar(0.88);
    } else if (width < 1080) {
      mapGroup.position.set(0.55, 0.1, 0);
      mapGroup.scale.setScalar(1.03);
    } else {
      mapGroup.position.set(1.35, 0.1, 0);
      mapGroup.scale.setScalar(1.13);
    }
  }

  function render(time) {
    const seconds = time * 0.001;
    const drift = reducedMotion ? 0 : Math.sin(seconds * 0.18) * 0.015;
    mapGroup.rotation.y += ((pointer.x * 0.06) - mapGroup.rotation.y) * 0.035;
    mapGroup.rotation.x += ((-0.08 - pointer.y * 0.035 + drift) - mapGroup.rotation.x) * 0.035;
    particles.rotation.z = reducedMotion ? 0 : seconds * 0.002;
    renderer.render(scene, camera);
    requestAnimationFrame(render);
  }

  resize();
  window.addEventListener("resize", resize, { passive: true });
  requestAnimationFrame(render);

  return { mapGroup, mount };
}

function setMapProgress(progress) {
  const activeCount = reducedMotion ? targetStates.length : Math.min(targetStates.length, Math.ceil(progress * targetStates.length));
  if (activeCount === mapState.activeCount) return;
  mapState.activeCount = activeCount;

  targetStates.forEach((state, index) => {
    const active = index < activeCount;
    const entry = mapState.targetMeshes.get(state.fips);
    if (entry) {
      entry.material.color.setHex(active ? 0x8fa969 : 0x3d5a47);
      entry.material.opacity = active ? 0.82 : 0.32;
      entry.edgeMaterial.color.setHex(active ? 0xb7cd80 : 0x829d6c);
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
      halo.addColorStop(0, `rgba(255, 120, 68, ${0.32 * heat.intensity})`);
      halo.addColorStop(0.3, `rgba(255, 199, 88, ${0.2 * heat.intensity})`);
      halo.addColorStop(0.62, `rgba(205, 224, 128, ${0.09 * heat.intensity})`);
      halo.addColorStop(1, "rgba(183, 205, 128, 0)");
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
      const red = Math.round(183 + 72 * heatStrength);
      const green = Math.round(205 - 79 * heatStrength);
      const blue = Math.round(128 - 64 * heatStrength);

      context.beginPath();
      context.arc(x, y, active ? radius * (1 + heatStrength * 1.15) : radius * 0.72, 0, Math.PI * 2);
      context.fillStyle = active
        ? `rgba(${red}, ${green}, ${blue}, ${0.84 + heatStrength * 0.16})`
        : "rgba(192, 218, 196, 0.1)";
      context.fill();

      if (active && (index % 17 === 0 || heatStrength > 0.64)) {
        context.beginPath();
        context.arc(x, y, radius * (2.8 + heatStrength * 1.8), 0, Math.PI * 2);
        context.strokeStyle = `rgba(255, 170, 82, ${0.1 + heatStrength * 0.24})`;
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

const { mount: mapMount } = createMapScene();
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
  const mapProgress = clamp(-mapRect.top / mapRange);
  setMapProgress(mapProgress);

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
