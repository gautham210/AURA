/**
 * AURA — Adaptive Urban Routing Architecture
 * Authoritative Traffic Signal Control Engine
 * 
 * Conceptual Model:
 * 4-Approach Junction with Compatible Movement Groups:
 * - PHASE A (NORTH_SOUTH): Northbound + Southbound compatible through movements
 * - PHASE B (EAST_WEST): Eastbound + Westbound compatible through movements
 * 
 * Dynamic Allocation Principle:
 * "Don't just optimize the intersection. Control what reaches it."
 * 
 * Safety Constraints:
 * - Conflicting movement groups (NS vs EW) must NEVER simultaneously receive green.
 * - Clearance lost time and minimum green floors (G_min) are strictly enforced.
 * - Emergency preemption follows an authoritative state machine:
 *   NORMAL -> CLEARING -> EMERGENCY_GREEN -> RECOVERY -> NORMAL
 */

class TrafficEngine {
    constructor(config) {
        this.config = {
            C: config.C || 60,
            lost_time: config.lost_time || 6,
            G_min: config.G_min || 10,
            gap_out_seconds: config.gap_out_seconds || 5,
            S: config.S || 0.8, // 0.8 PCU/s discharge rate (~2880 PCU/h multi-lane capacity)
            PCU_WEIGHTS: {
                two_wheeler: 0.5,
                auto_rickshaw: 1.0,
                car: 1.0,
                bus: 3.0,
                'Two-wheeler': 0.5, 'bicycle': 0.5, 'Three-wheeler': 1.0,
                'Hatchback': 1.0, 'Sedan': 1.0, 'SUV': 1.0, 'Van': 1.0, 'Others': 1.0, 'LCV': 1.0,
                'MUV': 3.0, 'Bus': 3.0, 'Truck': 3.0, 'Mini-bus': 3.0, 'tempo-traveller': 3.0
            }
        };

        // State for each junction
        this.state = {};
    }

    initJunction(junctionId, phases) {
        // Safe movement groups:
        // Phase 0 (NORTH_SOUTH): ["NORTHBOUND", "SOUTHBOUND"]
        // Phase 1 (EAST_WEST):   ["EASTBOUND", "WESTBOUND"]
        const phaseNames = ["NORTH_SOUTH", "EAST_WEST"];

        this.state[junctionId] = {
            phases: phases,
            phaseNames: phaseNames,
            currentPhaseIndex: 0,
            phaseTimeRemaining: 0,
            phaseDurations: [30, 30],
            approaches: {},
            downstreamUtilization: 0,
            downstreamSpillbackActive: false,
            backPressureMultiplier: 1.0,
            backPressureLevel: 0, 
            spillbackEvents: 0,
            emergency: {
                active: false,
                approach: null,
                state: 'NORMAL', // NORMAL | CLEARING | EMERGENCY_GREEN | RECOVERY
                timer: 0
            }
        };

        for (const phaseApproaches of phases) {
            for (const approach of phaseApproaches) {
                this.state[junctionId].approaches[approach] = {
                    q: 0,
                    max_q: 0,
                    storageCapacity: 12.0, // Physical storage capacity in PCU
                    spillbackActive: false,
                    spillbackEvents: 0,
                    totalAccumulatedDelay: 0,
                    totalVehiclesArrived: 0,
                    emptySeconds: 0, // for gap-out
                    signalState: "RED"
                };
            }
        }
        
        // Initial allocation and signal states for Phase 0
        this.allocateGreens(junctionId, {});
        for (let i = 0; i < phases.length; i++) {
            const isGreen = (i === this.state[junctionId].currentPhaseIndex);
            for (const app of phases[i]) {
                this.state[junctionId].approaches[app].signalState = isGreen ? "GREEN" : "RED";
            }
        }
    }

    calculatePCU(counts) {
        if (!counts) return 0;
        let pcu = 0;
        pcu += (counts.two_wheeler || 0) * this.config.PCU_WEIGHTS.two_wheeler;
        pcu += (counts.auto_rickshaw || 0) * this.config.PCU_WEIGHTS.auto_rickshaw;
        pcu += (counts.car || 0) * this.config.PCU_WEIGHTS.car;
        pcu += (counts.bus || 0) * this.config.PCU_WEIGHTS.bus;
        
        // Check alternate class keys from YOLO model
        for (const [k, v] of Object.entries(counts)) {
            if (this.config.PCU_WEIGHTS[k] && !['two_wheeler', 'auto_rickshaw', 'car', 'bus'].includes(k)) {
                pcu += (v || 0) * this.config.PCU_WEIGHTS[k];
            }
        }
        return pcu;
    }

