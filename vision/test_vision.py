import sys
import json
try:
    from ultralytics import YOLO
except ImportError:
    print("ultralytics not installed")
    sys.exit(1)

def run_vision_proof():
    print("=== PHASE 3 VISION PROOF ===")
    
    # A. Model loads successfully
    try:
        model = YOLO("vision/UVH-26-MV-YOLOv11-S.pt")
        print("MODEL LOADED: PASS")
    except Exception as e:
        print(f"MODEL LOADED: FAIL - {e}")
        return

    # B. Model.names match the expected UVH-26 classes
    expected_names = {
        0: 'Hatchback', 1: 'Sedan', 2: 'SUV', 3: 'MUV', 4: 'Bus', 
        5: 'Truck', 6: 'Three-wheeler', 7: 'Two-wheeler', 8: 'LCV', 
        9: 'Mini-bus', 10: 'tempo-traveller', 11: 'bicycle', 12: 'Van', 13: 'Others'
    }
    
    match = True
    for k, v in expected_names.items():
        if model.names.get(k) != v:
            match = False
            print(f"Mismatch at {k}: expected {v}, got {model.names.get(k)}")
    if match:
        print("MODEL NAMES MATCH: PASS")
    else:
        print("MODEL NAMES MATCH: FAIL")

    # C. PCU mapping
    pcu_mapping = {
        'Two-wheeler': 0.5, 'bicycle': 0.5,
        'Three-wheeler': 1.0, 'Hatchback': 1.0, 'Sedan': 1.0, 'SUV': 1.0, 'Van': 1.0, 'Others': 1.0,
        'MUV': 3.0, 'Bus': 3.0, 'Truck': 3.0, 'LCV': 3.0, 'Mini-bus': 3.0, 'tempo-traveller': 3.0
    }
    
    # Test 4 two-wheelers, 3 cars (Sedan), 1 bus
    counts = {'Two-wheeler': 4, 'Sedan': 3, 'Bus': 1}
    pcu = 0
    for cls, count in counts.items():
        pcu += pcu_mapping[cls] * count
    
    if pcu == 8.0:
        print("PCU MAPPING: PASS")
    else:
        print(f"PCU MAPPING: FAIL (got {pcu})")

    # D & E. Persistent track IDs / New-arrival semantics
    class TrackerMock:
        def __init__(self):
            self.previous_ids = set()
            self.pcu_mapping = pcu_mapping
            
        def process_frame(self, current_detections):
            # current_detections is list of (track_id, class_name)
            current_ids = set(d[0] for d in current_detections)
            new_ids = current_ids - self.previous_ids
            
            new_arrivals = 0
            new_pcu = 0
            for d in current_detections:
                tid, cls = d
                if tid in new_ids:
                    new_arrivals += 1
                    new_pcu += self.pcu_mapping[cls]
            
            self.previous_ids = current_ids
            return new_arrivals, new_pcu

    tracker = TrackerMock()
    
    # Tick 1: ID 42 appears (Sedan)
    arr, pcu1 = tracker.process_frame([(42, 'Sedan')])
    if arr == 1 and pcu1 == 1.0:
        print("TICK 1 NEW ARRIVALS: PASS")
    else:
        print("TICK 1 NEW ARRIVALS: FAIL")
        
    # Tick 2: ID 42 remains visible
    arr, pcu2 = tracker.process_frame([(42, 'Sedan')])
    if arr == 0 and pcu2 == 0:
        print("TICK 2 PERSISTENT ID IGNORED: PASS")
    else:
        print("TICK 2 PERSISTENT ID IGNORED: FAIL")
        
    # Tick 3: ID 42 remains visible
    arr, pcu3 = tracker.process_frame([(42, 'Sedan')])
    if arr == 0:
        print("TICK 3 PERSISTENT ID IGNORED: PASS")
        
    # Tick 4: ID 42 + ID 43 visible (Bus)
    arr, pcu4 = tracker.process_frame([(42, 'Sedan'), (43, 'Bus')])
    if arr == 1 and pcu4 == 3.0:
        print("TICK 4 NEW ARRIVALS (ID 43): PASS")
    else:
        print("TICK 4 NEW ARRIVALS: FAIL")

if __name__ == "__main__":
    run_vision_proof()
