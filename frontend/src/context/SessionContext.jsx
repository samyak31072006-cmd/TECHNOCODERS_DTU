import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { useToast } from '../components/ui/toast';
import {
  SERIES_LIMIT,
  SERIES_SAMPLE_MS,
  TARGET_INFERENCE_FPS,
  TELEMETRY_PUBLISH_MS,
  analyzeEyes,
  combineRiskLevel,
  createDrowsinessDetector,
  createPhoneDetector,
  evaluateRisk,
  numericRiskScore,
  scoreIncident,
} from '../lib/detection';
import { createVisionEngine } from '../lib/vision';
import { loadJson, saveJson } from '../lib/storage';
import { resumeGesture, setAlarm, stopAlarm } from '../lib/alarm';

export const ACTIVE_STATUSES = ['VERIFYING', 'CRITICAL_ACCIDENT', 'CONFIRMED', 'HELP_REQUESTED'];

const SEED_CONTACTS = [
  {
    id: 'CNT-001',
    name: 'Sample contact - primary',
    relationship: 'Placeholder (replace with a real contact)',
    phone: '+91 90000 00001',
    priority: 1,
    active: true,
    is_sample: true,
  },
  {
    id: 'CNT-002',
    name: 'Sample contact - fleet desk',
    relationship: 'Placeholder (replace with a real contact)',
    phone: '+91 90000 00002',
    priority: 2,
    active: true,
    is_sample: true,
  },
];

const DISPATCH_CHANNELS = ['Fleet dispatch gateway', 'Police control room', 'Ambulance dispatch'];

/**
 * Telemetry is never null. Before a session exists the app renders this shape,
 * so every page keeps its panels and can show an honest empty state instead of
 * a skeleton that never resolves.
 */
export const IDLE_TELEMETRY = {
  status: 'NO_DRIVER',
  face_status: 'NO_DRIVER',
  face_count: 0,
  left_ear: 0,
  right_ear: 0,
  average_ear: 0,
  is_eyes_closed: false,
  closed_duration: 0,
  drowsiness_events: 0,
  longest_closure: 0,
  session_avg_ear: 0,
  phone_detected: false,
  phone_status: 'NOT_DETECTED',
  risk_level: 'LOW',
  risk_score: 0,
  fps: 0,
  is_monitoring: false,
  demo_mode: false,
  monitoring_duration: 0,
  monitoring_duration_formatted: '00:00:00',
  has_session: false,
};

export const NO_SESSION_MESSAGE = 'No active session - start the camera to collect telemetry';

function loadArray(key, fallback) {
  const value = loadJson(key, fallback);
  return Array.isArray(value) ? value : fallback;
}

const SessionContext = createContext(null);

const nowTime = () => new Date().toLocaleTimeString([], { hour12: false });
const nowDate = () => new Date().toISOString().slice(0, 10);