    getBackPressureMultiplier(utilization) {
        if (utilization < 0.60) return 1.00;
        if (utilization < 0.75) return 0.90;
        if (utilization < 0.85) return 0.70;
        if (utilization < 0.95) return 0.40;
        return 0.15;
    }

    getBackPressureLevel(utilization) {
        if (utilization < 0.60) return 0;
        if (utilization < 0.75) return 1;
        if (utilization < 0.85) return 2;
        if (utilization < 0.95) return 3;
        return 4;
    }

    updateBackPressure(junctionId, downstreamUtilization) {
        const junction = this.state[junctionId];
        if (!junction) return;
        junction.downstreamUtilization = downstreamUtilization;
        const newLevel = this.getBackPressureLevel(downstreamUtilization);
        
        // Spillback event transition semantics: rising-edge trigger on saturation threshold
        const isSaturated = (downstreamUtilization >= 0.90);
        if (!junction.downstreamSpillbackActive && isSaturated) {
            junction.spillbackEvents += 1;
        }
        junction.downstreamSpillbackActive = isSaturated;
        junction.backPressureLevel = newLevel;
        junction.backPressureMultiplier = this.getBackPressureMultiplier(downstreamUtilization);
    }

    setEmergencyPreemption(junctionId, approach, bufferTicks) {
        const junction = this.state[junctionId];
        if (!junction) return;

        if (approach) {
            junction.emergency.active = true;
            junction.emergency.approach = approach;
            if (bufferTicks === 'STANDBY') {
                junction.emergency.state = 'EMERGENCY_STANDBY';
                junction.emergency.timer = 0;
            } else if (bufferTicks === 0) {
                junction.emergency.state = 'EMERGENCY_GREEN';
                junction.emergency.timer = 0;
                
                let targetPhase = null;
                for (const phase of junction.phases) {
                    if (phase.includes(approach)) {
                        targetPhase = phase;
                        break;
                    }
                }
                
                for (const phase of junction.phases) {
                    for (const app of phase) {
                        junction.approaches[app].signalState = (targetPhase && targetPhase.includes(app)) ? "GREEN" : "RED";
                    }
                }
            } else {
                // Activate: Enter CLEARING for safety clearance (bufferTicks, default 3), then transition to EMERGENCY_GREEN
                junction.emergency.state = 'CLEARING';
                junction.emergency.timer = bufferTicks !== undefined ? bufferTicks : 3;
                // Immediate safety clearing: all signals RED
                for (const phase of junction.phases) {
                    for (const app of phase) {
                        junction.approaches[app].signalState = "RED";
                    }
                }
            }
        } else {
            if (junction.emergency.active) {
                if (bufferTicks === 0) {
                    junction.emergency.active = false;
                    junction.emergency.approach = null;
                    junction.emergency.state = 'NORMAL';
                    junction.emergency.timer = 0;
                } else {
                    // Deactivate: Enter RECOVERY for clearance (bufferTicks, default 2), then return to NORMAL
                    junction.emergency.state = 'RECOVERY';
                    junction.emergency.timer = bufferTicks !== undefined ? bufferTicks : 2;
                    for (const phase of junction.phases) {
                        for (const app of phase) {
                            junction.approaches[app].signalState = "RED";
                        }
                    }
                }
            } else {
                junction.emergency.active = false;
                junction.emergency.approach = null;
                junction.emergency.state = 'NORMAL';
                junction.emergency.timer = 0;
            }
        }
    }

    allocateGreens(junctionId, demandPCU) {
        const junction = this.state[junctionId];
        const G_available = this.config.C - this.config.lost_time; // 60 - 6 = 54s
        const K = junction.phases.length; // 2 phases
        const G_floor_total = this.config.G_min * K; // 10 * 2 = 20s
        const G_remaining = Math.max(0, G_available - G_floor_total); // 34s

        junction.phaseDurations = [];
        let P_total = 0;
        let phaseDemands = [];

        for (let i = 0; i < K; i++) {
            let pPhase = 0;
            for (const app of junction.phases[i]) {
                const pcu = demandPCU[app] || 0;
                pPhase += pcu * junction.backPressureMultiplier; // Effective demand with backpressure metering
            }
            phaseDemands.push(pPhase);
            P_total += pPhase;
        }

        for (let i = 0; i < K; i++) {
            let G_k;
            if (P_total === 0) {
                G_k = Math.round(this.config.G_min + G_remaining * (1 / K));
            } else {
                G_k = Math.round(this.config.G_min + G_remaining * (phaseDemands[i] / P_total));
            }
            // Enforce minimum floor
            G_k = Math.max(this.config.G_min, G_k);
            junction.phaseDurations.push(G_k);
        }
        
        junction.phaseTimeRemaining = junction.phaseDurations[junction.currentPhaseIndex];
    }

