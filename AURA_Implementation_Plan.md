# AURA — Full Implementation Plan
**AI-Assisted Urban Routing & Adaptive Traffic Control**
Team Mercedes — ASTRA 2026 (PS-05)

> **Don't just optimize the intersection. Control what reaches it.**
> AURA is a network-level traffic control system that combines real-time computer vision, adaptive signals, spillback protection, and congestion-aware routing to stop traffic jams from propagating through connected junctions — not just react to them one at a time.

---

## 1. System Architecture (Three Tiers)

```
┌─────────────────────┐   Event-driven WebSocket   ┌──────────────────────┐   Event-driven WebSocket   ┌──────────────────────┐
│   VISION LAYER       │ ─────────────────────────▶ │   BACKEND LAYER        │ ─────────────────────────▶ │   DASHBOARD LAYER      │
│   Python              │   VISION_DETECTION event   │   Node.js + Express     │   SIMULATED_TRAFFIC_       │   Browser (Leaflet +   │
│   YOLOv11-S + ByteTrack │                            │   + WebSocket server    │   STATE event              │   Canvas)              │
└─────────────────────┘                            └──────────────────────┘                             └──────────────────────┘
                                                            │
                                                            ▼
                                                   ┌──────────────────────┐
                                                   │  AURA GRAPH ENGINE     │
                                                   │  Own junction graph +   │
                                                   │  Dijkstra/A* (Section 8)│
                                                   │  (Future: external      │
                                                   │  routing API export)    │
                                                   └──────────────────────┘
```

Cadences differ deliberately and don't need to match: vision emits ~2Hz, the backend simulation ticks 1Hz, the frontend renders at 60fps via interpolation (Section 11). This is a single event-driven bus, not a fixed-interval pipeline — no component should assume another's tick rate.

