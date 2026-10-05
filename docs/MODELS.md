# Model Cards

## MediaPipe Face Landmarker

- **Model:** MediaPipe Face Landmarker, float16 task bundle.
- **Runtime:** `@mediapipe/tasks-vision` WebAssembly with GPU delegate and CPU fallback.
- **Location:** `public/models/face_landmarker.task`; WASM assets are under `public/mediapipe/wasm`.
- **Input:** Local webcam video frame supplied to `detectForVideo` at a throttled interval of about 180 ms. Duplicate video frames and overlapping inference calls are skipped.
- **Output:** Up to three faces, each with 478 normalized 3D landmarks; an optional facial transformation matrix is enabled for future diagnostics.
- **Inference method:** On-device browser inference. Frames are neither uploaded nor saved by the current pipeline.
- **Confidence:** The Web result does not expose a raw face-detection confidence. Look At Me! reports a derived measurement-quality value from face scale, facial geometry, two-eye iris agreement, and temporal sample support. Event metadata identifies this as `geometry-and-temporal` or `temporal-support`.
- **Uses:** One/no/multiple-face state, neutral-pose calibration, approximate head direction, and approximate iris direction.
- **Limitations:** Lighting, occlusion, glasses, camera angle, small faces, and rapid movement can reduce quality. Head pose uses landmark geometry rather than a calibrated 3D camera solve. Gaze is approximate and does not identify a point on screen.

## YOLOv8n phone detector

- **Model:** Ultralytics YOLOv8n detect checkpoint pretrained on COCO, downloaded from the official `ultralytics/assets` v8.3.0 release and exported locally with Ultralytics 8.3.228.
- **Export:** ONNX opset 17, FP32, batch 1, static 640 × 640 input, raw output without embedded NMS.
- **Location:** `public/models/yolov8n.onnx`.
- **SHA-256:** `989f57b09e1d12a8c8a2bef4ffb8b8a978a18808ac51439e4fe4aa9825a481ef`.
- **Runtime:** `onnxruntime-web` 1.23.2. Session creation requests WebGPU with WASM fallback; a separate WASM-only attempt follows a failed WebGPU session.
- **Input:** A local webcam frame letterboxed with RGB value 114 to 640 × 640, normalized to 0–1, converted to RGB planar float32, and supplied as `[1, 3, 640, 640]`. Phone inference is sampled every 600 ms and overlapping calls are skipped.
- **Output:** Raw tensor `[1, 84, 8400]`: four center/size box values plus 80 COCO class scores. Only zero-based class 67, `cell phone`, is retained.
- **Postprocessing:** Class confidence threshold 0.50, IoU NMS threshold 0.45, at most five phone boxes, and inverse letterbox mapping to source-frame pixels.
- **Event confidence:** `PHONE_DETECTED` stores the model class score from the first qualifying analyzed frame. A current-frame detection at or above 0.50 creates the event immediately; the tracker then suppresses duplicate events inside the same continuous episode and uses a 1 second cooldown between distinct emissions.
- **Inference method:** Browser-local ONNX inference. Camera frames are not uploaded or persisted by this pipeline.
- **Limitations:** Small, distant, partially hidden, unusually oriented, or screen-only phones can be missed. Calculators and visually similar handheld objects can be false positives. WebGPU support depends on Chrome, the GPU driver, and the ONNX operator set; WASM is slower. This general COCO model was not trained specifically for exam webcams.
- **License:** Ultralytics distributes its open-source software and models under AGPL-3.0 and also offers an enterprise license. The hackathon repository must preserve the applicable attribution and license obligations; see `THIRD_PARTY_NOTICES.md`.

### Verification performed on 2026-10-04

- ONNX metadata verified as input `[1, 3, 640, 640]` and output `[1, 84, 8400]`.
- A real ONNX Runtime CPU inference and an `onnxruntime-web` WASM inference were run on the same [Pexels control image](https://www.pexels.com/photo/close-up-photo-of-person-holding-a-cellphone-7787287/) containing a large phone. Both returned maximum `cell phone` confidence `0.8970006`, above the 0.50 threshold.
- The COCO128 image `000000000328.jpg` contains a very small annotated phone; the model returned only `0.0741` for its best phone candidate. This is retained as evidence for the documented small-object limitation rather than lowering the production threshold.
- Unit tests cover letterboxing, channel-first and channel-last output parsing, source-coordinate conversion, confidence filtering, NMS, and invalid output rejection.

COCO-SSD was removed from the active project because the hackathon specification explicitly requires YOLOv8n/YOLO-family phone detection. No mock phone detector replaces it.

The reproducible export command is:

```python
from ultralytics import YOLO

YOLO("yolov8n.pt").export(
    format="onnx",
    imgsz=640,
    opset=17,
    simplify=False,
    dynamic=False,
    nms=False,
)
```