    tick(junctionId, arrivals) {
        const junction = this.state[junctionId];
        if (!junction) return;
        
        // --- 1. Gap-out Evaluation on Active Movement Group ---
        let currentPhaseEmpty = true;
        for (const app of junction.phases[junction.currentPhaseIndex]) {
            const arr = arrivals[app] || { counts: {} };
            const lambda = this.calculatePCU(arr.counts);
            if (junction.approaches[app].q > 0 || lambda > 0) {
                currentPhaseEmpty = false;
                junction.approaches[app].emptySeconds = 0;
            } else {
                junction.approaches[app].emptySeconds += 1;
            }
        }

        let gapOutTriggered = false;
        if (currentPhaseEmpty) {
            let allEmptyLongEnough = true;
            for (const app of junction.phases[junction.currentPhaseIndex]) {
                if (junction.approaches[app].emptySeconds < this.config.gap_out_seconds) {
                    allEmptyLongEnough = false;
                }
            }
            if (allEmptyLongEnough && junction.phaseTimeRemaining > 0) {
                gapOutTriggered = true;
            }
        }

        // --- 2. Emergency Preemption vs Normal Phase Control ---
        if (junction.emergency.active && junction.emergency.state !== 'EMERGENCY_STANDBY') {
            if (junction.emergency.state === 'CLEARING') {
                for (let i = 0; i < junction.phases.length; i++) {
                    for (const app of junction.phases[i]) junction.approaches[app].signalState = "RED";
                }
                junction.emergency.timer--;
                if (junction.emergency.timer <= 0) {
                    junction.emergency.state = 'EMERGENCY_GREEN';
                    
                    let targetPhase = null;
                    for (const phase of junction.phases) {
                        if (phase.includes(junction.emergency.approach)) {
                            targetPhase = phase;
                            break;
                        }
                    }
                    // Authoritative preemption green: priority phase gets GREEN
                    for (let i = 0; i < junction.phases.length; i++) {
                        for (const app of junction.phases[i]) {
                            junction.approaches[app].signalState = (targetPhase && targetPhase.includes(app)) ? "GREEN" : "RED";
                        }
                    }
                }
            } else if (junction.emergency.state === 'EMERGENCY_GREEN') {
                let targetPhase = null;
                for (const phase of junction.phases) {
                    if (phase.includes(junction.emergency.approach)) {
                        targetPhase = phase;
                        break;
                    }
                }
                for (let i = 0; i < junction.phases.length; i++) {
                    for (const app of junction.phases[i]) {
                        junction.approaches[app].signalState = (targetPhase && targetPhase.includes(app)) ? "GREEN" : "RED";
                    }
                }
            } else if (junction.emergency.state === 'RECOVERY') {
                for (let i = 0; i < junction.phases.length; i++) {
                    for (const app of junction.phases[i]) junction.approaches[app].signalState = "RED";
                }
                junction.emergency.timer--;
                if (junction.emergency.timer <= 0) {
                    junction.emergency.active = false;
                    junction.emergency.state = 'NORMAL';
                    junction.emergency.approach = null;
                }
            }
        } else {
            // --- Normal AURA Adaptive Signal Phase Cycle ---
            if (gapOutTriggered || junction.phaseTimeRemaining <= 0) {
                // Advance to next compatible movement phase
                junction.currentPhaseIndex = (junction.currentPhaseIndex + 1) % junction.phases.length;
                if (junction.currentPhaseIndex === 0) {
                    // Reallocate dynamic greens at start of new cycle based on current approach queues
                    let demandPCU = {};
                    for (let i = 0; i < junction.phases.length; i++) {
                        for (const app of junction.phases[i]) {
                            demandPCU[app] = junction.approaches[app].q;
                        }
                    }
                    this.allocateGreens(junctionId, demandPCU);
                } else {
                    junction.phaseTimeRemaining = junction.phaseDurations[junction.currentPhaseIndex];
                }
            } else {
                junction.phaseTimeRemaining -= 1;
            }

            // Apply authoritative signal states for active movement phase
            for (let i = 0; i < junction.phases.length; i++) {
                const isGreenPhase = (i === junction.currentPhaseIndex);
                for (const app of junction.phases[i]) {
                    junction.approaches[app].signalState = isGreenPhase ? "GREEN" : "RED";
                }
            }
        }

        // --- 3. Queue & Delay Physics Model ---
        for (const phaseApproaches of junction.phases) {
            for (const app of phaseApproaches) {
                const approachState = junction.approaches[app];
                const arr = arrivals[app] || { counts: {} };
                const lambda = this.calculatePCU(arr.counts);
                
                let mu = 0;
                if (approachState.signalState === "GREEN") {
                    mu = Math.min(approachState.q + lambda, this.config.S);
                }

                approachState.q = Math.max(0, approachState.q + lambda - mu);
                approachState.max_q = Math.max(approachState.max_q, approachState.q);
                
                approachState.totalVehiclesArrived += lambda;
                approachState.totalAccumulatedDelay += approachState.q * 1; // Delay = queue length (PCU) * 1s

                // Rising-edge physical spillback evaluation on storage capacity
                const isSpillback = (approachState.q >= approachState.storageCapacity);
                if (!approachState.spillbackActive && isSpillback) {
                    approachState.spillbackEvents += 1;
                    junction.spillbackEvents += 1;
                }
                approachState.spillbackActive = isSpillback;
            }
        }
    }

