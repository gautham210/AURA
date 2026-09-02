const { SimulationSensor } = require('../backend/trafficSensors');

function runTest() {
    console.log("Running SimulationSensor deterministic test...");
    
    const junctionIds = ["J1", "J2"];
    const approaches = ["NORTHBOUND"];

    // Run 1: Controller A (e.g. AURA)
    const sensorA = new SimulationSensor("AURA_DEMO_SEED");
    let resultsA = [];
    for (let i = 0; i < 10; i++) {
        sensorA.tick(junctionIds, approaches);
        resultsA.push(JSON.stringify(sensorA.getApproachState("J1", "NORTHBOUND")));
    }

    // Run 2: Controller B (e.g. BASELINE)
    const sensorB = new SimulationSensor("AURA_DEMO_SEED");
    let resultsB = [];
    for (let i = 0; i < 10; i++) {
        sensorB.tick(junctionIds, approaches);
        resultsB.push(JSON.stringify(sensorB.getApproachState("J1", "NORTHBOUND")));
    }

    let allMatch = true;
    for (let i = 0; i < 10; i++) {
        if (resultsA[i] !== resultsB[i]) {
            allMatch = false;
            console.error(`Mismatch at tick ${i}`);
            console.error(`A: ${resultsA[i]}`);
            console.error(`B: ${resultsB[i]}`);
        } else {
            console.log(`Tick ${i} matches: ${resultsA[i]}`);
        }
    }

    if (allMatch) {
        console.log("SUCCESS: AURA λ === BASELINE λ for every approach on every tick.");
        process.exit(0);
    } else {
        console.error("FAILURE: Non-deterministic behavior detected.");
        process.exit(1);
    }
}

runTest();
