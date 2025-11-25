import {
  ageInDays,
  geo,
  haversineMiles,
  posFromHash,
  pushMap,
  sigmoid,
} from './shared.js'

// Global Init
const map = L.map('map', { worldCopyJump: true }).setView([47.76837, -122.06078], 10);
const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© OpenStreetMap contributors'
}).addTo(map);

// Control state
let repeaterRenderMode = 'hit';
let repeaterSearch = '';
let showSamples = false;

// Data
let nodes = null; // Graph data from the last refresh
let idToRepeaters = null; // Index of id -> [repeater]
let hashToCoverage = null; // Index of geohash -> coverage
let edgeList = null; // List of connected repeater and coverage

// Map layers
let coverageLayer = L.layerGroup().addTo(map);
let edgeLayer = L.layerGroup().addTo(map);
let sampleLayer = L.layerGroup().addTo(map);
let repeaterLayer = L.layerGroup().addTo(map);

// Map controls
const mapControl = L.control({ position: 'topright' });
mapControl.onAdd = m => {
  const div = L.DomUtil.create('div', 'mesh-control leaflet-control');

  div.innerHTML = `
    <div class="mesh-control-row">
      <label>
        Repeaters:
        <select id="repeater-filter-select">
          <option value="all">All</option>
          <option value="hit" selected="true">Hit</option>
          <option value="none">None</option>
        </select>
      </label>
    </div>
    <div class="mesh-control-row">
      <label>
        Find Id:
        <input type="text" id="repeater-search" />
      </label>
    </div>
    <div class="mesh-control-row">
      <label>
        Show Samples:
        <input type="checkbox" id="show-samples" />
      </label>
    </div>
    <div class="mesh-control-row">
      <button type="button" id="refresh-map-button">Refresh map</button>
    </div>
  `;

  div.querySelector("#repeater-filter-select")
    .addEventListener("change", (e) => {
      repeaterRenderMode = e.target.value;
      updateAllRepeaterMarkers();
    });

  div.querySelector("#repeater-search")
    .addEventListener("input", (e) => {
      repeaterSearch = e.target.value.toLowerCase();
      updateAllRepeaterMarkers();
    });

  div.querySelector("#show-samples")
    .addEventListener("change", (e) => {
      showSamples = e.target.checked;
      sampleLayer.eachLayer(s => updateSampleMarkerVisibility(s));
    });

  div.querySelector("#refresh-map-button")
    .addEventListener("click", () => refreshCoverage());


  // Don’t let clicks on the control bubble up and pan/zoom the map.
  L.DomEvent.disableClickPropagation(div);
  L.DomEvent.disableScrollPropagation(div);

  return div;
};

mapControl.addTo(map);

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function coverageMarker(coverage) {
  const [minLat, minLon, maxLat, maxLon] = geo.decode_bbox(coverage.hash);
  const color = coverage.heard > 0 ? '#398821' : '#E04748';
  const totalSamples = coverage.heard + coverage.lost;
  const heardRatio = coverage.heard / totalSamples;
  const date = new Date(coverage.lastHeard);
  const opacity = 0.75 * sigmoid(totalSamples, 1.2, 2) * (heardRatio > 0 ? heardRatio : 1);
  const style = {
    color: color,
    weight: 1,
    fillOpacity: Math.max(opacity, 0.1),
  };
  const rect = L.rectangle([[minLat, minLon], [maxLat, maxLon]], style);
  const details = `
    <strong>${coverage.hash}</strong><br/>
    Heard: ${coverage.heard} Lost: ${coverage.lost} (${(100 * heardRatio).toFixed(0)}%)<br/>
    Updated: ${date.toLocaleString()}
    ${coverage.hitRepeaters.size === 0 ? '' : '<br/>Repeaters: ' + coverage.hitRepeaters.join(',')}`;

  rect.coverage = coverage;
  rect.bindPopup(details, { maxWidth: 320 });
  rect.on('popupopen', e => updateAllEdgeVisibility(e.target.coverage));
  rect.on('popupclose', () => updateAllEdgeVisibility());

  if (window.matchMedia("(hover: hover)").matches) {
    rect.on('mouseover', e => updateAllEdgeVisibility(e.target.coverage));
    rect.on('mouseout', () => updateAllEdgeVisibility());
  }

  coverage.marker = rect;
  return rect;
}

