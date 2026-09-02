const { RoutingEngine } = require('./routingEngine');

class DemoTrafficController {
    constructor(trafficEngine, graphData) {
        this.trafficEngine = trafficEngine;
        this.graph = graphData;
        this.routingEngine = new RoutingEngine(graphData);
        
        this.active = false;
        this.elapsedSeconds = 0;
        this.timerInterval = null;
        
        this.emergency = {
            active: false,
            hospital: null,
            route: null,
            routeGeometry: [],
            totalDistance: 0,
            distanceTraveled: 0,
            speed: 15, // m/s for ambulance (~54 km/h)
            currentJunctionTarget: null,
            junctionsRemaining: []
        };
        
        this.onEmergencyUpdate = null; // Callback for server.js to broadcast
    }
    
    start() {
        if (this.active) return;
        this.reset();
        this.active = true;
        
        console.log("DEMO SIMULATION STARTED");
        this.timerInterval = setInterval(() => {
            this.tick();
        }, 1000);
    }
    
    pause() {
        this.active = false;
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
        console.log("DEMO SIMULATION PAUSED");
    }
    
    reset() {
        this.pause();
        this.elapsedSeconds = 0;
        this.emergency = {
            active: false,
            hospital: null,
            route: null,
            routeGeometry: [],
            totalDistance: 0,
            distanceTraveled: 0,
            speed: 15,
            currentJunctionTarget: null,
            junctionsRemaining: []
        };
        
        // Reset all emergency preemptions in traffic engine
        this.graph.controlledJunctions.forEach(j => {
            this.trafficEngine.setEmergencyPreemption(j.id, null);
            // Clear queues for reset
            if (this.trafficEngine.state[j.id]) {
                for(const app in this.trafficEngine.state[j.id].approaches) {
                    this.trafficEngine.state[j.id].approaches[app].q = 0;
                    this.trafficEngine.state[j.id].approaches[app].max_q = 0;
                }
            }
        });
        
        if (this.onEmergencyUpdate) this.onEmergencyUpdate({ active: false });
        console.log("DEMO SIMULATION RESET");
    }
    
    tick() {
        this.elapsedSeconds++;
        const t = this.elapsedSeconds;
        
        // Emergency Trigger at T=35s during full demo
        if (t === 35 && !this.emergency.active) {
            this.triggerEmergency();
        }
        
        // Process Emergency Movement
        if (this.emergency.active) {
            this.processEmergencyMovement();
        }
    }
    
    getSimulatedArrivals() {
        const arrivalsMap = {};
        const t = this.elapsedSeconds;
        if (!this.active) return arrivalsMap;

        // Structured congestion surge
        // T=0..10: Normal equilibrium (low demand)
        // T=11..35: Surge on arterial junctions J2, J3, J4
        // T=36..60: Moderating demand during emergency passage
        // T>60: Recovery to normal flow
        let baseDemand = 0;
        if (t >= 0 && t <= 10) baseDemand = 1;
        else if (t > 10 && t <= 45) baseDemand = 2;
        else baseDemand = 1;

        this.graph.controlledJunctions.forEach(j => {
            const junctionState = this.trafficEngine.state[j.id];
            if (!junctionState) return;
            
            arrivalsMap[j.id] = {};
            for (const phase of junctionState.phases) {
                for (const app of phase) {
                    let count = 0;
                    if (Math.random() < 0.25) {
                        count = Math.floor(Math.random() * baseDemand) + 1;
                    }
                    // Deliberate bottleneck surge on Palarivattom/Kaloor during surge phase
                    if (t > 10 && t <= 35 && (j.id === 'J2' || j.id === 'J3') && (app === 'NORTHBOUND' || app === 'SOUTHBOUND')) {
                        count = 2;
                    }
                    
                    arrivalsMap[j.id][app] = { counts: { car: count } };
                }
            }
        });
        return arrivalsMap;
    }
    
