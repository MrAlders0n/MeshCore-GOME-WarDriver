import { ageInDays, getNearest } from './shared.js'

// Global Init
const map = L.map('map', { worldCopyJump: true }).setView([47.76837, -122.06078], 10);
const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© OpenStreetMap contributors'
}).addTo(map);

let edgeLayer = L.layerGroup().addTo(map);
let sampleLayer = L.layerGroup().addTo(map);
let repeaterLayer = L.layerGroup().addTo(map);

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function sampleMarker(s) {
  const color = s.path.length > 0 ? '#07ac07' : '#e96767';
  const style = { radius: 6, weight: 1, color: color, fillOpacity: .9 };
  const marker = L.circleMarker([s.lat, s.lon], style);
  const date = new Date(s.time);
  const details = `${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}<br/>${date.toLocaleString()}`;
  marker.bindPopup(details, { maxWidth: 320 });
  return marker;
}

function repeaterMarker(r) {
  const stale = ageInDays(r.time) > 1;
  const dead = ageInDays(r.time) > 5;
  const ageClass = (dead ? "dead" : (stale ? "stale" : ""));
  const icon = L.divIcon({
    className: '', // Don't use default Leaflet style.
    html: `<div class="repeater-dot ${ageClass}"><span>${r.id}</span></div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10]
  });
  const marker = L.marker([r.lat, r.lon], { icon: icon });
  const details = [
    `<strong>${escapeHtml(r.name)} [${r.id}]</strong>`,
    `${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}`,
    `${new Date(r.time).toLocaleString()}`
  ].join('<br/>');
  marker.bindPopup(details, { maxWidth: 320 });
  return marker;
}

function renderNodes(nodes) {
  sampleLayer.clearLayers();
  repeaterLayer.clearLayers();
  edgeLayer.clearLayers();
  const outEdges = [];
  const idToRepeaters = new Map();

  nodes.samples.forEach(s => {
    sampleLayer.addLayer(sampleMarker(s));
    s.path.forEach(p => {
      outEdges.push({ id: p, pos: [s.lat, s.lon] });
    });
  });

  nodes.repeaters.forEach(r => {
    repeaterLayer.addLayer(repeaterMarker(r));
    r.path.forEach(p => {
      outEdges.push({ id: p, pos: [r.lat, r.lon] });
    });
    const repeaterList = idToRepeaters.get(r.id) ?? [];
    repeaterList.push([r.lat, r.lon]);
    idToRepeaters.set(r.id, repeaterList);
  });

  // TODO: render paths only when hovered over a sample.

  outEdges.forEach(edge => {
    const toList = idToRepeaters.get(edge.id);

    if (toList === undefined) {
      console.log(`Missing repeater ${edge.id}`);
    } else {
      const from = edge.pos;
      const to = getNearest(from, toList);
      L.polyline([from, to], { weight: 2, opacity: 0.8, dashArray: '1,6' }).addTo(edgeLayer);
    }
  });
}

export async function refreshCoverage() {
  const endpoint = "/get-nodes";
  const resp = await fetch(endpoint, { headers: { 'Accept': 'application/json' } });

  if (!resp.ok)
    throw new Error(`HTTP ${resp.status} ${resp.statusText}`);

  const nodes = await resp.json();
  renderNodes(nodes);
}
