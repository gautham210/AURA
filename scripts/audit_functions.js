const fs = require('fs');
const appJs = fs.readFileSync('frontend/app.js', 'utf8');

// Find all function calls in appJs: identifier(
const callRegex = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g;
const calledFuncs = new Set();
let match;
while ((match = callRegex.exec(appJs)) !== null) {
    calledFuncs.add(match[1]);
}

// Find all defined functions/methods/classes
const defRegex = /\b(?:function\s+([a-zA-Z0-9_$]+)|class\s+([a-zA-Z0-9_$]+)|const\s+([a-zA-Z0-9_$]+)\s*=\s*(?:\([^)]*\)|[a-zA-Z0-9_$]+)\s*=>)/g;
const defs = new Set();
while ((match = defRegex.exec(appJs)) !== null) {
    if (match[1]) defs.add(match[1]);
    if (match[2]) defs.add(match[2]);
    if (match[3]) defs.add(match[3]);
}

const standardGlobals = new Set([
    'WebSocket', 'AuraStateStore', 'initMap', 'populateRoutingSelects', 'updateTopMetrics',
    'updateMapMarkers', 'updateGreenWavePanel', 'updateDataSourceLabel', 'renderJunctionDetail',
    'switchMode', 'highlightMarker', 'drawHospitalPOIs', 'drawControlledJunctions',
    'initTrafficVisualization', 'renderTrafficVis', 'resizeCanvas', 'selectJunction',
    'generateAuraExplanation', 'startEmergencySimulation', 'handleEmergencyRoute',
    'endEmergencySimulation', 'getDistanceMeters', 'setOriginLocation', 'setDestinationLocation',
    'drawRoutePolylines', 'handleRouteResult', 'animateAmbulance',
    // Built-ins:
    'alert', 'setTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame',
    'fetch', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
    'decodeURIComponent', 'Boolean', 'Number', 'String', 'Array', 'Object', 'Function',
    'Math', 'Date', 'RegExp', 'Error', 'JSON', 'Promise', 'Set', 'Map',
    'require', 'console', 'document', 'window', 'Option', 'performance', 'navigator', 'L'
]);

for (const fn of calledFuncs) {
    if (!defs.has(fn) && !standardGlobals.has(fn)) {
        // check if it's a method call like obj.fn() or property access
        const isMethod = new RegExp(`\\.\\s*${fn}\\s*\\(`).test(appJs);
        if (!isMethod) {
            console.log('POTENTIALLY UNDEFINED GLOBAL FUNCTION CALLED:', fn);
        }
    }
}
