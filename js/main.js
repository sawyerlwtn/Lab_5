// ==========================================
// Lab 5: Turf.js Spatial Analysis Main Logic
// ==========================================

// Global state variables
let map;
let statesGeoJson; // Processed GeoJSON
let layerGroupCount;
let layerGroupRates;
let layerGroupSymbols;
let activeLayer = 'count';

// Dynamic Classification Breaks
let countBreaks = [];
let rateBreaks = [];

// Base map setup
map = L.map('map', {
    zoomControl: false // Move to bottom right so it doesn't overlap title
}).setView([39.8283, -98.5795], 4); // Center of US

L.control.zoom({
    position: 'bottomright'
}).addTo(map);

// Add a dark minimal basemap (CartoDB Dark Matter)
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
	attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
	subdomains: 'abcd',
	maxZoom: 20
}).addTo(map);

// ==========================================
// 1. Data Fetching and Initialization
// ==========================================

async function initialize() {
    try {
        // Fetch both datasets concurrently
        const [statesRaw, airportsRaw] = await Promise.all([
            fetch('data/us-states.json').then(r => r.json()),
            fetch('data/airports.geojson').then(r => r.json())
        ]);

        console.log("Raw States Features:", statesRaw.features.length);
        console.log("Raw Airports:", airportsRaw.features.length);

        // Perform spatial analysis using Turf.js
        processSpatialData(statesRaw, airportsRaw);
        
        // Build the three visual layers
        buildLayers();
        
        // Setup UI interactivity
        setupUI();
        
        // Set initial display state
        updateMapDisplay();
        
    } catch (err) {
        console.error("Error loading data:", err);
        document.getElementById('legend').innerHTML = "<p style='color:red;'>Error loading data. Check console.</p>";
    }
}

// ==========================================
// 2. Spatial Analysis (Turf.js)
// ==========================================

function processSpatialData(statesRaw, airportsRaw) {
    // We modify statesRaw in-place by adding new properties
    
    // To speed up Turf.js computation, we can pre-filter airports roughly to US bounds
    const usBounds = turf.bboxPolygon([-125, 24, -66, 49]); 
    const isHawaiiOrAlaska = airport => {
        const coords = airport.geometry.coordinates;
        // Rough bounds for AK/HI
        return (coords[0] < -130) || (coords[0] > 170 && coords[1] > 50); 
    };
    
    const usAirportsRaw = airportsRaw.features.filter(f => {
        // Quick bounding box check or special states
        const insideContiguous = turf.booleanPointInPolygon(f, usBounds);
        return insideContiguous || isHawaiiOrAlaska(f);
    });
    
    const turfUSAirports = turf.featureCollection(usAirportsRaw);

    // Analyze each state polygon
    statesRaw.features.forEach(state => {
        // 1. Point in Polygon Count (How many airports in this state?)
        const ptsWithin = turf.pointsWithinPolygon(turfUSAirports, state);
        const count = ptsWithin.features.length;
        
        // 2. Area Calculation (km²)
        const areaSqMeters = turf.area(state);
        const areaSqKm = areaSqMeters / 1000000;
        
        // 3. Normalization (Rates) -> Airports per 10,000 km²
        // (Multiplying by 10k so the numbers aren't tiny fractions)
        const density = (count / areaSqKm) * 10000;
        
        // Store computed values in the feature properties
        state.properties.airportCount = count;
        state.properties.areaKm2 = areaSqKm;
        state.properties.airportDensity = density;
    });

    statesGeoJson = statesRaw;

    // Calculate Natural Breaks (Jenks) classes dynamically
    const counts = statesRaw.features.map(f => f.properties.airportCount);
    const densities = statesRaw.features.map(f => f.properties.airportDensity);

    // Using simple-statistics ckmeans (Jenks optimization) to find 5 classes for counts
    // For counts, Jenks makes sense to isolate massive outliers like TX/CA
    const countClusters = ss.ckmeans(counts, 5);
    countBreaks = countClusters.map(cluster => cluster[cluster.length - 1]);

    // For rates, Jenks often clumps too many states into the bottom tier because
    // of a few massive density outliers (like small eastern states/DC).
    // Quantile ensures exactly 20% of states fall into each color class, maximizing visual contrast.
    rateBreaks = [
        ss.quantile(densities, 0.2),
        ss.quantile(densities, 0.4),
        ss.quantile(densities, 0.6),
        ss.quantile(densities, 0.8),
        Math.max(...densities) // max value
    ];
}

// ==========================================
// 3. Layer Building & Styling
// ==========================================

