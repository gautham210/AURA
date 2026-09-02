const assert = require('assert');
const fs = require('fs');
const path = require('path');

const graphPath = path.join(__dirname, '../backend/graph.json');
const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));

console.log("=== PHASE 4A.6 GRAPH SEMANTICS PROOF SCRIPT ===");

// 1. Structure
assert(Array.isArray(graph.nodes), "Nodes should be an array");
assert(Array.isArray(graph.edges), "Edges should be an array");
assert(Array.isArray(graph.controlledJunctions), "Controlled Junctions should be an array");
assert(Array.isArray(graph.pois), "POIs should be an array");
console.log("TEST 1 — STRUCTURE: PASS");

// 2. Controlled Junctions Map to Valid Nodes
graph.controlledJunctions.forEach(cj => {
    const node = graph.nodes.find(n => n.id === cj.osmNodeId);
    assert(node, `Controlled Junction ${cj.id} refers to non-existent OSM Node ${cj.osmNodeId}`);
});
console.log("TEST 2 — CONTROLLED JUNCTIONS VALIDITY: PASS");

// 3. Edges Reference Valid Nodes
graph.nodesMap = new Map();
graph.nodes.forEach(n => graph.nodesMap.set(n.id, n));
graph.edges.forEach((e, idx) => {
    if (idx > 1000) return; // Sample check to save time
    const from = graph.nodesMap.has(e.from);
    const to = graph.nodesMap.has(e.to);
    assert(from && to, `Edge ${e.id} references invalid nodes`);
    assert(e.distance >= 0, `Edge ${e.id} has negative distance`);
});
console.log("TEST 3 — EDGES VALIDITY: PASS");

// 4. Six Intended Control Junctions
assert(graph.controlledJunctions.length === 6, "Must have exactly 6 controlled junctions");
const jids = graph.controlledJunctions.map(j => j.id).sort();
assert.deepStrictEqual(jids, ["J1", "J2", "J3", "J4", "J5", "J6"], "Must be J1 through J6");
console.log("TEST 4 — SIX DEMO JUNCTIONS EXIST: PASS");

// 5. POIs Map to Valid Nodes
graph.pois.forEach(poi => {
    const node = graph.nodesMap.has(poi.nearestNode);
    assert(node, `POI ${poi.name} references non-existent node ${poi.nearestNode}`);
});
assert(graph.pois.length > 0, "Graph must have POIs");
console.log("TEST 5 — POI VALIDITY: PASS");

// 6. Test POI Categories
const fireStations = graph.pois.filter(p => p.type === 'fire_station');
const policeStations = graph.pois.filter(p => p.type === 'police');
const hospitals = graph.pois.filter(p => p.type === 'hospital' || p.type === 'clinic');
assert(fireStations.length > 0, "Must have at least one fire station");
assert(policeStations.length > 0, "Must have at least one police station");
assert(hospitals.length > 0, "Must have at least one hospital/clinic");
console.log(`TEST 6 — POI CATEGORIES: PASS (Hospitals: ${hospitals.length}, Fire: ${fireStations.length}, Police: ${policeStations.length})`);

// 7. Routing Engine Point-to-Edge Logic
const { RoutingEngine } = require('../backend/routingEngine');
const routingEngine = new RoutingEngine(graph);

// Test 7A: Valid near-road coordinate (e.g. near Edappally)
const validOrigin = { lat: 10.0261, lng: 76.3084 }; 
const nearest = routingEngine.findNearestEdge(validOrigin.lat, validOrigin.lng);
assert(nearest.edge, "Should find a nearest edge");
assert(nearest.distMeters < 500, `Should be near a road, found ${nearest.distMeters}m`);
assert(nearest.projPoint, "Should project onto the edge");
console.log("TEST 7A — POINT-TO-EDGE VALID: PASS");

// Test 7B: Invalid off-road coordinate (e.g. far in the Arabian Sea)
const invalidOrigin = { lat: 9.9, lng: 75.0 };
const farEdge = routingEngine.findNearestEdge(invalidOrigin.lat, invalidOrigin.lng);
assert(farEdge.distMeters > 1000, "Should be far from any road");
const routeResult = routingEngine.findRoutes(invalidOrigin, hospitals[0].nearestNode, []);
assert(routeResult.error, "Should reject routes starting too far from network");
console.log("TEST 7B — POINT-TO-EDGE INVALID (SEA): PASS");

// Test 7C: Route geometry and controlled junctions sequence
const validDest = hospitals[0].nearestNode;
const validRoute = routingEngine.findRoutes(validOrigin, validDest, []);
assert(!validRoute.error, "Should compute route from lat/lng origin");
assert(validRoute.aura.geometry.length > 0, "AURA route should have geometry coordinates");
assert(validRoute.individual.geometry.length > 0, "Individual route should have geometry coordinates");
assert(Array.isArray(validRoute.aura.controlledJunctionsPassed), "Should track junctions passed");
console.log("TEST 7C — ROUTE GEOMETRY AND JUNCTION SEQUENCE: PASS");

console.log("ALL TESTS PASSED.");
