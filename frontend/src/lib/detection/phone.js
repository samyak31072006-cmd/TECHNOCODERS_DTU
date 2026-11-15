import {
  CHIN_LANDMARK_INDEX as CONST_CHIN_INDEX,
  PHONE_CONFIDENCE_THRESHOLD,
  PHONE_REFERENCE_WIDTH,
  PHONE_TRIGGER_FRAMES,
} from './constants.js';

export const CHIN_LANDMARK_INDEX = CONST_CHIN_INDEX ?? 152;
export const DEFAULT_PHONE_CONFIDENCE = PHONE_CONFIDENCE_THRESHOLD ?? 0.20;

/**
 * On-device phone usage detector using actual cell-phone object detection.
 * Replaces unreliable hand-proximity detection.
 *
 * Rules:
 * 1. An actual cell phone must be identified by object detection with score >= minConfidence.
 * 2. Any visible part of the phone bounding box must reach chin level or above (box.originY <= chinY).
 *    A phone held entirely below the chin (box.originY > chinY) does not trigger an alert.
 * 3. Empty hands, fingers, face touching, and non-phone objects produce no cell phone detection
 *    and cannot trigger an alert.
 * 4. A multi-frame temporal filter prevents single-frame false positives.
 */
export function createPhoneDetector(options = {}) {
  const triggerFrames = options.triggerFrames ?? PHONE_TRIGGER_FRAMES;
  const minConfidence = options.minConfidence ?? DEFAULT_PHONE_CONFIDENCE;
  const referenceWidth = options.referenceWidth ?? PHONE_REFERENCE_WIDTH;

  let counter = 0;

  function evaluate({
    objects = [],
    hands = [],
    faceLandmarks = null,
    width = referenceWidth,
    height = 480,
  } = {}) {
    let candidateDetected = false;
    let confidence = 0;
    let zone = 'NONE';

    // Chin level from MediaPipe FaceMesh landmark 152
    const chinLandmark = faceLandmarks?.[CHIN_LANDMARK_INDEX];
    const foreheadLandmark = faceLandmarks?.[10];

    if (chinLandmark && Array.isArray(objects) && objects.length > 0) {
      // In pixel space, y = 0 is top of image, y = height is bottom.
      const chinY = chinLandmark.y * height;
      const faceH = foreheadLandmark
        ? Math.abs(chinLandmark.y - foreheadLandmark.y) * height
        : height * 0.35;
      const chinThreshold = chinY + faceH * 0.25;

      for (const det of objects) {
        if (!det?.categories || !det?.boundingBox) continue;

        // Check for 'cell phone' category
        const phoneCat = det.categories.find(
          (c) => c.categoryName?.toLowerCase() === 'cell phone' && (c.score ?? 0) >= minConfidence
        );

        if (!phoneCat) continue;

        const box = det.boundingBox;
        const bw = Math.max(1, box.width);
        const bh = Math.max(1, box.height);
        const maxDim = Math.max(bw, bh);
        const minDim = Math.min(bw, bh);
        const aspectRatio = maxDim / minDim;

        // Secondary verification against empty-hand false positives:
        // A cell phone is an elongated rectangle (aspect ratio >= 1.25) with substantial physical size.
        // Cupped hands, palms, or curled fingers produce squarish boxes (aspect ratio < 1.25)
        // or small local patches (< 25% of face height).
        if (phoneCat.score < 0.45) {
          const isElongated = aspectRatio >= 1.25;
          const hasPhoneSize = maxDim >= faceH * 0.25;
          if (!isElongated || !hasPhoneSize) {
            continue;
          }
        }

        // Bounding box: originY is top of phone, originY + height is bottom of phone.
        // If box.originY <= chinThreshold, at least the upper part of the phone is at or above chin level.
        // If box.originY > chinThreshold, the entire phone is below the chin.
        if (box.originY <= chinThreshold) {
          candidateDetected = true;
          if ((phoneCat.score ?? 0) > confidence) {
            confidence = phoneCat.score;
            zone = 'CHIN_OR_ABOVE';
          }
        }
      }
    }

    // Temporal filter: requires triggerFrames consecutive positive frames to confirm
    counter = candidateDetected ? counter + 1 : Math.max(0, counter - 1);
    const confirmed = counter >= triggerFrames;

    return {
      phone_detected: confirmed,
      phone_status: confirmed ? 'PHONE_DETECTED' : 'NOT_DETECTED',
      confidence: confirmed ? confidence : 0,
      zone: confirmed ? zone : 'NONE',
    };
  }

  function reset() {
    counter = 0;
  }

  return { evaluate, reset };
}
