/**
 * Browser-side mirror of config.py. Values are copied verbatim so the JS
 * pipeline and the Python pipeline make the same decisions.
 */
export const RIGHT_EYE_LANDMARKS = [33, 160, 158, 133, 153, 144];
export const LEFT_EYE_LANDMARKS = [362, 385, 387, 263, 373, 380];

export const EAR_THRESHOLD = 0.22; // below = eye closed
export const BLINK_MAX_DURATION = 0.5; // closure under this is a blink
export const CAUTION_DURATION = 1.0; // seconds
export const DROWSY_DURATION = 2.0; // seconds

// core/phone_detector.py
export const PHONE_EAR_INDICES = {
  left: [127, 234, 93, 132],
  right: [356, 454, 323, 361],
};
export const HAND_WRIST_INDEX = 0;
export const HAND_INDEX_TIP = 8;
export const PHONE_PROXIMITY_PX = 85; // measured against a 640 px wide frame
export const PHONE_REFERENCE_WIDTH = 640;
export const PHONE_TRIGGER_FRAMES = 2;
export const CHIN_LANDMARK_INDEX = 152;
export const PHONE_CONFIDENCE_THRESHOLD = 0.25;

// core/accident_detector.py
export const ACCIDENT_THRESHOLDS = {
  critical: 81,
  high: 61,
  moderate: 31,
};

export const TARGET_INFERENCE_FPS = 20;
export const TELEMETRY_PUBLISH_MS = 200;
export const SERIES_SAMPLE_MS = 250;
export const SERIES_LIMIT = 120;