**Note:** the routing layer is your own graph + pathfinding, not an external API (see Section 8, corrected from an earlier draft that assumed OSRM/ORS would accept live custom edge weights — it won't, without self-hosting). If a judge asks about scaling to commercial routing platforms, that's a stated future direction, not something currently wired in.

**Golden rule from the audit of the last build: nothing is allowed to run in isolation.** Every component must either emit to or consume from the WebSocket bus. No component gets to have its own private, disconnected simulation ever again.

---

## 2. Where AI Is Used (and where it is NOT)

| Layer | AI used? | What / How |
|---|---|---|
| Vehicle detection | ✅ Yes — **YOLOv11-S** (UVH-26 fine-tuned weights, `iisc-aim/UVH-26` on Hugging Face) | Real object detection on video frames, fine-tuned on Indian traffic-camera imagery (14 India-specific classes including auto-rickshaw) — not stock COCO, which has no auto-rickshaw class and underperforms on Indian traffic even for car/bus/truck. Classes re-mapped down into the 4 PCU buckets (Section 4). |
| Object tracking across frames | ✅ Yes — **ByteTrack** | Prevents double-counting the same vehicle across frames; gives smoother counts. |
| Signal timing decision | ❌ No ML — deterministic formula | PCU-weighted proportional split (Section 4). This is intentional: research confirms unconstrained RL is unstable under real-world anomalies. Don't call this "AI decision-making" in the pitch — call it what it is, an adaptive control algorithm. |
| Green-wave coordination | ❌ No ML — deterministic math | Stateless time-offset ticker (Section 5). |
| Congestion prediction | ❌ Not built (cut) | Real prediction (15-30 min ahead) needs historical time-series data you don't have. Don't claim "predictive AI" — claim "reactive, PCU-weighted adaptive control," which is honest and still beats a fixed timer. |
| Routing recommendation | ❌ No ML — classical pathfinding | Dijkstra/A* on our own graph does classical shortest-path routing with a congestion-weighted edge cost; you're not running any model, and it's not an external API call (see Section 8). |
| "AI insights" text (optional, low priority) | ⚠️ Optional, rule-based only | If you want narrative text in the UI, do template strings like the old build, but don't claim it's ML. |

**One sentence for the judges on "where's the AI":** *"AI is used specifically where it earns its place — real-time computer vision for vehicle detection and classification. Signal timing and coordination use deterministic, IRC-aligned traffic engineering formulas, because that's what's actually defensible and stable in the field — real ATCS systems like SCOOT and SCATS work the same way."* This is a stronger answer than pretending everything is "AI-powered."

---

## 3. Tech Stack

- **Vision:** Python, `ultralytics` (YOLOv11-S weights from `iisc-aim/UVH-26` on Hugging Face — Indian-traffic fine-tuned, fixes auto-rickshaw detection that was broken on stock COCO), OpenCV, ByteTrack (via `model.track()` — same API as YOLOv8, no pipeline change needed), `requests`/`websockets` client
- **Backend:** Node.js, Express, `ws` (WebSocket), TypeScript optional (JS is fine and faster for vibecoding)
- **Frontend:** Single `dashboard.html` — Leaflet.js (map), HTML5 Canvas (vehicle rendering, layered over Leaflet), vanilla JS or lightweight framework
- **Routing:** Own junction graph + Dijkstra/A* (Section 8) — no external routing API dependency during the demo
- **No database.** In-memory state only, same as last time — it's fine for a 24h demo, don't waste time on persistence.

---

## 4. Core Formula — PCU Score → Green Time

**⚠️ Corrected version.** The first draft of this formula applied `G_min` independently to every phase, which meant `ΣG_k` could exceed the cycle length (a 60s cycle producing 75s of green — an easy bug for a judge to catch). Fixed below by allocating from the actually-available green time, not from `G_max` per phase.

**PCU Weights** (based on common Indian traffic-engineering PCU conventions, configurable per junction — don't cite this as a specific IRC clause number under questioning; frame it as "reference values inspired by standard practice, calibrated for this deployment" if asked):
| Class | Weight |
|---|---|
| Two-wheeler | 0.5 |
| Auto-rickshaw | 1.0 |
| Car/SUV | 1.0 |
| Bus/Truck | 3.0 |

**Step A — Approach PCU:**
```
PCU_a = Σ (N_a,i × w_i)   for each vehicle class i on approach a
```

**Step B — Available Green Time:**
```
C            = cycle length (e.g. 60s)
lost_time    = Σ (yellow + all-red clearance) across all phases (e.g. 3s × K phases)
G_available  = C − lost_time
```

**Step C — Allocate available green proportionally, with a floor:**
```
G_min = configurable minimum phase green (junction-specific — see safety note below), e.g. 10s
K     = number of phases

// Reserve the floor for every phase first, then distribute what's left by demand share
G_floor_total = G_min × K
G_remaining   = max(0, G_available − G_floor_total)

G_k = G_min + G_remaining × (P_k / P_total)
```
This guarantees `Σ G_k = G_available` exactly (floor + demand-proportional remainder), so the cycle never overflows.

**Worked example** (2 phases, C = 60s, lost_time = 6s → G_available = 54s, G_min = 10s):
- Phase 1 (N-S): 12×0.5 + 4×1.0 + 6×1.0 + 2×3.0 = **22.0 PCU**
- Phase 2 (E-W): 4×0.5 + 1×1.0 + 2×1.0 + 0 = **5.0 PCU**
- Total = 27.0. `G_floor_total` = 20s, `G_remaining` = 34s
- G1 = 10 + 34×(22/27) ≈ **37.7s**, G2 = 10 + 34×(5/27) ≈ **16.3s** → sums to 54s ✅

**Safety note for Q&A:** don't say "15s = pedestrian clearance" as if it's a universal constant — real pedestrian clearance depends on crossing distance and walking speed. Call `G_min` a *configurable minimum phase green*, set per-junction based on its own geometry, and say the actual number would come from a real safety audit in deployment. That one phrasing change avoids a "why exactly 15 seconds?" gotcha.

If `P_total == 0`, fall back to a default even split of `G_available` across phases (empty-approach handling ties in here — see Section 7).

---

## 5. Green-Wave Coordination (2–4 junctions)

Stateless time-offset ticker — no drift, ~15 lines of code, runs centrally in the backend.

```
O_j = (D_1→j / V) mod C
```
Where `C` = common cycle length (e.g. 60s), `V` = design progression speed (e.g. 10 m/s), `D_1→j` = cumulative distance from junction 1 to junction j.

```js
const CYCLE_LENGTH = 60;
const PROGRESSION_SPEED = 10; // m/s

const junctions = [
  { id: "J1", distanceToNext: 300, greenDuration: 30 },
  { id: "J2", distanceToNext: 400, greenDuration: 35 },
  { id: "J3", distanceToNext: 0,   greenDuration: 25 }
];

let cumulativeDistance = 0;
junctions.forEach(j => {
  j.offset = Math.round(cumulativeDistance / PROGRESSION_SPEED) % CYCLE_LENGTH;
  cumulativeDistance += j.distanceToNext;
});

function getSignalStates() {
  const cycleClock = Math.floor(Date.now() / 1000) % CYCLE_LENGTH;
  return junctions.map(j => {
    const localTime = (cycleClock - j.offset + CYCLE_LENGTH) % CYCLE_LENGTH;
    return {
      junctionId: j.id,
      state: localTime < j.greenDuration ? "GREEN" : "RED",
      offset: j.offset
    };
  });
}
```

**Caveat to know for Q&A:** green waves collapse when V/C ratio exceeds 1.0 (fully saturated). Don't claim green waves solve gridlock — they smooth moderate-to-heavy flow, not full saturation. That's exactly why the Upstream Inflow Recommendation (Section 8) exists — it's the piece that acts *before* saturation.

---

## 6. Live Metrics — Real Numbers, Not Invented Percentages

Fluid-queue model, ticked every second per approach:

```
q(t+1) = max(0, q(t) + λ(t) − μ(t))
```
- `λ(t)` = PCU arrivals this second
- `μ(t)` = departures: `0` if RED, `min(q(t)+λ(t), S)` if GREEN, where `S ≈ 0.5 PCU/s` (saturation flow rate)

**Metric A — Max Queued Demand (PCU).** ⚠️ Naming fix: `q(t)` is PCU, not a physical length — don't call it "queue length in meters" (that's a real transportation-engineering term with a different meaning). Call this metric **Max Queued Demand (PCU)**:
```
queue_pcu_max = max(queue_pcu_max, q(t))
```
**Optional upgrade (cheap since you already track vehicle positions in the simulation):** if you want an actual physical queue length for the dashboard, compute it directly from your simulated vehicle agents:
```
queue_length_m = distance from stop line to the last stationary queued vehicle
```
This gives you a real "Max queue: 247m" number instead of a PCU count — more impressive and still honest, since it's derived from positions you already simulate.

**Metric B — Average Control Delay (seconds/vehicle):**
```js
let totalAccumulatedDelay = 0; // vehicle-seconds
let totalVehiclesArrived = 0;

function updateMetrics(currentQueueLength, newArrivals) {
  totalAccumulatedDelay += currentQueueLength * 1;
  totalVehiclesArrived += newArrivals;
  const avgDelay = totalVehiclesArrived > 0
    ? totalAccumulatedDelay / totalVehiclesArrived
    : 0;
  return { currentQueue: currentQueueLength, averageDelaySeconds: +avgDelay.toFixed(1) };
}
```

**These are the two numbers to show live on screen** — "Avg control delay: X sec/vehicle" and "Max queue: Y PCU" — computed in front of the judges, updating in real time. This replaces every fabricated "30-40% reduction" stat from the old deck.

**Baseline comparison (do this):** run the same queue model with a fixed 30/30 timer alongside your adaptive one, split-screen or toggle. **Lock a fixed random seed so both runs get identical vehicle demand, origins, destinations, and initial conditions — only the controller differs.** This is a free implementation detail (one config value) that turns "cool simulation" into an actual controlled comparison a judge can't wave away. Compare AURA's live delay number against the fixed-timer's live delay number — that's your defensible "improvement" claim, computed, not asserted.

**Optional upgrade — per-vehicle delay (only if the core above is solid and time remains).** Since your simulation already runs individual vehicle agents, you *can* track `arrival_time`/`departure_time`/`free_flow_time` per vehicle and compute delay = actual − free-flow per vehicle, giving you average and P95 delay instead of just the aggregate accumulated-delay estimate. This is legitimately cheap *because* you already have per-vehicle agents — but it's still optional, not core: ship the aggregate average-delay number first, add P95 only after Sections 4, 8b, and the baseline comparison are working end-to-end.

**Do not build a single composite "network health" score.** Rolling delay/queue/spillbacks/throughput into one number requires an arbitrary weighting formula — it would look impressive but is the same category of problem as the invented "30-40% reduction" stats from the original deck: a number that looks measured but is actually just made up. Show the individual real metrics instead.

---

## 7. Gap-Out / Empty-Lane Phase Skip

If an approach's PCU is 0 and no vehicle has been detected for N seconds (e.g. 5s), terminate that phase early and hand green to the next approach with demand. Layer this on top of Section 4's formula — it's a short-circuit check before the proportional split runs.

---

## 8. Upstream Inflow Recommendation (the actual novel piece)

This is the feature that answers the real, cited gap in existing systems (SCOOT/SCATS/CoSiCoSt all operate isolated from routing).

**⚠️ Corrected approach.** The original plan assumed a hosted OSRM/OpenRouteService API would accept live custom edge-weight overrides — public routing APIs don't work that way (you'd need to self-host with custom profiles, which is real infra you don't have time for). **Fix: skip the external routing API entirely and use the graph + pathfinding you already have** (same junction graph as the rest of AURA, same Dijkstra/A* code family you already used in the old Kochi project).

**How it works (self-contained, no external dependency):**
1. Backend computes a per-junction congestion/penalty score from PCU + queue.
2. When a junction crosses a saturation threshold, the backend adds a weight penalty to that junction's incoming edges *in your own graph*.
3. Run Dijkstra/A* on your own graph for any requested origin→destination — the congested junction is now naturally more "expensive" and gets routed around.
4. Return the resulting path to the dashboard's citizen routing panel — a recommendation, not a forced action.

**Why this is actually better, not just a fallback:** it's fully self-contained (no external API to fail live during the demo), it reuses code you already have, and it's honest — you're not implying you have a live integration with a commercial routing provider you don't.

**Framing for judges:** *"We don't control any driver's steering wheel — we run congestion-weighted pathfinding on our own network graph and surface the result as a recommendation, the same way a fleet dispatcher or transit authority would consume it. This is advisory, not coercive, and it doesn't depend on any third party."*

**If a judge pushes on adoption:** the honest answer from the research — target fleet vehicles (public transit, delivery, municipal) as the realistic adoption path, and describe your own routing engine as something that *could* later expose an API for OSRM/ORS-style integrations, rather than claiming that integration exists today.

---

## 8a. Sensor Abstraction — Build Order Change

**Don't build YOLO first.** Build the traffic engine against a `TrafficSensor` interface so the simulation is your actual product, and YOLO is just one pluggable input to it. If vision breaks at hour 20, the rest of AURA still works.

```typescript
interface ApproachState {
  junctionId: string;
  approach: string;
  counts: { two_wheeler: number; auto_rickshaw: number; car: number; bus: number };
  sourceMode: "LIVE" | "REPLAY" | "SIMULATED";
}

interface TrafficSensor {
  getApproachState(junctionId: string, approach: string): ApproachState;
}

class SimulationSensor implements TrafficSensor { /* synthetic demand generator, build FIRST */ }
class ReplaySensor      implements TrafficSensor { /* streams pre-computed YOLO detections */ }
class YOLOSensor        implements TrafficSensor { /* live inference, plugs in LAST */ }
```

Build order: **`SimulationSensor` → full engine (PCU, signals, green wave, queues, routing, emergency) working end-to-end on synthetic data → then `ReplaySensor` → then `YOLOSensor` last**, swapped in without touching the engine. This is the single highest-leverage structural change to the plan — it directly prevents a repeat of "vision and dashboard never actually talked to each other."

---

## 8a-i. Vision Model — UVH-26 instead of stock COCO

Use **YOLOv11-S weights fine-tuned on UVH-26** (`UVH-26-MV-YOLOv11-S.pt`, from `iisc-aim/UVH-26` on Hugging Face, Apache 2.0) instead of stock `yolov8s.pt`. Same `ultralytics` package, same `model.track()` API — this is a weights-file swap, not an architecture change.

**Why:** UVH-26 is a public dataset/model release from IISc, built from 2,800 real Bengaluru CCTV cameras, with 14 India-specific vehicle classes including a real Three-wheeler (auto-rickshaw) category — fixing the exact bug flagged in the audit of the old project ("auto-rickshaw counting: BROKEN — COCO has no 'auto' class"). Published results show 8.4–31.5% mAP improvement over COCO-trained baselines on Indian traffic footage, including on common classes like car/bus/truck, not just India-specific ones.

**Class remap needed** (one-time config change, not new engineering) — UVH-26's 14 classes fold into your 4 PCU buckets:
```
Two-wheeler, Bicycle                                        → 0.5
Three-wheeler, Hatchback, Sedan, SUV, Van                    → 1.0
Bus, Truck, MUV, LCV, Mini-bus, Tempo-traveller              → 3.0
```
Get the authoritative class list from `uvh_classes.txt` in the repo, not from memory — the arXiv paper and the model card use slightly different labels for the same classes (e.g. "Cycle" vs "Bicycle").

**Practical note:** use the **S** (small) variant, not X — X is larger/slower and this needs to run live on a laptop CPU during the demo. Test against your own Kochi footage before committing; if detection is visibly better than your old yolov8s run (expected, per the published numbers), switch; if the swap causes problems under time pressure, stock yolov8s is still a safe fallback — just without solid auto-rickshaw detection, same limitation as before.

---

## 8b. Back-Pressure / Spillback Protection (CORE, not bonus)

**Promoted to core.** Without this, AURA is "coordinated junction optimization" — with it, AURA is actually network-level control, which is the entire thesis. It's cheap: a threshold check feeding into Section 4's formula, using a value (downstream queue) you're already computing.

**Mechanism:**
1. Each junction tracks its own queue (Section 6).
2. **Continuous penalty, not a binary switch.** Instead of a single 80% cliff-edge ("congestion detected, slam the brakes"), use a small lookup/step table so throttling ramps up progressively — more believable and avoids a visibly jarring on/off flip in the demo:
   ```
   downstream_utilization → upstream_inflow_multiplier
   0–60%   → 1.00   (no restriction)
   60–75%  → 0.90
   75–85%  → 0.70
   85–95%  → 0.40
   >95%    → 0.15   (heavy restriction, not full stop)
   ```
   Apply the multiplier to the upstream approach's `P_k` before Section 4's split runs. You don't need to show this table to judges unless asked — just note verbally that throttling is progressive, not a single threshold.
3. Log every time utilization crosses a step boundary as a **spillback event** — a free counter (see Section 6 addendum below), no new logic required.

**Demo framing (the strongest visual in the plan):** run the same demand scenario twice — baseline fixed-timer vs AURA — and show baseline's congestion visibly propagating backward through 2-3 junctions while AURA's back-pressure holds it at the source junction. This is the direct, watchable proof of "network-level," not just a bigger number on a dashboard.

**Metric addendum to Section 6 — Spillback Events (free byproduct):**
```
spillback_events += 1   // each time a junction crosses its high-water threshold
```
Report `spillback_events` in the baseline-vs-AURA comparison alongside delay and queue — more on-thesis than a CO2 estimate, and costs nothing extra to compute.

---

## 8c. Individual-Optimal vs Network-Optimal Route

Reuses Section 8's pathfinding twice — once unconstrained (shortest path for this one vehicle), once congestion-weighted (accounting for back-pressure penalties, Section 8b). Show both to make the thesis visible instead of asserted:

```
FASTEST FOR YOU        12.2 min
AURA COOPERATIVE ROUTE 12.8 min  (+36s for you, avoids J7 saturation, network-wide delay ↓)
```

This is the clearest way to state your actual differentiator from a personal navigation app: *"Google Maps optimizes your route. AURA optimizes the network — and sometimes that means your route is a little longer so the whole corridor doesn't jam."* Cheap to build since it's the same graph run twice with different edge weights; strong for the "how are you different from Maps" question.

---

## 9. Emergency Corridor + Post-Priority Recovery

1. Simulated ambulance GPS ping → `EMERGENCY_OVERRIDE` event (Section 10 schema) → BFS/Dijkstra path on your junction graph → override green on corridor junctions.
2. **Fix the old bug:** actually use the coordinates passed in, don't hardcode start/end.
3. **New piece — post-priority recovery:** the moment the override ends, immediately run one extra discharge cycle on the approaches that were held red during the override, before returning to normal PCU-based timing. This directly answers "what happens to everyone else when you clear the corridor" — a question a sharp judge will ask, and most teams won't have an answer for.
4. **ETA before/after (cheap, high payoff):** compute the corridor's travel time along the same path with and without the override active (you already have both the baseline-timing path cost and the override-timing path cost) and show the diff: `Baseline ETA 08:14 → AURA ETA 05:52 → Saved 2:22`. Simulation-derived, not asserted.
5. Label it clearly in the UI as **simulated** GPS (real ambulance GPS access was confirmed unavailable to you) — this is the honesty layer, not a weakness.

---

## 10. WebSocket Message Schema

**Wrapper:**
```json
{ "event": "VISION_DETECTION | SIMULATED_TRAFFIC_STATE | EMERGENCY_OVERRIDE", "timestamp": "...", "data": {} }
```

**VISION_DETECTION** (Python → Node):
```json
{
  "event": "VISION_DETECTION",
  "timestamp": "2026-08-31T10:00:00Z",
  "data": {
    "camera_id": "CAM_J1_North",
    "junction_id": "J1",
    "approach_direction": "NORTHBOUND",
    "detections": { "two_wheeler": 14, "auto_rickshaw": 5, "car": 8, "bus": 1 },
    "calculated_pcu": 25.0,
    "inference_latency_ms": 42,
    "source_mode": "LIVE | REPLAY"
  }
}
```
`source_mode` is the honesty field — see Section 11.

**SIMULATED_TRAFFIC_STATE** (Node → browser):
```json
{
  "event": "SIMULATED_TRAFFIC_STATE",
  "timestamp": "...",
  "data": {
    "junctions": [{
      "junction_id": "J1",
      "current_phase": 1,
      "approaches": {
        "NORTHBOUND": { "signal_state": "GREEN", "queue_pcu": 4.5, "max_queue_pcu": 25.0, "avg_delay_seconds": 18.2 }
      }
    }]
  }
}
```

**EMERGENCY_OVERRIDE** (Node → browser, triggered by simulated GPS):
```json
{
  "event": "EMERGENCY_OVERRIDE",
  "timestamp": "...",
  "data": {
    "emergency_vehicle_id": "AMB_SIM_01",
    "target_junction_id": "J1",
    "required_approach": "NORTHBOUND",
    "gps_latitude": 9.9894, "gps_longitude": 76.2925,
    "preemption_status": "ACTIVE",
    "source_mode": "SIMULATED"
  }
}
```

---

## 11. Keeping the Demo From Looking Fake (efficiency / performance)

- **Don't run YOLO frame-by-frame live under demo pressure.** Run inference at ~2 FPS (every ~15th frame), OR pre-process your demo videos in advance, save detection JSON, and replay it over WebSocket to *mimic* a live camera feed during the actual pitch. This is fine — just tag it `source_mode: "REPLAY"` and say so if asked, per Section 2's honesty framing.
- **No teleporting vehicles.** Use Canvas + Leaflet with linear interpolation between backend ticks so vehicles glide instead of jumping:
  ```
  pos_render = pos_render + (pos_target - pos_render) × 0.1
  ```
  This makes a 1Hz backend tick look like a smooth 60fps frontend.
- **Decouple everything from everything.** Vision writes to an in-memory store; simulation ticks independently; frontend renders independently off WebSocket pushes. If the camera feed dies, the signals must fall back to a fixed Time-of-Day plan without freezing the UI — build this fallback explicitly and demo it on purpose (turn off the camera feed live and show the graceful degrade).
- **Fix from the old audit — do not repeat:** the 5ms API timeout that guaranteed silent failure. Use 1s+ timeouts on every network call between components.

---

## 12. Real vs Simulated vs Replay — UI Legend

Add a visible legend/toggle in the dashboard:
- 🟢 **LIVE** — vision pipeline actively processing right now
- 🟡 **REPLAY** — pre-computed real YOLOv8 detections being streamed to simulate live camera input
- ⚪ **SIMULATED** — synthetic data (e.g. ambulance GPS, background traffic fill) with no camera behind it

This turns your biggest structural constraint (can't get real city data/GPS/cameras) into a visible signal of engineering honesty — and it's the single cheapest thing on this whole plan to build.

---

## 12a. Decision Explainability (cheap, high payoff)

Every time AURA changes a signal or issues a routing recommendation, attach a one-line reason built from numbers you're already computing — no new logic, just surfacing existing state:

```
J7 GREEN +12s
Why: demand +31% this cycle · queue 26 PCU · downstream capacity 71%
```
```
ROUTE PENALTY — Civil Line Road
Why: queue growth +18 PCU/min · storage 87% · spillback risk HIGH
```

This costs almost nothing (a template string next to numbers you already have) and directly defuses "is this hardcoded/random?" — a judge sees the system justify itself instead of just outputting a number.

**"Why AURA Acted" event timeline (formalizes what you're already generating).** Feed each explainability string and each back-pressure/spillback-event trigger into one visible timeline widget in the UI, timestamped:
```
10:42:03  ⚠ J3 storage 82%
10:42:04  🛡 Back-pressure activated — J2 inflow ×0.70
10:42:06  ↪ Route recommendation updated, 14 vehicles affected
10:42:12  ✓ J3 storage 76%, stabilizing
```
This is not new logic — it's the same events from Sections 8b and 12a rendered as a log instead of one-off tooltips. Cheap, and it's the difference between the system feeling like a dashboard vs. feeling like it's actively narrating its own decisions.

---

## 12b. Additional High-Value Features (add only after Sections 1–11 work end-to-end)

These are genuinely strong differentiators, but treat them as an **ordered bonus list, not a checklist** — stop adding the moment you hit the freeze time in Section 13. Do not attempt more than 1-2 of these unless the core is done early.

1. **Road-closure / incident injection (highest remaining value).** A clickable "block this edge" control that removes an edge from your graph live, forces a recompute, and visibly reroutes — including through the back-pressure mechanism, which will hold traffic at the affected junctions instead of dumping it downstream. Cheap (you already have the graph and pathfinding) and it's the single best "lean forward" demo moment left: trigger it live, show AURA react end-to-end (signals rebalance, routes shift, spillback held), then clear it and show recovery.
2. **Adaptive/platoon-aware green wave.** Upgrade Section 5 from pure distance/speed offsets to reacting to an observed platoon's estimated arrival time. Nice, but explicitly lower priority than #1 — the underlying green wave already works and is defensible as-is.
3. **Physical queue length in meters** (Section 6 optional upgrade) if there's spare time once metrics are solid.

Everything past this (weather/waterlogging modes, network health index, platoon-aware green wave visualization, time-lapse projection, cooperative fleet simulation) is genuinely good demo material *in principle*, but competes directly for the same hours as the load-bearing fixes in Sections 4, 6, and 8. Skip them for this build — they're legitimate v2 ideas, not 24-hour material.

---

## 13. Full Build Order (~8hr realistic budget inside the 24h window)

**Phase 1 — Skeleton**
- [ ] Repo: `vision/`, `backend/`, `frontend/`, shared types
- [ ] 4-junction graph JSON (reuse/adapt existing Kochi-corridor work)
- [ ] Express + WebSocket server up
- [ ] `TrafficSensor` interface + `SimulationSensor` implementation (Section 8a) — **build this before YOLO**
- [ ] Dashboard: map + static markers only
- [ ] Git commit at every working checkpoint, tag working states

**Phase 2 — Non-negotiable core loop (on simulated sensor data)**
- [ ] Corrected PCU scoring → green-time allocation (Section 4)
- [ ] Empty-lane gap-out (Section 7)
- [ ] Live queue/delay/spillback metrics (Section 6 + 8b addendum), correctly named (Max Queued Demand)
- [ ] Back-pressure / spillback protection (Section 8b) — core, not optional
- [ ] Backend → WebSocket → dashboard, fully wired end-to-end on `SimulationSensor` first — prove the whole loop works before vision touches it

**Phase 3 — Vision plug-in + differentiators**
- [ ] YOLOv11-S (UVH-26 weights) + ByteTrack counting (Section 8a-i — swap weights into your prior working pipeline, remap classes), wrapped as `ReplaySensor` then `YOLOSensor`
- [ ] Fix timeout bug (1s+, not 5ms)
- [ ] Green-wave offset ticker (Section 5) across 2-4 junctions
- [ ] Fixed-timer baseline vs AURA split-screen, run same demand through both, show delay/queue/spillback side by side
- [ ] Upstream routing via own graph + Dijkstra/A* (Section 8, corrected) + individual-vs-network-optimal comparison (Section 8c)
- [ ] Emergency override + post-priority recovery + ETA before/after (Section 9)
- [ ] Decision explainability strings (Section 12a)

**Phase 4 — Credibility & polish**
- [ ] Real/Replay/Simulated legend (Section 12)
- [ ] Explicit fallback demo (kill camera feed live, show graceful degrade)
- [ ] Canvas interpolation for smooth rendering (Section 11)
- [ ] Bonus, only if time remains: road-closure/incident injection (Section 12b #1) — highest-value remaining bonus

**Phase 5 — Freeze & rehearse**
- [ ] Hard freeze ~hour 16-18
- [ ] Rehearse against the running app, not slides
- [ ] Pre-write one-line answers for: "how do you force Google Maps to use this," "is this GPS real," "what happens when saturation exceeds V/C 1.0," "where's the actual AI," "why does your cycle length add up" (now genuinely answerable), "why 10s minimum green" (configurable-per-junction answer, Section 4)

---

## 14. Explicit Cut List — do not build these

- 3D city / "digital twin" visuals or terminology
- Separate full in-vehicle navigation app (routing stays a panel inside the same dashboard)
- Real V2X / OBU / connected-vehicle integration
- Real private GPS probe data or real ambulance GPS (confirmed unobtainable)
- Unconstrained multi-agent RL signal control
- Centralized raw video streaming/storage (privacy + bandwidth)
- Full VSP emissions model (only attempt if every above item is done early — genuine v2 material)
- HIL hardware (Arduino/Jetson) testing
- Calibrated SUMO/VISSIM microsimulation (too heavy for 24h; your own queue model is the right substitute)
- A single composite "network health" score — rolling delay/queue/spillbacks/throughput into one weighted number has no defensible basis and repeats the invented-stat problem from the original deck; show the real individual metrics instead

---

## 15. The One-Line Pitch

**Don't just optimize the intersection. Control what reaches it.**

*"AURA is a network-level traffic control system that combines real-time computer vision, adaptive signals, spillback protection, and congestion-aware routing to stop traffic jams from propagating through connected junctions — not just react to them one at a time."*

If pushed for technical depth: *"The perception layer uses YOLOv8 and ByteTrack; the control layer uses deterministic, IRC-aligned traffic-engineering formulas — not unstable RL; and the network layer runs back-pressure and congestion-weighted routing on our own graph to hold congestion at its source instead of letting it spread."*
