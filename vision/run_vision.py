import argparse
import time
import requests
import json
import cv2
try:
    from ultralytics import YOLO
except ImportError:
    print("ultralytics not installed. Please run: pip install ultralytics opencv-python requests")
    exit(1)

# PCU weights matching AURA TrafficEngine
PCU_WEIGHTS = {
    'Two-wheeler': 0.5, 'bicycle': 0.5, 'Three-wheeler': 0.5, 'auto_rickshaw': 0.5, 'two_wheeler': 0.5,
    'Hatchback': 1.0, 'Sedan': 1.0, 'SUV': 1.0, 'Van': 1.0, 'Others': 1.0, 'car': 1.0,
    'MUV': 3.0, 'Bus': 3.0, 'Truck': 3.0, 'LCV': 3.0, 'Mini-bus': 3.0, 'tempo-traveller': 3.0, 'bus': 3.0
}

# Distinct colors (BGR) for vehicle classes
CLASS_COLORS = {
    'Two-wheeler': (0, 255, 128),
    'Three-wheeler': (0, 215, 255),
    'bicycle': (0, 255, 0),
    'Hatchback': (255, 178, 50),
    'Sedan': (255, 140, 0),
    'SUV': (238, 104, 123),
    'Van': (200, 200, 0),
    'Bus': (180, 105, 255),
    'Truck': (147, 20, 255),
    'MUV': (255, 105, 180),
    'LCV': (255, 69, 0),
    'Mini-bus': (186, 85, 211),
    'tempo-traveller': (218, 112, 214),
    'Others': (128, 128, 128)
}

def calculate_batch_pcu(counts):
    total = 0.0
    for cls_name, count in counts.items():
        weight = PCU_WEIGHTS.get(cls_name, 1.0)
        total += count * weight
    return total

