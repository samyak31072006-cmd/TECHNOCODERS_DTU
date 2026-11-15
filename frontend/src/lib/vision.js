import { FaceLandmarker, FilesetResolver, ObjectDetector } from '@mediapipe/tasks-vision';

const BASE = import.meta.env.BASE_URL || '/';
const WASM_PATH = `${BASE}wasm`;
const FACE_MODEL = `${BASE}models/face_landmarker.task`;
const PHONE_MODEL = `${BASE}models/efficientdet_lite2.tflite`;

function buildFace(fileset, delegate) {
  return FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: FACE_MODEL, delegate },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: false,
  });
}

function buildDetector(fileset, delegate) {
  return ObjectDetector.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: PHONE_MODEL, delegate },
    runningMode: 'IMAGE',
    scoreThreshold: 0.15,
    categoryAllowlist: ['cell phone'],
    maxResults: 5,
  });
}

async function initialise(delegate) {
  const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
  const face = await buildFace(fileset, delegate);
  let detector;
  try {
    detector = await buildDetector(fileset, delegate);
  } catch (err) {
    if (delegate !== 'CPU') {
      detector = await buildDetector(fileset, 'CPU');
    } else {
      throw err;
    }
  }
  return { face, detector };
}

/**
 * Loads face landmarker and cell-phone object detector from files served
 * out of /public, so a deployed build never calls an external CDN.
 * Prioritizes eye detection and runs high-resolution face/ear-cropped phone detection
 * at ~7 Hz without blocking camera or eye monitoring FPS.
 */
export async function createVisionEngine({ onStatus } = {}) {
  let delegate = 'GPU';
  let face;
  let detector;

  onStatus?.('loading', 'Loading vision models');

  try {
    ({ face, detector } = await initialise('GPU'));
  } catch (gpuError) {
    onStatus?.('loading', 'GPU delegate unavailable, using CPU WASM');
    delegate = 'CPU';
    ({ face, detector } = await initialise('CPU'));
  }

  onStatus?.('ready', `Vision models ready (${delegate})`);

  const cropCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  const cropCtx = cropCanvas ? cropCanvas.getContext('2d') : null;

  let lastObjects = [];
  let lastPhoneTimestamp = 0;
  // Run phone detection every ~130ms (~7 Hz) so eye detection stays responsive at 20+ FPS
  const PHONE_INTERVAL_MS = 130;

  return {
    delegate,
    detect(video, timestampMs) {
      // 1. Eye & Face detection runs on EVERY frame for immediate blink & drowsiness responsiveness
      const faceResult = face.detectForVideo(video, timestampMs);

      // 2. High-resolution Padded Face-and-Ear Crop for phone recognition
      if (detector && cropCanvas && cropCtx && video && video.readyState >= 2 && video.videoWidth > 0) {
        if (timestampMs - lastPhoneTimestamp >= PHONE_INTERVAL_MS) {
          lastPhoneTimestamp = timestampMs;
          try {
            const W = video.videoWidth;
            const H = video.videoHeight;
            const landmarks = faceResult?.faceLandmarks?.[0];

            let cropX = 0;
            let cropY = 0;
            let cropW = W;
            let cropH = H;

            if (landmarks && landmarks.length > 0) {
              const xs = landmarks.map((p) => p.x * W);
              const ys = landmarks.map((p) => p.y * H);
              const fMinX = Math.min(...xs);
              const fMaxX = Math.max(...xs);
              const fMinY = Math.min(...ys);
              const fMaxY = Math.max(...ys);
              const fW = fMaxX - fMinX;
              const fH = fMaxY - fMinY;
              const centerX = (fMinX + fMaxX) / 2;

              // Symmetrical horizontal pad from face center: covers left ear and right ear identically (135% of face width)
              // Symmetrical vertical coverage: covers upper face / forehead, cheeks, mouth, jawline, and chin
              const halfW = fW * 1.35;
              const padTop = fH * 0.45;
              const padBottom = fH * 0.85;

              cropX = Math.max(0, Math.floor(centerX - halfW));
              cropY = Math.max(0, Math.floor(fMinY - padTop));
              cropW = Math.min(W - cropX, Math.ceil(halfW * 2));
              cropH = Math.min(H - cropY, Math.ceil(fH + padTop + padBottom));
            }

            cropCanvas.width = cropW;
            cropCanvas.height = cropH;
            cropCtx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

            const objResult = detector.detect(cropCanvas);
            const detections = objResult?.detections || [];

            // Map bounding boxes back to original camera coordinate space
            lastObjects = detections.map((det) => ({
              ...det,
              boundingBox: {
                originX: (det.boundingBox?.originX ?? 0) + cropX,
                originY: (det.boundingBox?.originY ?? 0) + cropY,
                width: det.boundingBox?.width ?? 0,
                height: det.boundingBox?.height ?? 0,
              },
            }));
          } catch (error) {
            /* ignore transient frame read error */
          }
        }
      }

      return {
        faces: faceResult?.faceLandmarks || [],
        blendshapes: faceResult?.faceBlendshapes?.[0]?.categories || [],
        hands: [],
        objects: lastObjects,
      };
    },
    close() {
      try {
        face?.close();
        detector?.close();
      } catch (error) {
        /* already closed */
      }
    },
  };
}
