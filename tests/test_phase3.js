const { HybridSensor, SimulationSensor } = require('../backend/trafficSensors');
const assert = require('assert');

function runPhase3Tests() {
    console.log("=== PHASE 3 BACKEND PROOF ===");

    const sim = new SimulationSensor("TEST_SEED");
    const hybrid = new HybridSensor(sim, 2000); // 2 sec timeout
    
    // Simulate tick to populate sim sensor
    hybrid.tick(["J1"], ["NORTHBOUND"]);
    
    // Fallback mode initially
    let state = hybrid.getApproachState("J1", "NORTHBOUND");
    assert.strictEqual(state.sourceMode, "SIMULATED");
    
    // Inject vision data
    hybrid.injectVisionData("J1", "NORTHBOUND", { counts: { car: 2, bus: 1 } }, "LIVE");
    state = hybrid.getApproachState("J1", "NORTHBOUND");
    assert.strictEqual(state.sourceMode, "LIVE");
    assert.strictEqual(state.counts.car, 2);
    
    // Since getApproachState consumes the new arrivals, the next call immediately after should have empty counts, but still LIVE
    let state2 = hybrid.getApproachState("J1", "NORTHBOUND");
    assert.strictEqual(state2.sourceMode, "LIVE");
    assert.strictEqual(state2.counts.car, undefined); // Cleared
    
    // Simulate timeout (wait 2.1 seconds)
    hybrid.lastSeen["J1"]["NORTHBOUND"] = Date.now() - 3000;
    
    // Should fallback to SIMULATED
    let state3 = hybrid.getApproachState("J1", "NORTHBOUND");
    assert.strictEqual(state3.sourceMode, "SIMULATED");
    
    console.log("HYBRID SENSOR FALLBACK: PASS");
    console.log("NEW ARRIVAL CONSUMPTION: PASS");
    console.log("SOURCE MODE PRESERVATION: PASS");
}

runPhase3Tests();
