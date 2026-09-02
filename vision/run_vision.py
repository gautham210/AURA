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

def run():
    parser = argparse.ArgumentParser(description="AURA Vision Pipeline")
    parser.add_argument("--source", type=str, default="0", help="Video source (e.g., path/to/video.mp4 or 0 for webcam)")
    parser.add_argument("--junction", type=str, default="J1", help="Junction ID")
    parser.add_argument("--approach", type=str, default="NORTHBOUND", help="Approach Direction")
    parser.add_argument("--mode", type=str, default="LIVE", help="Source Mode (LIVE or REPLAY)")
    parser.add_argument("--endpoint", type=str, default="http://localhost:3000/vision-update", help="Backend /vision-update endpoint")
    parser.add_argument("--fps", type=int, default=30, help="Max FPS to process")
    parser.add_argument("--batch-interval", type=float, default=1.0, help="Seconds between POST requests")
    args = parser.parse_args()

    print(f"[VISION] Loading model UVH-26-MV-YOLOv11-S.pt...")
    model = YOLO("vision/UVH-26-MV-YOLOv11-S.pt")
    names = model.names
    
    cap = cv2.VideoCapture(int(args.source) if args.source.isdigit() else args.source)
    if not cap.isOpened():
        print(f"[VISION] ERROR: Cannot open source {args.source}")
        return

    print(f"[VISION] Started tracking on {args.source} for {args.junction} {args.approach} ({args.mode})")

    seen_track_ids = set()
    current_batch_counts = {}
    
    last_post_time = time.time()
    frame_time = 1.0 / args.fps
    
    frame_count = 0

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
        new_arrivals = 0
        
        if results and results[0].boxes and results[0].boxes.id is not None:
            boxes = results[0].boxes
            track_ids = boxes.id.int().cpu().tolist()
            cls_ids = boxes.cls.int().cpu().tolist()
            
            active_tracks = len(track_ids)
            
            for tid, cid in zip(track_ids, cls_ids):
                if tid not in seen_track_ids:
                    seen_track_ids.add(tid)
                    cls_name = names.get(cid, "Others")
                    current_batch_counts[cls_name] = current_batch_counts.get(cls_name, 0) + 1
                    new_arrivals += 1
        
        # Check if it's time to batch and send
        now = time.time()
        if now - last_post_time >= args.batch_interval:
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
                status = res.status_code
            except Exception as e:
                status = f"FAIL ({str(e)})"
                
            print(f"[VISION] frame={frame_count} tracked={active_tracks} new_arrivals_batch={sum(current_batch_counts.values())} POST /vision-update {status}")
            
            # Reset batch accumulator
            current_batch_counts = {}
            last_post_time = now
            
            # Periodically clean up seen_track_ids to prevent unbounded memory growth in long streams
            if len(seen_track_ids) > 10000:
                print("[VISION] Pruning old track IDs...")
                seen_track_ids.clear() # crude but works for the demo
                
        # Sleep to maintain FPS limit
        elapsed = time.time() - loop_start
        if elapsed < frame_time:
            time.sleep(frame_time - elapsed)

    cap.release()

if __name__ == "__main__":
    run()