def run():
    parser = argparse.ArgumentParser(description="AURA Vision Pipeline (UVH-26 + ByteTrack)")
    parser.add_argument("--source", type=str, default="0", help="Video source (e.g., path/to/video.mp4 or 0 for webcam)")
    parser.add_argument("--junction", type=str, default="J1", help="Junction ID (e.g. J1, J2)")
    parser.add_argument("--approach", type=str, default="NORTHBOUND", help="Approach Direction (e.g. NORTHBOUND, SOUTHBOUND, EASTBOUND, WESTBOUND)")
    parser.add_argument("--mode", type=str, default="LIVE", help="Source Mode (LIVE or REPLAY)")
    parser.add_argument("--endpoint", type=str, default="http://localhost:3000/vision-update", help="Backend /vision-update endpoint")
    parser.add_argument("--fps", type=int, default=30, help="Max FPS to process")
    parser.add_argument("--batch-interval", type=float, default=1.0, help="Seconds between POST requests")
    parser.add_argument("--show", action="store_true", help="Display real-time OpenCV window with AI detections overlay")
    args = parser.parse_args()

    print(f"[VISION] Loading model vision/UVH-26-MV-YOLOv11-S.pt...", flush=True)
    model = YOLO("vision/UVH-26-MV-YOLOv11-S.pt")
    names = model.names
    
    cap = cv2.VideoCapture(int(args.source) if args.source.isdigit() else args.source)
    if not cap.isOpened():
        print(f"[VISION] ERROR: Cannot open source {args.source}", flush=True)
        return

    print(f"[VISION] Started tracking on {args.source} for {args.junction} {args.approach} ({args.mode})", flush=True)
    if args.show:
        print(f"[VISION] Real-time visual overlay enabled. Press 'Q' or 'ESC' in the video window to quit.", flush=True)
        window_name = f"AURA Vision Engine — {args.junction} {args.approach} ({args.mode})"
        cv2.namedWindow(window_name, cv2.WINDOW_NORMAL)
        cv2.resizeWindow(window_name, 960, 540)

    seen_track_ids = set()
    current_batch_counts = {}
    last_reported_batch = {}
    last_post_status = "READY"
    
    last_post_time = time.time()
    frame_time = 1.0 / max(1, args.fps)
    
    frame_count = 0

    try:
        while True:
            loop_start = time.time()
            
            ret, frame = cap.read()
            if not ret:
                print("[VISION] End of stream or error.")
                break
                
            frame_count += 1

            # Run inference and ByteTrack
            results = model.track(frame, tracker="bytetrack.yaml", persist=True, verbose=False)
            
            active_tracks = 0
            new_arrivals_this_frame = 0
            
            annotated_frame = frame.copy() if args.show else None

            if results and results[0].boxes and results[0].boxes.id is not None:
                boxes = results[0].boxes
                track_ids = boxes.id.int().cpu().tolist()
                cls_ids = boxes.cls.int().cpu().tolist()
                confs = boxes.conf.cpu().tolist()
                xyxy_coords = boxes.xyxy.int().cpu().tolist()
                
                active_tracks = len(track_ids)
                
                for tid, cid, conf, (x1, y1, x2, y2) in zip(track_ids, cls_ids, confs, xyxy_coords):
                    cls_name = names.get(cid, "Others")
                    
                    if tid not in seen_track_ids:
                        seen_track_ids.add(tid)
                        current_batch_counts[cls_name] = current_batch_counts.get(cls_name, 0) + 1
                        new_arrivals_this_frame += 1

                    # Draw bounding box and label badge if visualization is enabled
                    if args.show and annotated_frame is not None:
                        color = CLASS_COLORS.get(cls_name, (0, 255, 255))
                        cv2.rectangle(annotated_frame, (x1, y1), (x2, y2), color, 2)
                        
                        label = f"#{tid} {cls_name} {conf:.2f}"
                        (tw, th), baseline = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
                        badge_y1 = max(0, y1 - th - 6)
                        badge_y2 = y1
                        cv2.rectangle(annotated_frame, (x1, badge_y1), (x1 + tw + 6, badge_y2), color, -1)
                        cv2.putText(annotated_frame, label, (x1 + 3, badge_y2 - 3), 
                                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 1, cv2.LINE_AA)
            
            # Check if it's time to batch and POST to backend
            now = time.time()
            if now - last_post_time >= args.batch_interval:
                batch_pcu = calculate_batch_pcu(current_batch_counts)
                total_arrivals = sum(current_batch_counts.values())

                payload = {
                    "data": {
                        "junction_id": args.junction,
                        "approach_direction": args.approach,
                        "detections": current_batch_counts,
                        "source_mode": args.mode
                    }
                }
                
                try:
                    res = requests.post(args.endpoint, json=payload, timeout=2.0)
                    status = f"{res.status_code} OK" if res.status_code == 200 else f"HTTP {res.status_code}"
                except Exception as e:
                    status = f"FAIL ({type(e).__name__})"
                    
                print(f"[VISION] frame={frame_count} tracked={active_tracks} new_arrivals_batch={total_arrivals} (PCU={batch_pcu:.1f}) POST /vision-update {status}", flush=True)
                
                last_reported_batch = current_batch_counts.copy()
                last_post_status = status
                
                # Reset batch accumulator
                current_batch_counts = {}
                last_post_time = now
                
                # Clean up seen_track_ids to prevent memory leaks in extended runs
                if len(seen_track_ids) > 10000:
                    print("[VISION] Pruning old track IDs...", flush=True)
                    seen_track_ids.clear()

            # Render HUD banner on visual output
            if args.show and annotated_frame is not None:
                h, w = annotated_frame.shape[:2]
                
                # Top telemetry banner background
                overlay = annotated_frame.copy()
                cv2.rectangle(overlay, (0, 0), (w, 55), (13, 17, 23), -1)
                cv2.addWeighted(overlay, 0.85, annotated_frame, 0.15, 0, annotated_frame)
                
                # Border line under banner
                cv2.line(annotated_frame, (0, 55), (w, 55), (59, 130, 246), 2)
                
                # Left Title & Junction Telemetry
                title_text = f"AURA AI PERCEPTION  |  {args.junction} - {args.approach}  |  MODE: {args.mode}"
                cv2.putText(annotated_frame, title_text, (16, 22), 
                            cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 2, cv2.LINE_AA)
                
                # Right Stats Telemetry
                active_pcu = calculate_batch_pcu(last_reported_batch)
                batch_arr = sum(last_reported_batch.values())
                stats_text = f"TRACKED: {active_tracks}   BATCH ARRIVALS: {batch_arr} ({active_pcu:.1f} PCU)   BACKEND: {last_post_status}"
                cv2.putText(annotated_frame, stats_text, (16, 44), 
                            cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 255, 128) if "200" in last_post_status or "READY" in last_post_status else (0, 165, 255), 1, cv2.LINE_AA)
                
                cv2.imshow(window_name, annotated_frame)
                
                key = cv2.waitKey(1) & 0xFF
                if key == ord('q') or key == ord('Q') or key == 27: # 'q' or ESC
                    print("[VISION] Quit requested by user.")
                    break
                    
            # Maintain processing FPS limit
            elapsed = time.time() - loop_start
            if elapsed < frame_time:
                time.sleep(frame_time - elapsed)

    finally:
        cap.release()
        if args.show:
            cv2.destroyAllWindows()
        print("[VISION] Video capture released and session closed.")

if __name__ == "__main__":
    run()
