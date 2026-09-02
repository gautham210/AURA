const fs = require('fs');
const { RoutingEngine } = require('../backend/routingEngine');
const graph = JSON.parse(fs.readFileSync('backend/graph.json', 'utf8'));
const { TrafficEngine, BaselineController } = require('../backend/trafficEngine');

const routingEngine = new RoutingEngine(graph);
const aura = new TrafficEngine({ C: 60, lost_time: 6, G_min: 10, gap_out_seconds: 5, S: 0.5 });
const junctionIds = graph.controlledJunctions.map(j => j.id);
const phases = [["NORTHBOUND", "SOUTHBOUND"], ["EASTBOUND", "WESTBOUND"]];

junctionIds.forEach(jid => aura.initJunction(jid, phases));

// Simulate some traffic state
junctionIds.forEach(jid => {
    let arrivals = {};
    if (jid === 'J2' || jid === 'J3') {
        arrivals["EASTBOUND"] = { counts: { car: 30 } }; // heavy queue
    }
    aura.tick(jid, arrivals);
});

const networkState = junctionIds.map(jid => {
    return {
        junction_id: jid,
        aura: aura.getJunctionState(jid)
    };
});

function testRoute(name, originNodeId, destNodeId) {
    console.log(`\n================================`);
    console.log(`TEST ROUTE: ${name}`);
    console.log(`================================`);
    // Find closest valid node if string IDs aren't exact matches in edges
    let oId = originNodeId;
    let dId = destNodeId;
    
    // Quick fallback
    if (!routingEngine.adj[oId]) {
        const j = graph.controlledJunctions.find(j=>j.id === oId);
        if (j) oId = j.osmNodeId;
    }
    
    const result = routingEngine.findRoutes(oId, dId, networkState);
    if (!result || !result.aura || !result.aura.estimatedTime) {
        console.log("ROUTE NOT FOUND OR NO ETA!");
        return;
    }
    
    const r = result.aura;
    console.log(`Distance: ${r.distance.toFixed(0)} meters (${r.distanceKm} km)`);
    console.log(`Base Travel Time: ${r.baseTravelTime.toFixed(0)} sec`);
    console.log(`Signal Delay: ${r.signalDelay.toFixed(0)} sec`);
    console.log(`Congestion Delay: ${r.congestionDelay.toFixed(0)} sec`);
    console.log(`AURA Penalty: ${r.auraPenalty.toFixed(0)} sec`);
    console.log(`Final ETA: ${r.estimatedTime.toFixed(0)} sec (${Math.ceil(r.estimatedTime / 60)} minutes)`);
    console.log(`Junctions Passed: ${r.controlledJunctionsPassed.map(j=>j.id).join(', ')}`);
}

// A: Palarivattom Junction (J1) to Ernakulam South (approx Node 277170472)
// B: Edappally Junction (near J3) to Vyttila
// C: Kaloor Junction (J4) to Marine Drive

testRoute("A: Palarivattom -> Ernakulam South", "J1", "344035009");
testRoute("B: Edappally -> Vyttila", "J3", "2923377480"); 
testRoute("C: Kaloor -> Marine Drive", "J4", "1907420171");

console.log(`\nAll phase 5 route tests completed.\n`);