// Color Schemes (5 classes each)
const COUNT_COLORS = ['#ffeda0', '#feb24c', '#fd8d3c', '#e31a1c', '#800026'];

// Helper to find the color based on Jenks breaks
function getCountColor(d) {
    if (d <= countBreaks[0]) return COUNT_COLORS[0];
    if (d <= countBreaks[1]) return COUNT_COLORS[1];
    if (d <= countBreaks[2]) return COUNT_COLORS[2];
    if (d <= countBreaks[3]) return COUNT_COLORS[3];
    return COUNT_COLORS[4];
}

const RATE_COLORS = ['#f1eef6', '#bdc9e1', '#74a9cf', '#2b8cbe', '#045a8d'];

function getRateColor(d) {
    if (d <= rateBreaks[0]) return RATE_COLORS[0];
    if (d <= rateBreaks[1]) return RATE_COLORS[1];
    if (d <= rateBreaks[2]) return RATE_COLORS[2];
    if (d <= rateBreaks[3]) return RATE_COLORS[3];
    return RATE_COLORS[4];
}

function styleCount(feature) {
    return {
        fillColor: getCountColor(feature.properties.airportCount),
        weight: 1,
        opacity: 1,
        color: 'rgba(255,255,255,0.3)', // subtle white border
        fillOpacity: 0.8
    };
}

function styleRate(feature) {
    return {
        fillColor: getRateColor(feature.properties.airportDensity),
        weight: 1,
        opacity: 1,
        color: 'rgba(255,255,255,0.3)',
        fillOpacity: 0.8
    };
}

// Tooltip helper
function onEachStateFeature(feature, layer) {
    const props = feature.properties;
    layer.bindTooltip(`
        <strong>${props.name}</strong><br>
        Airports: ${props.airportCount}<br>
        Density: ${props.airportDensity.toFixed(2)} per 10k km²
    `, { sticky: true, direction: 'top' });
    
    // Highlight on hover
    layer.on({
        mouseover: function(e) {
            const l = e.target;
            l.setStyle({ weight: 2, color: '#fff', fillOpacity: 1 });
            l.bringToFront();
        },
        mouseout: function(e) {
            if (activeLayer === 'count') {
                layerGroupCount.resetStyle(e.target);
            } else if (activeLayer === 'rates') {
                layerGroupRates.resetStyle(e.target);
            }
        }
    });
}

function buildLayers() {
    // LAYER 1: Count Choropleth
    layerGroupCount = L.geoJson(statesGeoJson, {
        style: styleCount,
        onEachFeature: onEachStateFeature
    });

    // LAYER 2: Rates Choropleth
    layerGroupRates = L.geoJson(statesGeoJson, {
        style: styleRate,
        onEachFeature: onEachStateFeature
    });

    // LAYER 3: Proportional Symbols
    // First, we need a base layer of states so the map isn't totally black
    const baseStates = L.geoJson(statesGeoJson, {
        style: { fillColor: '#333', color: '#555', weight: 1, fillOpacity: 0.5 },
        interactive: false
    });

    // Compute centroids and create point markers
    const symbolFeatures = statesGeoJson.features.map(state => {
        // Turf centroid
        const centroid = turf.centroid(state);
        // Transfer properties so we know the count
        centroid.properties = state.properties;
        return centroid;
    });

    const symbols = L.geoJson(symbolFeatures, {
        pointToLayer: function(feature, latlng) {
            const count = feature.properties.airportCount;
            // Radius scaling: square root to scale area proportionally, min size 2, multiplied by scalar
            // User requested larger symbols, bumped scalar from 2.5 to 4.5
            const radius = count === 0 ? 0 : Math.max(4, Math.sqrt(count) * 4.5);
            
            return L.circleMarker(latlng, {
                radius: radius,
                fillColor: '#ff5722',
                color: '#fff',
                weight: 1.5,
                opacity: 0.9,
                fillOpacity: 0.6
            }).bindPopup(`
                <h3>${feature.properties.name}</h3>
                <p><strong>${count}</strong> total airports</p>
            `);
        }
    });

    // Group the base states and the circles into one layer group
    layerGroupSymbols = L.layerGroup([baseStates, symbols]);
}

// ==========================================
// 4. Interaction & UI Updates
// ==========================================

function setupUI() {
    document.getElementById('btn-count').addEventListener('click', () => {
        activeLayer = 'count';
        updateMapDisplay();
    });
    
    document.getElementById('btn-rates').addEventListener('click', () => {
        activeLayer = 'rates';
        updateMapDisplay();
    });
    
    document.getElementById('btn-symbols').addEventListener('click', () => {
        activeLayer = 'symbols';
        updateMapDisplay();
    });
}

