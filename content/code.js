// Global Init
const map = L.map('map', { worldCopyJump: true }).setView([47.76837, -122.06078], 10);
const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© OpenStreetMap contributors'
}).addTo(map);

let sampleLayer = L.layerGroup().addTo(map);
let repeaterLayer = L.layerGroup().addTo(map);
let edgeLayer = L.layerGroup().addTo(map);

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
  const color = '#0a66c2';
  const style = { radius: 6, weight: 2, color: color, fillOpacity: .25 };
  const marker = L.circleMarker([r.lat, r.lon], style);
  const details = [
    `<strong>${escapeHtml(r.name)} [${r.id}]</strong>`,
    `${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}`
  ].join('<br/>');
  marker.bindPopup(details, { maxWidth: 320 });
  return marker;
}

function renderNodes(nodes) {
  sampleLayer.clearLayers();
  repeaterLayer.clearLayers();
  edgeLayer.clearLayers();
  const outEdges = [];
  const idToRepeater = new Map();

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
    idToRepeater.set(r.id, [r.lat, r.lon]);
  });

  outEdges.forEach(edge => {
    const to = idToRepeater.get(edge.id);

    if (to === undefined) {
      console.log(`Missing repeater ${edge.id}`);
    } else {
      const from = edge.pos;
      L.polyline([from, to], { weight: 2, opacity: 0.8, dashArray: '4,6' }).addTo(edgeLayer);
    }
  });
}

async function refreshCoverage() {
  const endpoint = "/get-nodes";
  const resp = await fetch(endpoint, { headers: { 'Accept': 'application/json' } });

  if (!resp.ok)
    throw new Error(`HTTP ${resp.status} ${resp.statusText}`);

  const nodes = await resp.json();
  renderNodes(nodes);
}
