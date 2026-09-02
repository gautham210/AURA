const { TrafficEngine, BaselineController } = require('../backend/trafficEngine');

const config = { C: 60, lost_time: 6, G_min: 10, gap_out_seconds: 5, S: 0.5 };
const aura = new TrafficEngine(config);
const baseline = new BaselineController(config);

const approaches = ["NORTHBOUND", "SOUTHBOUND", "EASTBOUND", "WESTBOUND"];
const phases = [["NORTHBOUND", "SOUTHBOUND"], ["EASTBOUND", "WESTBOUND"]];

aura.initJunction('J1', phases);
baseline.initJunction('J1', phases);

console.log("Testing equilibrium with reasonable arrival rate (0.15 PCU/s)...");
for (let t = 0; t < 120; t++) {
    // Arrival: 1 car every 6 seconds on average (0.16 PCU/s)
    const arr = {};
    approaches.forEach(app => {
        arr[app] = { counts: { car: (t % 6 === 0 ? 1 : 0) } };
    });
    
    aura.tick('J1', arr);
    baseline.tick('J1', arr);
}

const auraState = aura.getJunctionState('J1');
const baseState = baseline.getJunctionState('J1');

console.log("AURA J1 queues:", JSON.stringify(Object.fromEntries(Object.entries(auraState.approaches).map(([k,v]) => [k, v.queue_pcu]))));
console.log("Baseline J1 queues:", JSON.stringify(Object.fromEntries(Object.entries(baseState.approaches).map(([k,v]) => [k, v.queue_pcu]))));
console.log("AURA avg delays:", JSON.stringify(Object.fromEntries(Object.entries(auraState.approaches).map(([k,v]) => [k, v.avg_delay_seconds]))));
console.log("Baseline avg delays:", JSON.stringify(Object.fromEntries(Object.entries(baseState.approaches).map(([k,v]) => [k, v.avg_delay_seconds]))));