function newId(prefix) {
  const random = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 8)
    : Math.random().toString(16).slice(2, 10);
  return `${prefix}-${random.toUpperCase()}`;
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = String(Math.floor(total / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const secs = String(total % 60).padStart(2, '0');
  return `${hours}:${minutes}:${secs}`;
}

function simulateEar(elapsedSeconds) {
  const phase = elapsedSeconds % 26;
  const baseline = 0.29 + Math.sin(elapsedSeconds * 1.4) * 0.02;
  if (phase > 16 && phase < 20) {
    // Four seconds of closed eyes, enough to cross CAUTION and DROWSY.
    return 0.1 + Math.abs(Math.sin(elapsedSeconds * 7)) * 0.025;
  }
  return baseline;
}

export function SessionProvider({ children }) {
  const { pushToast } = useToast();

  const [demoMode, setDemoMode] = useState(() => Boolean(loadJson('demoMode', true)));
  const [cameraState, setCameraState] = useState('idle'); // idle | requesting | running | error | unsupported
  const [cameraError, setCameraError] = useState(null);
  const [devices, setDevices] = useState([]);
  const [deviceId, setDeviceId] = useState(null);
  const [resolution, setResolution] = useState(null);
  const [engineStatus, setEngineStatus] = useState({ state: 'idle', delegate: null, message: 'Models not loaded' });
  const [engineError, setEngineError] = useState(null);
  const [telemetry, setTelemetry] = useState(IDLE_TELEMETRY);
  const [lastSession, setLastSession] = useState(null);
  const [alerts, setAlerts] = useState(() => loadArray('alerts', []));
  const [incidents, setIncidents] = useState(() => loadArray('incidents', []));
  const [contacts, setContacts] = useState(() => loadArray('contacts', SEED_CONTACTS));
  const [paused, setPaused] = useState(false);
  const [framesProcessed, setFramesProcessed] = useState(0);
  const [inferenceFps, setInferenceFps] = useState(0);
  const [lastInferenceMs, setLastInferenceMs] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [series, setSeries] = useState([]);
  const [location, setLocation] = useState(null);
  const [locationError, setLocationError] = useState(null);
  const [localBackend, setLocalBackend] = useState('unknown');

  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const engineRef = useRef(null);
  const rafRef = useRef(null);
  const drowsinessRef = useRef(createDrowsinessDetector());
  const phoneRef = useRef(createPhoneDetector());
  const telemetryRef = useRef(null);
  const sessionStartRef = useRef(null);
  const lastVideoTimeRef = useRef(-1);
  const lastRunRef = useRef(0);
  const lastPublishRef = useRef(0);
  const lastSampleRef = useRef(0);
  const frameTimesRef = useRef([]);
  const framesRef = useRef(0);
  const pausedRef = useRef(false);
  const demoRef = useRef(demoMode);
  const lastStatusRef = useRef('AWAKE');
  const phoneWasRef = useRef(false);
  const deviceIdRef = useRef(null);
  const mountedRef = useRef(true);
  const demoStartRef = useRef(Date.now());

  demoRef.current = demoMode;

  const pushAlert = useCallback(
    (alert) => {
      setAlerts((prev) => {
        const entry = {
          id: newId('ALT'),
          timestamp: nowTime(),
          date: nowDate(),
          acknowledged: false,
          ...alert,
        };
        const next = [entry, ...prev].slice(0, 100);
        saveJson('alerts', next);
        return next;
      });
    },
    [],
  );

  const publishTelemetry = useCallback((patch, extra = {}) => {
    const duration = sessionStartRef.current ? (Date.now() - sessionStartRef.current) / 1000 : 0;
    const base = {
      ...telemetryRef.current,
      ...patch,
      monitoring_duration: duration,
      monitoring_duration_formatted: formatDuration(duration),
      ...extra,
    };
    telemetryRef.current = base;
    if (!mountedRef.current) return;
    setTelemetry(base);
    setLastUpdate(Date.now());
  }, []);

  /**
   * Mirror of server.py:261 — the alarm fires when the driver is drowsy, the
   * risk level is CRITICAL, or a phone is detected. It is continuous: it keeps
   * sounding until the condition clears, so a driver who is falling asleep
   * cannot miss a one-off beep.
   *
   * The empty telemetry heartbeat (publishTelemetry({})) intentionally does
   * not re-evaluate here, so the alarm state only changes on real data.
   */
  const evaluateAlarm = useCallback((patch) => {
    const shouldAlarm =
      patch.status === 'DROWSY' ||
      patch.risk_level === 'CRITICAL' ||
      Boolean(patch.phone_detected);
    setAlarm(shouldAlarm);
  }, []);

  const sampleSeries = useCallback((patch) => {
    const now = Date.now();
    if (now - lastSampleRef.current < SERIES_SAMPLE_MS) return;
    lastSampleRef.current = now;
    const point = {
      t: now,
      risk: patch.risk_score ?? 0,
      ear: patch.average_ear ?? 0,
      fps: patch.fps ?? 0,
    };
    setSeries((prev) => [...prev, point].slice(-SERIES_LIMIT));
  }, []);

  const stopLoop = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const stopCamera = useCallback(() => {
    stopLoop();
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    lastVideoTimeRef.current = -1;
    setCameraState((current) => (current === 'error' ? current : 'idle'));
  }, [stopLoop]);

  const handleFrame = useCallback(
    (out, video, now) => {
      const faceCount = out.faces.length;
      const faceStatus = faceCount === 0 ? 'NO_DRIVER' : faceCount > 1 ? 'MULTIPLE_FACES' : 'SINGLE_FACE';
      const eyes = faceCount ? analyzeEyes(out.faces[0], video.videoWidth, video.videoHeight) : analyzeEyes(null, 0, 0);
      const phone = phoneRef.current.evaluate({
        objects: out.objects,
        hands: out.hands,
        faceLandmarks: faceCount ? out.faces[0] : null,
        width: video.videoWidth,
        height: video.videoHeight,
      });
      const drowsy = drowsinessRef.current.update(eyes.average_ear, faceStatus, now);

      const riskLevel = combineRiskLevel(
        evaluateRisk({
          status: drowsy.status,
          closedDuration: drowsy.closed_duration,
          events: drowsy.drowsiness_events,
          faceStatus,
        }),
        phone.phone_detected,
      );
      const riskScore = numericRiskScore({
        status: drowsy.status,
        closedDuration: drowsy.closed_duration,
        events: drowsy.drowsiness_events,
        phoneDetected: phone.phone_detected,
        faceStatus,
      });

      if (drowsy.status === 'DROWSY' && lastStatusRef.current !== 'DROWSY') {
        pushAlert({
          type: 'Drowsiness',
          severity: 'CRITICAL',
          message: `Eyes closed for ${drowsy.closed_duration.toFixed(1)} s (threshold 2.0 s).`,
        });
        pushToast({ tone: 'danger', title: 'Drowsiness alert', message: 'Eyes closed beyond the threshold.' });
      }
      if (phone.phone_detected && !phoneWasRef.current) {
        pushAlert({
          type: 'Phone distraction',
          severity: 'HIGH',
          message: 'Cell phone detected at or above chin level.',
        });
        pushToast({ tone: 'warn', title: 'Phone detected', message: 'Cell phone in use.' });
      }
      lastStatusRef.current = drowsy.status;
      phoneWasRef.current = phone.phone_detected;

      const patch = {
        status: drowsy.status,
        face_status: faceStatus,
        face_count: faceCount,
        left_ear: eyes.left_ear,
        right_ear: eyes.right_ear,
        average_ear: eyes.average_ear,
        is_eyes_closed: drowsy.is_eyes_closed,
        closed_duration: drowsy.closed_duration,
        drowsiness_events: drowsy.drowsiness_events,
        longest_closure: drowsy.longest_closure,
        session_avg_ear: drowsy.session_avg_ear,
        phone_detected: phone.phone_detected,
        phone_status: phone.phone_status,
        risk_level: riskLevel,
        risk_score: riskScore,
        fps: 0,
        is_monitoring: true,
        demo_mode: false,
      };

      return patch;
    },
    [pushAlert, pushToast],
  );

  const startLoop = useCallback(() => {
    stopLoop();
    const tick = () => {
      rafRef.current = requestAnimationFrame(tick);
      if (pausedRef.current || demoRef.current) return;

      const video = videoRef.current;
      const engine = engineRef.current;
      if (!video || !engine) return;

      const now = performance.now();
      if (now - lastRunRef.current < 1000 / TARGET_INFERENCE_FPS) return;
      lastRunRef.current = now;
      if (video.readyState < 2 || !video.videoWidth) return;
      if (video.currentTime === lastVideoTimeRef.current) return;
      lastVideoTimeRef.current = video.currentTime;

      const startedAt = performance.now();
      let out;
      try {
        out = engine.detect(video, now);
      } catch (error) {
        setEngineError(`Inference failed: ${error.message}`);
        return;
      }
      const inferenceMs = performance.now() - startedAt;

      frameTimesRef.current.push(performance.now());
      frameTimesRef.current = frameTimesRef.current.filter((time) => performance.now() - time < 1000);
      const fps = frameTimesRef.current.length;

      framesRef.current += 1;
      const patch = handleFrame(out, video, now);
      patch.fps = fps;

      if (now - lastPublishRef.current >= TELEMETRY_PUBLISH_MS) {
        lastPublishRef.current = now;
        publishTelemetry(patch);
        evaluateAlarm(patch);
        sampleSeries(patch);
        setFramesProcessed(framesRef.current);
        setInferenceFps(fps);
        setLastInferenceMs(Math.round(inferenceMs));
      }
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [handleFrame, publishTelemetry, sampleSeries, stopLoop, evaluateAlarm]);

  const listDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const cameras = all
        .filter((device) => device.kind === 'videoinput')
        .map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label || `Camera ${index + 1}`,
        }));
      setDevices(cameras);
    } catch (error) {
      setDevices([]);
    }
  }, []);

  const ensureEngine = useCallback(async () => {
    if (engineRef.current) return engineRef.current;
    setEngineStatus({ state: 'loading', delegate: null, message: 'Loading vision models' });
    setEngineError(null);
    try {
      const engine = await createVisionEngine({
        onStatus: (state, message) =>
          setEngineStatus((prev) => ({ ...prev, state, message, delegate: prev.delegate })),
      });
      engineRef.current = engine;
      setEngineStatus({ state: 'ready', delegate: engine.delegate, message: `Vision models ready (${engine.delegate})` });
      return engine;
    } catch (error) {
      setEngineStatus({ state: 'error', delegate: null, message: error.message });
      setEngineError(
        `Could not load the on-device models. ${error.message}. Check that /models and /wasm were deployed.`,
      );
      return null;
    }
  }, []);

  const startCamera = useCallback(
    async (requestedDeviceId) => {
      if (demoRef.current) return true;
      // Unlock audio on the first real user gesture; browsers block sound
      // until the page has been clicked or keyed.
      resumeGesture();
      setCameraError(null);

      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraState('unsupported');
        setCameraError('This browser does not expose a camera API (getUserMedia). Use a modern browser over HTTPS.');
        return false;
      }

      setCameraState('requesting');
      stopLoop();
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }

      const targetId = requestedDeviceId || deviceIdRef.current;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: targetId
            ? { deviceId: { exact: targetId }, width: { ideal: 640 }, height: { ideal: 480 } }
            : { width: { ideal: 640 }, height: { ideal: 480 } },
          audio: false,
        });
        if (!mountedRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          return false;
        }
        streamRef.current = stream;

        const track = stream.getVideoTracks()[0];
        const settings = track?.getSettings ? track.getSettings() : {};
        setResolution({ width: settings.width || 0, height: settings.height || 0 });
        if (settings.deviceId) {
          deviceIdRef.current = settings.deviceId;
          setDeviceId(settings.deviceId);
        }

        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play().catch(() => {});
        }

        await listDevices();
        const engine = await ensureEngine();
        if (!engine) {
          setCameraState('error');
          return false;
        }

        if (!sessionStartRef.current) sessionStartRef.current = Date.now();
        lastVideoTimeRef.current = -1;
        lastRunRef.current = 0;
        setCameraState('running');
        startLoop();
        return true;
      } catch (error) {
        setCameraState('error');
        setCameraError(
          error?.name === 'NotAllowedError'
            ? 'Camera permission was denied. Grant it in the browser address bar, then retry.'
            : error?.name === 'NotFoundError'
              ? 'No camera device was found on this machine.'
              : `Camera could not start: ${error.message}`,
        );
        return false;
      }
    },
    [ensureEngine, listDevices, startLoop, stopLoop],
  );

  const resetSession = useCallback(() => {
    drowsinessRef.current.reset();
    phoneRef.current.reset();
    sessionStartRef.current = Date.now();
    lastStatusRef.current = 'AWAKE';
    phoneWasRef.current = false;
    setSeries([]);
    setTelemetry({ ...IDLE_TELEMETRY });
    telemetryRef.current = { ...IDLE_TELEMETRY };
    framesRef.current = 0;
    setFramesProcessed(0);
    setInferenceFps(0);
    stopAlarm();
    return true;
  }, []);

  const setDemoModeSafe = useCallback(
    (next) => {
      const value = Boolean(next);
      setDemoMode(value);
      demoRef.current = value;
      saveJson('demoMode', value);
      resetSession();
      // Unlock audio on the toggle gesture so demo-mode alarms can play.
      resumeGesture();
      if (value) {
        stopLoop();
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
        }
        if (videoRef.current) videoRef.current.srcObject = null;
        setCameraState((current) => (current === 'error' ? current : 'idle'));
        demoStartRef.current = Date.now();
      }
      pushToast({
        tone: value ? 'warn' : 'signal',
        title: value ? 'Demo mode on' : 'Demo mode off',
        message: value
          ? 'Telemetry is synthesised from a scripted EAR waveform. Nothing is measured from a camera.'
          : 'Camera inference resumes when you start monitoring.',
      });
    },
    [pushToast, resetSession, stopLoop],
  );

  /* Demo mode: scripted EAR waveform pushed through the real state machine. */
  useEffect(() => {
    if (!demoMode) return undefined;
    demoStartRef.current = Date.now();
    sessionStartRef.current = Date.now();
    const timer = setInterval(() => {
      const elapsed = (Date.now() - demoStartRef.current) / 1000;
      const ear = simulateEar(elapsed);
      const drowsy = drowsinessRef.current.update(ear, 'SINGLE_FACE', performance.now());
      const phoneDetected = elapsed % 26 > 8 && elapsed % 26 < 11;

      const riskLevel = combineRiskLevel(
        evaluateRisk({
          status: drowsy.status,
          closedDuration: drowsy.closed_duration,
          events: drowsy.drowsiness_events,
          faceStatus: 'SINGLE_FACE',
        }),
        phoneDetected,
      );
      const riskScore = numericRiskScore({
        status: drowsy.status,
        closedDuration: drowsy.closed_duration,
        events: drowsy.drowsiness_events,
        phoneDetected,
        faceStatus: 'SINGLE_FACE',
      });

      if (drowsy.status === 'DROWSY' && lastStatusRef.current !== 'DROWSY') {
        pushAlert({
          type: 'Drowsiness (demo)',
          severity: 'CRITICAL',
          message: 'Simulated EAR waveform crossed the 2.0 s closure threshold.',
          demo: true,
        });
      }
      if (phoneDetected && !phoneWasRef.current) {
        pushAlert({
          type: 'Phone distraction (demo)',
          severity: 'HIGH',
          message: 'Simulated handheld-device window.',
          demo: true,
        });
      }
      lastStatusRef.current = drowsy.status;
      phoneWasRef.current = phoneDetected;

      const patch = {
        status: drowsy.status,
        face_status: 'SINGLE_FACE',
        face_count: 1,
        left_ear: ear,
        right_ear: ear,
        average_ear: ear,
        is_eyes_closed: drowsy.is_eyes_closed,
        closed_duration: drowsy.closed_duration,
        drowsiness_events: drowsy.drowsiness_events,
        longest_closure: drowsy.longest_closure,
        session_avg_ear: drowsy.session_avg_ear,
        phone_detected: phoneDetected,
        phone_status: phoneDetected ? 'PHONE_DETECTED' : 'NOT_DETECTED',
        risk_level: riskLevel,
        risk_score: riskScore,
        fps: null,
        is_monitoring: true,
        demo_mode: true,
};
      publishTelemetry(patch, { is_monitoring: true, demo_mode: true });
      evaluateAlarm(patch);
      sampleSeries(patch);
    }, 150);
    return () => clearInterval(timer);
  }, [demoMode, publishTelemetry, pushAlert, sampleSeries, evaluateAlarm]);

  /* Keep the session clock moving even when frames stop arriving. */
  useEffect(() => {
    const timer = setInterval(() => {
      if (!telemetryRef.current) return;
      publishTelemetry({});
    }, 1000);
    return () => clearInterval(timer);
  }, [publishTelemetry]);

  /* Pause inference while the tab is hidden. */
  useEffect(() => {
    const onVisibility = () => {
      const hidden = document.visibilityState === 'hidden';
      pausedRef.current = hidden;
      setPaused(hidden);
      if (!hidden) {
        lastVideoTimeRef.current = -1;
        lastRunRef.current = 0;
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  /* Optional local Flask backend: detected, never required. */
  useEffect(() => {
    const host = window.location.hostname;
    if (!['localhost', '127.0.0.1'].includes(host)) {
      setLocalBackend('absent');
      return undefined;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    fetch('/api/health', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          setLocalBackend('absent');
          return;
        }
        // A static file server answers every path with index.html, so require a
        // JSON body that actually looks like the Flask health payload.
        const payload = await response.json().catch(() => null);
        setLocalBackend(payload && typeof payload.status === 'string' ? 'available' : 'absent');
      })
      .catch(() => setLocalBackend('absent'))
      .finally(() => clearTimeout(timer));
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, []);

  /* Teardown */
  useEffect(() => {
    mountedRef.current = true;
    if (navigator.mediaDevices?.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', listDevices);
    }
    return () => {
      mountedRef.current = false;
      if (navigator.mediaDevices?.removeEventListener) {
        navigator.mediaDevices.removeEventListener('devicechange', listDevices);
      }
      stopLoop();
      if (streamRef.current) streamRef.current.getTracks().forEach((track) => track.stop());
      engineRef.current?.close?.();
      engineRef.current = null;
      stopAlarm();
    };
  }, [listDevices, stopLoop]);

  /* ------------------------------- alerts ------------------------------- */

  const acknowledgeAlert = useCallback((id) => {
    setAlerts((prev) => {
      const next = prev.map((alert) => (alert.id === id ? { ...alert, acknowledged: true } : alert));
      saveJson('alerts', next);
      return next;
    });
  }, []);

  const clearAcknowledged = useCallback(() => {
    setAlerts((prev) => {
      const next = prev.filter((alert) => !alert.acknowledged);
      saveJson('alerts', next);
      return next;
    });
  }, []);

  /* ------------------------------ contacts ------------------------------ */

  const addContact = useCallback(
    ({ name, relationship, phone, priority }) => {
      const trimmedName = String(name || '').trim();
      const trimmedPhone = String(phone || '').trim();
      if (!trimmedName || !trimmedPhone) {
        return { ok: false, error: 'A name and a phone number are required.' };
      }
      const contact = {
        id: `CNT-${String(contacts.length + 1).padStart(3, '0')}`,
        name: trimmedName,
        relationship: String(relationship || '').trim() || 'Contact',
        phone: trimmedPhone,
        priority: Number(priority) || 1,
        active: true,
        is_sample: false,
      };
      setContacts((prev) => {
        const next = [...prev, contact];
        saveJson('contacts', next);
        return next;
      });
      return { ok: true, contact };
    },
    [contacts.length],
  );

  /* ------------------------------ incidents ----------------------------- */

  const persistIncidents = useCallback((next) => {
    saveJson('incidents', next.slice(0, 20));
    return next.slice(0, 20);
  }, []);

  const makeNotifications = useCallback(() => {
    const timestamp = nowTime();
    const records = DISPATCH_CHANNELS.map((channel) => ({
      id: newId('NOTIF'),
      service: channel,
      status: 'SIMULATED_NOTIFIED',
      timestamp,
      delivery_channel: 'Simulated gateway (no provider configured)',
    }));
    contacts
      .filter((contact) => contact.active !== false)
      .forEach((contact) => {
        records.push({
          id: newId('NOTIF'),
          service: `Contact: ${contact.name}`,
          status: 'SIMULATED_NOTIFIED',
          timestamp,
          delivery_channel: 'Simulated gateway (message not sent)',
        });
      });
    return records;
  }, [contacts]);

  const simulateIncident = useCallback(() => {
    const { confidence, severity, driverCondition } = scoreIncident({
      gForce: 5.4,
      speedDropKmh: 62,
      rotationDegSec: 45,
      driverStatus: telemetryRef.current?.status || 'AWAKE',
      eyeClosedDuration: telemetryRef.current?.closed_duration || 0,
      cvCollisionCue: true,
    });

    const timestamp = nowTime();
    const incident = {
      id: newId('INC'),
      incident_id: newId('NTK'),
      timestamp,
      date: nowDate(),
      created_at: Date.now(),
      confidence,
      severity,
      status: 'CONFIRMED',
      driver_condition: driverCondition,
      location,
      is_simulated: true,
      notifications: makeNotifications(),
      timeline: [
        {
          time: timestamp,
          title: 'Simulated impact',
          desc: 'Fixture payload: 5.4 g, 62 km/h speed drop, 45 deg/s rotation, CV collision cue.',
        },
        { time: timestamp, title: 'Confidence assessed', desc: `Confidence ${confidence}% - severity ${severity}.` },
        {
          time: timestamp,
          title: location ? 'Location attached' : 'No location available',
          desc: location
            ? `Browser geolocation, accuracy ${Math.round(location.accuracy_m || 0)} m.`
            : 'Geolocation was not granted, so the incident carries no coordinates.',
        },
        { time: timestamp, title: 'Dispatch recorded', desc: 'Every channel marked SIMULATED_NOTIFIED.' },
      ],
    };

    setIncidents((prev) => persistIncidents([incident, ...prev]));
    return incident;
  }, [location, makeNotifications, persistIncidents]);

  const respondToIncident = useCallback(
    (id, action) => {
      const labels = {
        cancel: { status: 'CANCELLED', title: "Driver marked safe", note: 'Cancelled from the browser session.' },
        help: { status: 'HELP_REQUESTED', title: 'Help requested', note: 'Dispatch remains simulated.' },
        resolve: { status: 'RESOLVED', title: 'Resolved', note: 'Closed from the browser session.' },
      };
      const label = labels[action];
      if (!label) return;
      setIncidents((prev) =>
        persistIncidents(
          prev.map((incident) =>
            incident.id === id
              ? {
                  ...incident,
                  status: label.status,
                  timeline: [
                    ...(incident.timeline || []),
                    { time: nowTime(), title: label.title, desc: label.note },
                  ],
                }
              : incident,
          ),
        ),
      );
    },
    [persistIncidents],
  );

  const cancelIncident = useCallback((id) => respondToIncident(id, 'cancel'), [respondToIncident]);
  const requestHelp = useCallback((id) => respondToIncident(id, 'help'), [respondToIncident]);
  const resolveIncident = useCallback((id) => respondToIncident(id, 'resolve'), [respondToIncident]);

  /* ----------------------------- geolocation ---------------------------- */

  const requestLocation = useCallback(
    () =>
      new Promise((resolve) => {
        if (!navigator.geolocation) {
          setLocationError('Geolocation is not available in this browser.');
          resolve(null);
          return;
        }
        navigator.geolocation.getCurrentPosition(
          (position) => {
            const captured = {
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
              accuracy_m: position.coords.accuracy,
              source: 'browser_geolocation',
              captured_at: new Date().toISOString(),
            };
            setLocation(captured);
            setLocationError(null);
            resolve(captured);
          },
          (error) => {
            setLocationError(
              error.code === error.PERMISSION_DENIED
                ? 'Location permission was denied. No coordinates will be attached.'
                : `Location unavailable: ${error.message}`,
            );
            resolve(null);
          },
          { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 },
        );
      }),
    [],
  );

  /* ------------------------------ derived ------------------------------- */

  const activeIncident = useMemo(
    () => incidents.find((incident) => ACTIVE_STATUSES.includes(incident.status)) || null,
    [incidents],
  );

  const detections = useMemo(() => {
    if (!telemetry) return null;
    const closed = Number(telemetry.closed_duration || 0).toFixed(1);
    return {
      eyes: {
        name: 'Eye aspect ratio',
        status: telemetry.is_eyes_closed ? 'CLOSED' : 'OPEN',
        value: `EAR ${Number(telemetry.average_ear || 0).toFixed(3)}`,
        connected: true,
      },
      face: {
        name: 'Face presence',
        status: telemetry.status || 'NO_DRIVER',
        value: `${telemetry.face_count ?? 0} face(s) in frame`,
        connected: true,
      },
      phone: {
        name: 'Phone usage',
        status: telemetry.phone_detected ? 'PHONE DETECTED' : 'NO PHONE DETECTED',
        value: telemetry.phone_detected ? 'Hand in ear/cheek zone' : 'No hand near the face',
        connected: true,
      },
      fatigue: {
        name: 'Drowsiness state machine',
        status: telemetry.status || 'AWAKE',
        value: `Closure ${closed} s`,
        connected: true,
      },
      alcohol: {
        name: 'Alcohol impairment sensor',
        status: 'NOT CONNECTED',
        value: 'No breath sensor exists in a browser build',
        connected: false,
      },
      vehicle: {
        name: 'Vehicle telemetry (speed, GPS)',
        status: 'NOT CONNECTED',
        value: 'No OBD or GPS receiver is reachable from the browser',
        connected: false,
      },
    };
  }, [telemetry]);

  const status = telemetry?.status || (cameraState === 'running' ? 'NO_DRIVER' : 'STANDBY');
  const riskScore = Number(telemetry?.risk_score ?? 0);
  const online = cameraState === 'running' ? true : cameraState === 'error' ? false : null;

  const value = useMemo(
    () => ({
      // camera
      cameraState,
      cameraError,
      cameraConnected: cameraState === 'running',
      devices,
      deviceId,
      resolution,
      stream: streamRef.current,
      paused,
      startCamera,
      stopCamera,
      selectDevice: (id) => startCamera(id),
      // engine + loop
      engineStatus,
      engineError,
      inferenceFps,
      lastInferenceMs,
      framesProcessed,
      delegate: engineStatus.delegate,
      // session data (shapes carried over from the server build)
      telemetry,
      status,
      riskScore,
      riskLevel: telemetry?.risk_level || 'LOW',
      averageEar: Number(telemetry?.average_ear ?? 0),
      fps: inferenceFps,
      isMonitoring: Boolean(telemetry?.is_monitoring) && !paused,
      demoMode,
      setDemoMode: setDemoModeSafe,
      series,
      alerts,
      detections,
      activeIncident,
      incidents,
      contacts,
      location,
      locationError,
      requestLocation,
      localBackend,
      online,
      lastUpdate,
      // actions
      acknowledgeAlert,
      clearAcknowledged,
      refreshAlerts: () => {},
      resetSession,
      startMonitoring: () => startCamera(),
      stopMonitoring: () => {
        stopCamera();
      },
      refresh: () => {
        if (cameraState === 'running') {
          startCamera(deviceIdRef.current);
        } else {
          startCamera();
        }
      },
      simulateIncident,
      cancelIncident,
      requestHelp,
      resolveIncident,
      addContact,
    }),
    [
      acknowledgeAlert,
      activeIncident,
      addContact,
      alerts,
      cameraError,
      cameraState,
      cancelIncident,
      clearAcknowledged,
      contacts,
      demoMode,
      detections,
      deviceId,
      devices,
      engineError,
      engineStatus,
      framesProcessed,
      incidents,
      inferenceFps,
      lastInferenceMs,
      lastUpdate,
      localBackend,
      location,
      locationError,
      online,
      paused,
      requestHelp,
      requestLocation,
      resolution,
      resetSession,
      riskScore,
      series,
      setDemoModeSafe,
      simulateIncident,
      startCamera,
      status,
      stopCamera,
      telemetry,
      resolveIncident,
    ],
  );

  return (
    <SessionContext.Provider value={value}>
      {children}
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        className="pointer-events-none fixed left-0 top-0 size-px opacity-0"
        aria-hidden="true"
      />
    </SessionContext.Provider>
  );
}

export function useSession() {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside SessionProvider');
  return context;
}

/** Backwards-compatible alias: pages imported useSystem from the server build. */
export const useSystem = useSession;