    getJunctionState(junctionId) {
        const junction = this.state[junctionId];
        if (!junction) return null;

        let activePhaseName = junction.phaseNames[junction.currentPhaseIndex];
        if (junction.emergency.active) {
            activePhaseName = junction.emergency.state; // CLEARING, EMERGENCY_GREEN, RECOVERY
        }

        const phaseDescriptions = {
            "NORTH_SOUTH": "Northbound + Southbound Through Movements",
            "EAST_WEST": "Eastbound + Westbound Through Movements",
            "EMERGENCY_STANDBY": "Standby for Incoming Emergency Vehicle",
            "CLEARING": "Safety Clearance (All Red Buffer)",
            "EMERGENCY_GREEN": `Emergency Priority (${junction.emergency.approach || 'Corridor'})`,
            "RECOVERY": "Post-Emergency Recovery Clearance"
        };

        const anySpillbackActive = Object.values(junction.approaches).some(a => a.spillbackActive) || !!junction.downstreamSpillbackActive;

        let state = {
            junction_id: junctionId,
            phase_name: activePhaseName,
            current_phase: junction.currentPhaseIndex + 1,
            current_phase_description: phaseDescriptions[activePhaseName] || activePhaseName,
            phase_durations: {
                "NORTH_SOUTH": junction.phaseDurations[0] || 30,
                "EAST_WEST": junction.phaseDurations[1] || 30
            },
            phase_time_remaining: junction.phaseTimeRemaining,
            back_pressure_multiplier: +(junction.backPressureMultiplier.toFixed(2)),
            spillback_events: junction.spillbackEvents,
            spillback_active: anySpillbackActive,
            emergency: {
                active: junction.emergency.active,
                state: junction.emergency.state,
                approach: junction.emergency.approach
            },
            approaches: {}
        };

        for (const phaseApproaches of junction.phases) {
            for (const app of phaseApproaches) {
                const aState = junction.approaches[app];
                const avgDelay = aState.totalVehiclesArrived > 0 ? (aState.totalAccumulatedDelay / aState.totalVehiclesArrived) : 0;
                state.approaches[app] = {
                    signal_state: aState.signalState, // Authoritative RED or GREEN
                    queue_pcu: +(aState.q.toFixed(2)),
                    max_queue_pcu: +(aState.max_q.toFixed(2)),
                    avg_delay_seconds: +(avgDelay.toFixed(1)),
                    spillback_active: aState.spillbackActive,
                    spillback_events: aState.spillbackEvents,
                    source_mode: aState.source_mode || "SIMULATED"
                };
            }
        }
        return state;
    }
}

/**
 * BaselineController — Offline Counterfactual Reference Model
 * 
 * NOTE: This class is strictly a counterfactual baseline for benchmark comparison.
 * It does NOT control signals, does NOT control vehicles, and does NOT issue commands.
 * It simulates a fixed 30s/30s un-adaptive pre-timed timer under the IDENTICAL demand stream
 * to evaluate AURA's delay reduction and spillback prevention.
 */
