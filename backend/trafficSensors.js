const seedrandom = require('seedrandom');

class SimulationSensor {
  constructor(seed = "AURA_DEMO_SEED") {
    this.rng = seedrandom(seed);
    this.currentDemand = {};
  }

  tick(junctionIds, approaches) {
    const r = this.rng(); // Advance RNG exactly once per tick
    for (const j of junctionIds) {
      if (!this.currentDemand[j]) this.currentDemand[j] = {};
      for (const a of approaches) {
        // Deterministic pseudo-random based on the single tick RNG value, junction and approach
        const pseudoRandom = Math.abs(Math.sin(r * 1000000 + j.charCodeAt(0) + a.charCodeAt(0))) % 1;
        const hasVehicle = pseudoRandom < 0.3; // 30% chance per second
        let counts = { two_wheeler: 0, auto_rickshaw: 0, car: 0, bus: 0 };
        if (hasVehicle) {
          const typeRand = Math.abs(Math.cos(pseudoRandom * 1000000)) % 1;
          if (typeRand < 0.5) counts.two_wheeler = 1;
          else if (typeRand < 0.7) counts.auto_rickshaw = 1;
          else if (typeRand < 0.9) counts.car = 1;
          else counts.bus = 1;
        }
        this.currentDemand[j][a] = {
          junctionId: j,
          approach: a,
          counts: counts,
          sourceMode: "SIMULATED"
        };
      }
    }
  }

  getApproachState(junctionId, approach) {
    if (!this.currentDemand[junctionId] || !this.currentDemand[junctionId][approach]) {
       return { junctionId, approach, counts: { two_wheeler: 0, auto_rickshaw: 0, car: 0, bus: 0 }, sourceMode: "SIMULATED" };
    }
    return this.currentDemand[junctionId][approach];
  }
}

module.exports = { SimulationSensor };