function sampleMarker(s) {
  const [lat, lon] = posFromHash(s.hash);
  const color = s.path.length > 0 ? '#07ac07' : '#e96767';
  const style = { radius: 5, weight: 1, color: color, fillOpacity: .8 };
  const marker = L.circleMarker([lat, lon], style);
  const date = new Date(s.time);
  const details = `
    ${lat.toFixed(4)}, ${lon.toFixed(4)}<br/>
    ${date.toLocaleString()}
    ${s.path.length === 0 ? '' : '<br/>Hit: ' + s.path.join(',')}`;
  marker.bindPopup(details, { maxWidth: 320 });
  marker.on('add', () => updateSampleMarkerVisibility(marker));
  return marker;
}

function repeaterMarker(r) {
  const stale = ageInDays(r.time) > 2;
  const dead = ageInDays(r.time) > 8;
  const ageClass = (dead ? "dead" : (stale ? "stale" : ""));
  const icon = L.divIcon({
    className: '', // Don't use default Leaflet style.
    html: `<div class="repeater-dot ${ageClass}"><span>${r.id}</span></div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10]
  });
  const details = [
    `<strong>${escapeHtml(r.name)} [${r.id}]</strong>`,
    `${r.lat.toFixed(4)}, ${r.lon.toFixed(4)} · <em>${(r.elev).toFixed(0)}m</em>`,
    `${new Date(r.time).toLocaleString()}`
  ].join('<br/>');
  const marker = L.marker([r.lat, r.lon], { icon: icon });

  marker.repeater = r;
  marker.bindPopup(details, { maxWidth: 320 });
  marker.on('add', () => updateRepeaterMarkerVisibility(marker));
  marker.on('popupopen', e => updateAllEdgeVisibility(e.target.repeater));
  marker.on('popupclose', () => updateAllEdgeVisibility());

  if (window.matchMedia("(hover: hover)").matches) {
    marker.on('mouseover', e => updateAllEdgeVisibility(e.target.repeater));
    marker.on('mouseout', () => updateAllEdgeVisibility());
  }

  r.marker = marker;
  return marker;
}

function getBestRepeater(fromPos, repeaterList) {
  if (repeaterList.length === 1) {
    return repeaterList[0];
  }

  let minRepeater = null;
  let minDist = 30000; // Bigger than any valid dist.

  repeaterList.forEach(r => {
    const to = [r.lat, r.lon];
    const elev = r.elev ?? 0; // Allow height to impact distance.
    const dist = haversineMiles(fromPos, to) - (0.5 * Math.sqrt(elev));
    if (dist < minDist) {
      minDist = dist;
      minRepeater = r;
    }
  });

  return minRepeater;
}

function shouldShowRepeater(r) {
  // Prioritize searching
  if (repeaterSearch !== '') {
    return r.id.toLowerCase().startsWith(repeaterSearch);
  } else if (repeaterRenderMode === "hit") {
    return r.hitBy.length > 0;
  } else if (repeaterRenderMode === 'none') {
    return false;
  }
  return true;
}

function updateSampleMarkerVisibility(s) {
  const el = s.getElement();
  if (showSamples) {
    el.classList.remove("hidden");
    el.classList.add("leaflet-interactive");
  } else {
    el.classList.add("hidden");
    el.classList.remove("leaflet-interactive");
  }
}

function updateRepeaterMarkerVisibility(m, forceVisible = false, highlight = false) {
  const el = m.getElement();
  if (forceVisible || shouldShowRepeater(m.repeater)) {
    el.classList.remove("hidden");
    el.classList.add("leaflet-interactive");
  } else {
    el.classList.add("hidden");
    el.classList.remove("leaflet-interactive");
  }

  if (highlight) {
    el.querySelector(".repeater-dot").classList.add("highlighted");
  } else {
    el.querySelector(".repeater-dot").classList.remove("highlighted");
  }
}

function updateAllRepeaterMarkers() {
  repeaterLayer.eachLayer(m => updateRepeaterMarkerVisibility(m));
}

function updateCoverageMarkerHighlight(m, highlight = false) {
  const el = m.getElement();
  if (highlight) {
    el.classList.add("highlighted-path");
  } else {
    el.classList.remove("highlighted-path");
  }
}

function updateAllCoverageMarkers() {
  coverageLayer.eachLayer(m => updateCoverageMarkerHighlight(m));
}

function updateAllEdgeVisibility(end) {
  const markersToOverride = [];
  const coverageToHighlight = [];

  // Reset markers to default.
  updateAllRepeaterMarkers();
  updateAllCoverageMarkers();

  edgeLayer.eachLayer(e => {
    if (end !== undefined && e.ends.includes(end)) {
      // e.ends is [repeater, coverage]
      markersToOverride.push(e.ends[0].marker);
      coverageToHighlight.push(e.ends[1].marker);
      e.setStyle({ opacity: 0.6 });
    } else {
      e.setStyle({ opacity: 0 });
    }
  });

  // Force connected repeaters to be shown.
  markersToOverride.forEach(m => updateRepeaterMarkerVisibility(m, true, true));

  // Highlight connected coverage markers.
  coverageToHighlight.forEach(m => updateCoverageMarkerHighlight(m, true));
}

function renderNodes(nodes) {
  coverageLayer.clearLayers();
  edgeLayer.clearLayers();
  sampleLayer.clearLayers();
  repeaterLayer.clearLayers();

  // Add coverage boxes.
  hashToCoverage.entries().forEach(([key, coverage]) => {
    coverageLayer.addLayer(coverageMarker(coverage));
  });

  // Add recent samples.
  nodes.samples.forEach(s => {
    sampleLayer.addLayer(sampleMarker(s));
  });

  // Add repeaters.
  const repeatersToAdd = [...idToRepeaters.values()].flat();
  repeatersToAdd.forEach(r => {
    repeaterLayer.addLayer(repeaterMarker(r));
  });

  // Add edges.
  edgeList.forEach(e => {
    const style = {
      weight: 2,
      opacity: 0,
      dashArray: '2,4',
      interactive: false,
    };
    const line = L.polyline([e.repeater.pos, e.coverage.pos], style);
    line.ends = [e.repeater, e.coverage];
    line.addTo(edgeLayer);
  });
}

function buildIndexes(nodes) {
  hashToCoverage = new Map();
  idToRepeaters = new Map();
  edgeList = [];

  // Index coverage items.
  nodes.coverage.forEach(c => {
    const { latitude: lat, longitude: lon } = geo.decode(c.hash);
    c.pos = [lat, lon];
    hashToCoverage.set(c.hash, c);
  });

  // Add samples to coverage items.
  // TODO: shared helper for coverage ctor.
  nodes.samples.forEach(s => {
    const key = s.hash.substring(0, 6);
    let coverage = hashToCoverage.get(key);
    if (!coverage) {
      const { latitude: lat, longitude: lon } = geo.decode(key);
      coverage = {
        hash: key,
        pos: [lat, lon],
        heard: 0,
        lost: 0,
        lastHeard: 0,
        hitRepeaters: [],
      };
      hashToCoverage.set(key, coverage);
    }

    const heard = s.path.length > 0;
    coverage.heard += heard ? 1 : 0;
    coverage.lost += !heard ? 1 : 0;
    coverage.lastHeard = Math.max(coverage.lastHeard, s.time);
    s.path.forEach(p => {
      if (!coverage.hitRepeaters.includes(p))
        coverage.hitRepeaters.push(p);
    });
  });

  // Index repeaters.
  nodes.repeaters.forEach(r => {
    r.hitBy = [];
    r.pos = [r.lat, r.lon];
    pushMap(idToRepeaters, r.id, r);
  });

  // Build connections.
  hashToCoverage.entries().forEach(([key, coverage]) => {
    coverage.hitRepeaters.forEach(r => {
      const candidateRepeaters = idToRepeaters.get(r);
      if (candidateRepeaters === undefined)
        return;

      const bestRepeater = getBestRepeater(coverage.pos, candidateRepeaters);
      bestRepeater.hitBy.push(coverage);
      edgeList.push({ repeater: bestRepeater, coverage: coverage });
    });
  });
}

export async function refreshCoverage() {
  const endpoint = "/get-nodes";
  const resp = await fetch(endpoint, { headers: { 'Accept': 'application/json' } });

  if (!resp.ok)
    throw new Error(`HTTP ${resp.status} ${resp.statusText}`);

  nodes = await resp.json();
  buildIndexes(nodes);
  renderNodes(nodes);
}