class BaselineController {
    constructor(config) {
        this.config = {
            phase1Duration: 30,
            phase2Duration: 30,
            S: config.S || 0.5,
            PCU_WEIGHTS: {
                two_wheeler: 0.5,
                auto_rickshaw: 1.0,
                car: 1.0,
                bus: 3.0
            }
        };
        this.state = {};
    }

    initJunction(junctionId, phases) {
        this.state[junctionId] = {
            phases: phases,
            currentPhaseIndex: 0,
            phaseTimeRemaining: this.config.phase1Duration,
            approaches: {},
            spillbackEvents: 0,
            emergency: {
                active: false,
                approach: null,
                state: 'NORMAL',
                timer: 0
            }
        };

        for (const phaseApproaches of phases) {
            for (const approach of phaseApproaches) {
                this.state[junctionId].approaches[approach] = {
                    q: 0,
                    max_q: 0,
                    totalAccumulatedDelay: 0,
                    totalVehiclesArrived: 0,
                    signalState: "RED"
                };
            }
        }

        for (let i = 0; i < phases.length; i++) {
            const isGreen = (i === this.state[junctionId].currentPhaseIndex);
            for (const app of phases[i]) {
                this.state[junctionId].approaches[app].signalState = isGreen ? "GREEN" : "RED";
            }
        }
    }

    calculatePCU(counts) {
        if (!counts) return 0;
        let pcu = 0;
        pcu += (counts.two_wheeler || 0) * this.config.PCU_WEIGHTS.two_wheeler;
        pcu += (counts.auto_rickshaw || 0) * this.config.PCU_WEIGHTS.auto_rickshaw;
        pcu += (counts.car || 0) * this.config.PCU_WEIGHTS.car;
        pcu += (counts.bus || 0) * this.config.PCU_WEIGHTS.bus;
        return pcu;
    }

    tick(junctionId, arrivals) {
        const junction = this.state[junctionId];
        if (!junction) return;

        // Fixed un-adaptive timer logic (30s / 30s)
        if (junction.phaseTimeRemaining <= 0) {
            junction.currentPhaseIndex = (junction.currentPhaseIndex + 1) % junction.phases.length;
            junction.phaseTimeRemaining = junction.currentPhaseIndex === 0 ? this.config.phase1Duration : this.config.phase2Duration;
        } else {
            junction.phaseTimeRemaining -= 1;
        }

        for (let i = 0; i < junction.phases.length; i++) {
            const isGreen = (i === junction.currentPhaseIndex);
            for (const app of junction.phases[i]) {
                junction.approaches[app].signalState = isGreen ? "GREEN" : "RED";
            }
        }

        for (const phaseApproaches of junction.phases) {
            for (const app of phaseApproaches) {
                const approachState = junction.approaches[app];
                const arr = arrivals[app] || { counts: {} };
                const lambda = this.calculatePCU(arr.counts);
                
                let mu = 0;
                if (approachState.signalState === "GREEN") {
                    mu = Math.min(approachState.q + lambda, this.config.S);
                }

                approachState.q = Math.max(0, approachState.q + lambda - mu);
                approachState.max_q = Math.max(approachState.max_q, approachState.q);
                
                approachState.totalVehiclesArrived += lambda;
                approachState.totalAccumulatedDelay += approachState.q * 1; 
            }
        }
    }

    getCounterfactualState(junctionId) {
        const junction = this.state[junctionId];
        if (!junction) return null;

        let totalDelay = 0;
        let totalArrived = 0;
        let maxQueue = 0;

        for (const phaseApproaches of junction.phases) {
            for (const app of phaseApproaches) {
                const a = junction.approaches[app];
                totalDelay += a.totalAccumulatedDelay;
                totalArrived += a.totalVehiclesArrived;
                if (a.q > maxQueue) maxQueue = a.q;
            }
        }

        const avgDelay = totalArrived > 0 ? (totalDelay / totalArrived) : 0;
        return {
            reference_model: "FIXED_30_30",
            avg_delay_seconds: +(avgDelay.toFixed(1)),
            max_queue_pcu: +(maxQueue.toFixed(1)),
            total_delay_seconds: +(totalDelay.toFixed(1))
        };
    }
}

module.exports = { TrafficEngine, BaselineController };