    triggerEmergency(customOrigin) {
        console.log("TRIGGERING EMERGENCY SIMULATION");
        
        let originNode = null;
        if (customOrigin && customOrigin.lat && customOrigin.lng) {
            const nearest = this.routingEngine.findNearestEdge(customOrigin.lat, customOrigin.lng);
            if (nearest && nearest.edge) {
                originNode = this.graph.nodes.find(n => n.id === nearest.edge.to);
            }
        }
        
        if (!originNode) {
            // Pick a realistic origin inside the Kochi road network
            const possibleOrigins = this.graph.nodes.filter(n => n.id !== "277170472" && !this.graph.pois.find(p => p.nearestNode === n.id));
            originNode = possibleOrigins[Math.floor(Math.random() * possibleOrigins.length)];
        }
        
        const hospitals = this.graph.pois.filter(p => p.type === 'hospital' || p.type === 'clinic');
        
        // Find nearest hospital by graph distance
        let bestHospital = null;
        let shortestDist = Infinity;
        let bestRoute = null;
        
        const emptyState = [];
        hospitals.forEach(h => {
            const destNode = h.nearestNode;
            if (!destNode) return;
            const res = this.routingEngine.findRoutes(originNode.id, destNode, emptyState);
            if (res && res.individual && res.individual.distance < shortestDist) {
                shortestDist = res.individual.distance;
                bestHospital = h;
                bestRoute = res.individual;
            }
        });
        
        if (!bestHospital || !bestRoute) return;
        
        this.emergency = {
            active: true,
            hospital: bestHospital.name,
            route: bestRoute,
            routeGeometry: bestRoute.geometry || [],
            totalDistance: bestRoute.distance,
            distanceTraveled: 0,
            speed: 15,
            currentJunctionTarget: null,
            junctionsRemaining: [...bestRoute.controlledJunctionsPassed] // { id, name }
        };
        
        // If timer is not running, start standalone emergency movement timer
        if (!this.timerInterval) {
            this.timerInterval = setInterval(() => {
                if (this.emergency.active) {
                    this.processEmergencyMovement();
                } else if (!this.active) {
                    clearInterval(this.timerInterval);
                    this.timerInterval = null;
                }
            }, 1000);
        }
        
        // Broadcast start
        if (this.onEmergencyUpdate) {
            this.onEmergencyUpdate({
                active: true,
                hospital: bestHospital.name,
                distanceRemaining: bestRoute.distance,
                geometry: bestRoute.geometry,
                currentPos: bestRoute.geometry.length > 0 ? bestRoute.geometry[0] : [originNode.lat, originNode.lng],
                junctionsRemaining: this.emergency.junctionsRemaining.length
            });
        }
    }
    
    processEmergencyMovement() {
        const em = this.emergency;
        em.distanceTraveled += em.speed;
        
        if (em.distanceTraveled >= em.totalDistance) {
            // Reached destination
            em.active = false;
            if (this.onEmergencyUpdate) this.onEmergencyUpdate({ active: false });
            // Clear all preemptions
            this.graph.controlledJunctions.forEach(j => this.trafficEngine.setEmergencyPreemption(j.id, null));
            return;
        }
        
        // Calculate current lat,lng based on distanceTraveled along routeGeometry
        let currentPos = null;
        let distAccum = 0;
        
        const dist2D = (p1, p2) => {
            const R = 6371000;
            const dLat = (p2[0]-p1[0])*Math.PI/180;
            const dLon = (p2[1]-p1[1])*Math.PI/180;
            const a = Math.sin(dLat/2)*Math.sin(dLat/2) + Math.cos(p1[0]*Math.PI/180)*Math.cos(p2[0]*Math.PI/180)*Math.sin(dLon/2)*Math.sin(dLon/2);
            return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        };

        for (let i = 0; i < em.routeGeometry.length - 1; i++) {
            const p1 = em.routeGeometry[i];
            const p2 = em.routeGeometry[i+1];
            const segmentDist = dist2D(p1, p2);
            if (distAccum + segmentDist >= em.distanceTraveled) {
                const ratio = (em.distanceTraveled - distAccum) / (segmentDist || 1);
                currentPos = [
                    p1[0] + (p2[0] - p1[0]) * ratio,
                    p1[1] + (p2[1] - p1[1]) * ratio
                ];
                break;
            }
            distAccum += segmentDist;
        }
        
        if (!currentPos && em.routeGeometry.length > 0) {
            currentPos = em.routeGeometry[em.routeGeometry.length - 1];
        }
        
        // Check distance to upcoming junctions and trigger preemption
        if (em.junctionsRemaining.length > 0) {
            const nextJunc = em.junctionsRemaining[0];
            const jData = this.graph.controlledJunctions.find(j => j.id === nextJunc.id);
            if (jData && currentPos) {
                const distToJunc = dist2D(currentPos, [jData.lat, jData.lng]);
                
                if (distToJunc < 250) { // Approaching junction: trigger CLEARING -> EMERGENCY_GREEN
                    const rNodes = em.route.route;
                    const jIdx = rNodes.findIndex(nid => nid === jData.osmNodeId || nid === jData.id);
                    let approachDir = "NORTHBOUND"; 
                    if (jIdx > 0) {
                        const fromNode = rNodes[jIdx - 1];
                        const edgeIn = this.graph.edges.find(e => e.from === fromNode && e.to === rNodes[jIdx]);
                        if (edgeIn && edgeIn.approachAtTarget) {
                            approachDir = edgeIn.approachAtTarget;
                        }
                    }
                    
                    this.trafficEngine.setEmergencyPreemption(jData.id, approachDir);
                }
                
                if (distToJunc < 30) {
                    em.junctionsRemaining.shift();
                    this.trafficEngine.setEmergencyPreemption(jData.id, null); // Transitions to RECOVERY -> NORMAL
                }
            }
        }
        
        // Broadcast update
        if (this.onEmergencyUpdate) {
            this.onEmergencyUpdate({
                active: true,
                hospital: em.hospital,
                distanceRemaining: Math.max(0, em.totalDistance - em.distanceTraveled),
                currentPos: currentPos,
                junctionsRemaining: em.junctionsRemaining.length
            });
        }
    }
}

module.exports = { DemoTrafficController };