function updateMapDisplay() {
    // 1. Remove all existing layers
    map.removeLayer(layerGroupCount);
    map.removeLayer(layerGroupRates);
    map.removeLayer(layerGroupSymbols);
    
    // 2. Update button active states
    document.querySelectorAll('#control-panel button').forEach(b => b.classList.remove('active'));
    document.getElementById(`btn-${activeLayer}`).classList.add('active');

    // 3. Add active layer to map & update legend
    const legendDiv = document.getElementById('legend');
    
    // Helper to format breaks for legend
    const getBreakRange = (breaks, index, minVal) => {
        const lower = index === 0 ? minVal : breaks[index - 1] + 0.01;
        const upper = breaks[index];
        
        // Formatting function based on whether it's integer (count) or float (density)
        const format = (num) => Number.isInteger(minVal) ? Math.round(num) : num.toFixed(2);
        
        return `${format(lower)} - ${format(upper)}`;
    };

    if (activeLayer === 'count') {
        const minCount = Math.min(...statesGeoJson.features.map(f => f.properties.airportCount));
        
        layerGroupCount.addTo(map);
        legendDiv.innerHTML = `
            <h4>Airport Count (Natural Breaks)</h4>
            <div class="legend-item"><div class="color-box" style="background:${COUNT_COLORS[0]}"></div> ${getBreakRange(countBreaks, 0, minCount)}</div>
            <div class="legend-item"><div class="color-box" style="background:${COUNT_COLORS[1]}"></div> ${getBreakRange(countBreaks, 1, minCount)}</div>
            <div class="legend-item"><div class="color-box" style="background:${COUNT_COLORS[2]}"></div> ${getBreakRange(countBreaks, 2, minCount)}</div>
            <div class="legend-item"><div class="color-box" style="background:${COUNT_COLORS[3]}"></div> ${getBreakRange(countBreaks, 3, minCount)}</div>
            <div class="legend-item"><div class="color-box" style="background:${COUNT_COLORS[4]}"></div> > ${Math.round(countBreaks[3])}</div>
            <p style="color:#aaa; font-size:0.8em; margin-top:10px;">Raw count of airports within<br>state boundaries.</p>
        `;
    } 
    else if (activeLayer === 'rates') {
        const minRate = Math.min(...statesGeoJson.features.map(f => f.properties.airportDensity));
        
        layerGroupRates.addTo(map);
        legendDiv.innerHTML = `
            <h4>Airport Rates (Quantiles)</h4>
            <div class="legend-item"><div class="color-box" style="background:${RATE_COLORS[0]}"></div> ${getBreakRange(rateBreaks, 0, minRate)}</div>
            <div class="legend-item"><div class="color-box" style="background:${RATE_COLORS[1]}"></div> ${getBreakRange(rateBreaks, 1, minRate)}</div>
            <div class="legend-item"><div class="color-box" style="background:${RATE_COLORS[2]}"></div> ${getBreakRange(rateBreaks, 2, minRate)}</div>
            <div class="legend-item"><div class="color-box" style="background:${RATE_COLORS[3]}"></div> ${getBreakRange(rateBreaks, 3, minRate)}</div>
            <div class="legend-item"><div class="color-box" style="background:${RATE_COLORS[4]}"></div> > ${rateBreaks[3].toFixed(2)}</div>
            <p style="color:#aaa; font-size:0.8em; margin-top:10px;">Airports per 10,000 km².<br>Ranked into 5 equal groups (Quantiles).</p>
        `;
    }
    else if (activeLayer === 'symbols') {
        layerGroupSymbols.addTo(map);
        legendDiv.innerHTML = `
            <h4>Proportional Symbols</h4>
            <div class="legend-item">
                <div class="symbol-box"><div class="symbol-circle" style="width:10px; height:10px;"></div></div> Small
            </div>
            <div class="legend-item">
                <div class="symbol-box"><div class="symbol-circle" style="width:20px; height:20px;"></div></div> Medium
            </div>
            <div class="legend-item">
                <div class="symbol-box"><div class="symbol-circle" style="width:34px; height:34px;"></div></div> Large
            </div>
            <p style="color:#aaa; font-size:0.8em; margin-top:10px;">Circle area is directly proportional<br>to airport count.</p>
        `;
    }
}

// Kick it off
document.addEventListener('DOMContentLoaded', initialize);
