import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, AppStateStatus, Image, Platform, ScrollView, StyleSheet, Text, TouchableOpacity, useWindowDimensions, View } from 'react-native';
import { captureRef } from 'react-native-view-shot';
import { Camera, CameraView } from 'expo-camera';
import { File, Paths } from 'expo-file-system';
import TextRecognition from '@react-native-ml-kit/text-recognition';
import * as Haptics from 'expo-haptics';
import * as Location from 'expo-location';
import * as MediaLibrary from 'expo-media-library';
import Constants from 'expo-constants';
import { useFocusEffect } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';

import { ScreenContainer } from '@/components/screen-container';
import { DEFAULT_SCANNER_SETTINGS, loadScannerSettings, type ScannerSettings } from '@/lib/scanner-settings';

const IMPORTED_PLATES_STORAGE_KEY = 'imported_plates';
const NOTIFICATION_RULES_STORAGE_KEY = 'notification_rules';
const GLOBAL_NOTIFICATIONS_KEY = 'global_notifications_active';
const SAVE_DETECTION_IMAGE_STORAGE_KEY = 'save_detection_image';
const ALL_DETECTIONS_STORAGE_KEY = 'all_scanned_plate_detections';
const RECENT_REGISTRATIONS_STORAGE_KEY = 'recent_matched_plate_registrations';
const INVALID_OCR_DEDUPLICATION_KEY = '__INVALID_OCR_RESULT__';
const ZOOM_STORAGE_KEY = 'camera_zoom_index';
const MATCHED_PLATES_FILE_NAME = 'matriculas_detectadas.csv';

const LOCATION_MAX_AGE_MS = 30_000;
const LOCATION_MAX_ACCURACY_METERS = 75;
const LOCATION_UPDATE_DISTANCE_METERS = 5;
const APP_VERSION = Constants.expoConfig?.version ?? '1.0.0';

const ZOOM_PRESETS = [0.0, 0.2, 0.33, 0.66];
const ZOOM_LABELS = ['1x', '1.5x', '2x', '4x'];

const getMatchedPlatesFile = () => new File(Paths.document, MATCHED_PLATES_FILE_NAME);

type ScanMode = 'manual' | 'video';
type GpsStatus = 'checking' | 'active' | 'permission_denied' | 'services_disabled' | 'waiting' | 'unavailable';

type StandardToastType = 'success' | 'warning' | 'error';

interface StandardToast {
  id: string;
  message: string;
  type: StandardToastType;
}

interface CustomToast {
  id: string;
  message: string;
}

interface ScannedPlateItem {
  plate: string;
  isInRegistry: boolean;
}

interface StoredDetection {
  plate: string;
  timestamp?: number;
}

interface NotificationRule {
  plate: string;
  message: string;
  active: boolean;
}

interface DetectionEvidence {
  photoUri: string;
  photoWidth: number;
  photoHeight: number;
  standardMessage: string;
  customMessage: string | null;
  date: string;
  time: string;
  coordinates: string | null;
}

type ImportedPlateStore = Record<string, { fecha?: string; hora?: string }>;

function parseImportedPlateStore(rawValue: string | null): ImportedPlateStore {
  if (!rawValue) return {};

  try {
    const parsed = JSON.parse(rawValue);
    if (Array.isArray(parsed)) {
      return parsed.reduce<ImportedPlateStore>((store, plate) => {
        if (typeof plate === 'string' && plate.trim()) store[plate.trim().toUpperCase()] = {};
        return store;
      }, {});
    }

    if (parsed && typeof parsed === 'object') {
      return Object.keys(parsed).reduce<ImportedPlateStore>((store, plate) => {
        const value = parsed[plate] ?? {};
        store[plate.toUpperCase()] = {
          fecha: typeof value.fecha === 'string' ? value.fecha : '',
          hora: typeof value.hora === 'string' ? value.hora : '',
        };
        return store;
      }, {});
    }
  } catch (error) {
    console.error('Error parsing imported plates:', error);
  }

  return {};
}

function parseStoredDetections(rawValue: string | null): StoredDetection[] {
  if (!rawValue) return [];

  try {
    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) return [];

    return parsed.reduce<StoredDetection[]>((entries, entry) => {
      const plate = typeof entry === 'string' ? entry : entry?.plate;
      const timestamp = typeof entry === 'object' && typeof entry?.timestamp === 'number' ? entry.timestamp : undefined;
      if (typeof plate === 'string' && plate.trim()) entries.push({ plate: plate.trim().toUpperCase(), timestamp });
      return entries;
    }, []);
  } catch (error) {
    console.error('Error parsing stored detections:', error);
    return [];
  }
}

function isFreshAccurateLocation(location: Location.LocationObject | null): location is Location.LocationObject {
  if (!location) return false;
  const accuracy = location.coords.accuracy ?? Number.POSITIVE_INFINITY;
  return Date.now() - location.timestamp <= LOCATION_MAX_AGE_MS && accuracy <= LOCATION_MAX_ACCURACY_METERS;
}

export default function HomeScreen() {
  const [hasInitialPermissions, setHasInitialPermissions] = useState<boolean | null>(null);
  const [initialPermissionError, setInitialPermissionError] = useState<string | null>(null);
  const [scannedPlates, setScannedPlates] = useState<ScannedPlateItem[]>([]);
  const [cameraReady, setCameraReady] = useState(false);
  const [frameColor, setFrameColor] = useState<'blue' | 'red'>('blue');
  const [importedPlates, setImportedPlates] = useState<ImportedPlateStore>({});
  const [notificationRules, setNotificationRules] = useState<Record<string, NotificationRule>>({});
  const [globalNotificationsActive, setGlobalNotificationsActive] = useState(true);
  const [standardToast, setStandardToast] = useState<StandardToast | null>(null);
  const [customToast, setCustomToast] = useState<CustomToast | null>(null);
  const [zoomIndex, setZoomIndex] = useState(0);
  const [isTorchOn, setIsTorchOn] = useState(false);
  const [gpsStatus, setGpsStatus] = useState<GpsStatus>('checking');
  const [scanMode, setScanMode] = useState<ScanMode>('manual');
  const [isScreenFocused, setIsScreenFocused] = useState(false);
  const [isAppActive, setIsAppActive] = useState(AppState.currentState === 'active');
  const [scannerSettings, setScannerSettings] = useState<ScannerSettings>(DEFAULT_SCANNER_SETTINGS);
  const [detectionEvidence, setDetectionEvidence] = useState<DetectionEvidence | null>(null);
  const [evidenceImageLoaded, setEvidenceImageLoaded] = useState(false);
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();

  const evidenceWidth = Math.min(windowWidth, windowHeight);
  const evidenceHeight = Math.max(windowWidth, windowHeight);

  const cameraRef = useRef<CameraView>(null);
  const evidenceViewRef = useRef<View>(null);
  const evidenceCaptureInProgressRef = useRef(false);
  const evidenceCaptureFrameRef = useRef<number | null>(null);
  const saveDetectionImageRef = useRef(false);
  const standardToastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const customToastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const zoomIndexRef = useRef(0);
  const appState = useRef(AppState.currentState);
  const importedPlatesRef = useRef<ImportedPlateStore>({});
  const notificationRulesRef = useRef<Record<string, NotificationRule>>({});
  const globalNotificationsRef = useRef(true);
  const scanModeRef = useRef<ScanMode>('manual');
  const isScreenFocusedRef = useRef(false);
  const isAppActiveRef = useRef(AppState.currentState === 'active');
  const isProcessingRef = useRef(false);
  const latestLocationRef = useRef<Location.LocationObject | null>(null);
  const locationSubscriptionRef = useRef<Location.LocationSubscription | null>(null);
const isStartingLocationRef = useRef(false);
const videoIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recentDetectionAtRef = useRef<Map<string, number>>(new Map());
const scannerSettingsRef = useRef<ScannerSettings>(DEFAULT_SCANNER_SETTINGS);

const showStandardToast = (message: string, type: StandardToastType) => {
if (standardToastTimeoutRef.current) clearTimeout(standardToastTimeoutRef.current);
const toastId = Date.now().toString();
setStandardToast({ id: toastId, message, type });
    const duration = Math.round(scannerSettingsRef.current.standardToastDurationSeconds * 1_000);
standardToastTimeoutRef.current = setTimeout(() => setStandardToast(null), duration);
};

const showCustomToast = (message: string) => {
if (customToastTimeoutRef.current) clearTimeout(customToastTimeoutRef.current);
const toastId = `${Date.now()}-custom`;
setCustomToast({ id: toastId, message });
    const duration = Math.round(scannerSettingsRef.current.customToastDurationSeconds * 1_000);
customToastTimeoutRef.current = setTimeout(() => setCustomToast(null), duration);
};

  const persistZoomIndex = async (index: number) => {
    try {
      await AsyncStorage.setItem(ZOOM_STORAGE_KEY, index.toString());
    } catch (error) {
      console.error('Error saving zoom preset:', error);
    }
  };

  const restoreSavedZoom = async () => {
    try {
      const savedZoom = await AsyncStorage.getItem(ZOOM_STORAGE_KEY);
      const parsed = savedZoom === null ? zoomIndexRef.current : Number.parseInt(savedZoom, 10);
      const restoredIndex = !Number.isNaN(parsed) && parsed >= 0 && parsed < ZOOM_PRESETS.length ? parsed : 0;

      zoomIndexRef.current = restoredIndex;
      setZoomIndex(restoredIndex);
    } catch (error) {
      console.error('Error loading saved zoom:', error);
    }
  };

  const stopLocationTracking = () => {
    locationSubscriptionRef.current?.remove();
    locationSubscriptionRef.current = null;
  };

  const pauseCameraPreview = async () => {
    setCameraReady(false);
    try {
      await cameraRef.current?.pausePreview();
    } catch (error) {
      console.warn('Error pausing camera preview:', error);
    }
  };

  const resumeCameraPreview = async () => {
    try {
      if (!cameraRef.current) return;
      await cameraRef.current.resumePreview();
      if (isAppActiveRef.current && isScreenFocusedRef.current) setCameraReady(true);
    } catch (error) {
      console.warn('Error resuming camera preview:', error);
      setCameraReady(false);
    }
  };

  const acceptLocation = (location: Location.LocationObject) => {
    latestLocationRef.current = location;
    setGpsStatus(isFreshAccurateLocation(location) ? 'active' : 'waiting');
  };

  const ensureLocationTracking = async () => {
    if (Platform.OS === 'web') {
      setGpsStatus('unavailable');
      return;
    }
    if (isStartingLocationRef.current || locationSubscriptionRef.current) return;

    isStartingLocationRef.current = true;
    setGpsStatus('checking');

    try {
      let permission = await Location.getForegroundPermissionsAsync();
      if (permission.status !== 'granted') permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== 'granted') {
        latestLocationRef.current = null;
        setGpsStatus('permission_denied');
        return;
      }

      const servicesEnabled = await Location.hasServicesEnabledAsync();
      if (!servicesEnabled) {
        latestLocationRef.current = null;
        stopLocationTracking();
        setGpsStatus('services_disabled');
        return;
      }

      setGpsStatus('waiting');
      const lastKnown = await Location.getLastKnownPositionAsync({
        maxAge: LOCATION_MAX_AGE_MS,
        requiredAccuracy: LOCATION_MAX_ACCURACY_METERS,
      });
      if (lastKnown) acceptLocation(lastKnown);

      locationSubscriptionRef.current = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.High,
          timeInterval: scannerSettingsRef.current.gpsUpdateIntervalSeconds * 1_000,
          distanceInterval: LOCATION_UPDATE_DISTANCE_METERS,
          mayShowUserSettingsDialog: true,
        },
        acceptLocation,
        () => setGpsStatus('unavailable'),
      );
    } catch (error) {
      console.error('Error starting location tracking:', error);
      setGpsStatus('unavailable');
    } finally {
      isStartingLocationRef.current = false;
    }
  };

  const refreshLocationService = async () => {
    if (Platform.OS === 'web') {
      setGpsStatus('unavailable');
      return;
    }

    try {
      const permission = await Location.getForegroundPermissionsAsync();
      if (permission.status !== 'granted') {
        latestLocationRef.current = null;
        stopLocationTracking();
        setGpsStatus('permission_denied');
        return;
      }

      const servicesEnabled = await Location.hasServicesEnabledAsync();
      if (!servicesEnabled) {
        latestLocationRef.current = null;
        stopLocationTracking();
        setGpsStatus('services_disabled');
        return;
      }

      if (!locationSubscriptionRef.current) void ensureLocationTracking();
    } catch (error) {
      console.error('Error refreshing location service:', error);
      setGpsStatus('unavailable');
    }
  };

  const getFreshLocationForRegistration = async () => {
    await refreshLocationService();
    const location = latestLocationRef.current;
    if (isFreshAccurateLocation(location)) return location;

    setGpsStatus('waiting');
    return null;
  };

  const loadNotificationSettings = async () => {
    try {
      const storedRules = await AsyncStorage.getItem(NOTIFICATION_RULES_STORAGE_KEY);
      if (storedRules) setNotificationRules(JSON.parse(storedRules));

      const storedGlobal = await AsyncStorage.getItem(GLOBAL_NOTIFICATIONS_KEY);
      if (storedGlobal !== null) setGlobalNotificationsActive(JSON.parse(storedGlobal));
    } catch (error) {
      console.error('Error loading notification settings:', error);
    }
  };

  const loadOperationalSettings = async () => {
    const settings = await loadScannerSettings();
    scannerSettingsRef.current = settings;
    setScannerSettings(settings);
  };

  const loadSaveDetectionImageSetting = async () => {
    try {
      const stored = await AsyncStorage.getItem(SAVE_DETECTION_IMAGE_STORAGE_KEY);
      const enabled = stored === 'true';
      saveDetectionImageRef.current = enabled;
    } catch (error) {
      console.error('Error loading image saving setting:', error);
    }
  };

  const scheduleDetectionEvidence = async (
    photoUri: string,
    photoWidth: number,
    photoHeight: number,
    standardMessage: string,
    customMessage: string | null,
    location: Location.LocationObject | null,
  ) => {
    if (!saveDetectionImageRef.current || Platform.OS === 'web') return;

    try {
      const permission = await MediaLibrary.getPermissionsAsync(true, ['photo']);
      let permissionGranted = permission.status === 'granted';

      if (!permissionGranted) {
        const requested = await MediaLibrary.requestPermissionsAsync(true, ['photo']);
        permissionGranted = requested.status === 'granted';
      }

      if (!permissionGranted) {
        console.warn('Permiso para guardar imágenes no concedido.');
        return;
      }

      const now = new Date();
      const coordinates = location
        ? `${location.coords.latitude}, ${location.coords.longitude}`
        : null;

      setEvidenceImageLoaded(false);
      setDetectionEvidence({
        photoUri,
        photoWidth,
        photoHeight,
        standardMessage,
        customMessage,
        date: now.toLocaleDateString('es-ES'),
        time: now.toLocaleTimeString('es-ES', { hour12: false }),
        coordinates,
      });
    } catch (error) {
      console.error('Error preparando evidencia de detección:', error);
    }
  };

  const loadRecentDetections = async () => {
    try {
      const rawValue = await AsyncStorage.getItem(RECENT_REGISTRATIONS_STORAGE_KEY);
      const stored = rawValue ? JSON.parse(rawValue) : {};
      const timestamps = new Map<string, number>(
        stored && typeof stored === 'object'
          ? Object.entries(stored).filter((entry): entry is [string, number] => typeof entry[1] === 'number')
          : [],
      );
      const knownDetections = await readAllDetectedPlates();
      knownDetections.forEach((entry) => {
        if (entry.timestamp) timestamps.set(entry.plate, entry.timestamp);
      });
      recentDetectionAtRef.current = timestamps;
    } catch (error) {
      console.error('Error loading recent detections:', error);
    }
  };

  const loadImportedPlates = async () => {
    const importedStore = parseImportedPlateStore(await AsyncStorage.getItem(IMPORTED_PLATES_STORAGE_KEY));
    setImportedPlates(importedStore);
  };

  const readAllDetectedPlates = async (): Promise<StoredDetection[]> => {
    const rawStored = await AsyncStorage.getItem(ALL_DETECTIONS_STORAGE_KEY);

    // Si la clave existe, incluso aunque contenga [], respetamos ese estado.
    // Esto permite que la X de la pantalla principal vacíe la lista sin
    // que el CSV vuelva a rellenarla al recuperar el foco.
    if (rawStored !== null) return parseStoredDetections(rawStored);

    try {
      const legacyFile = getMatchedPlatesFile();
      if (!(await legacyFile.info()).exists) return [];
      const migrated = (await legacyFile.text())
        .split('\n')
        .filter(Boolean)
        .slice(1)
        .map((line) => line.split(',')[0]?.trim().toUpperCase())
        .filter((plate): plate is string => Boolean(plate))
        .map((plate) => ({ plate }));
      if (migrated.length > 0) await AsyncStorage.setItem(ALL_DETECTIONS_STORAGE_KEY, JSON.stringify(migrated));
      return migrated;
    } catch (error) {
      console.error('Error migrating detection history:', error);
      return [];
    }
  };

  const loadScannedPlates = async () => {
    try {
      const allDetections = await readAllDetectedPlates();
      const importedStore = parseImportedPlateStore(await AsyncStorage.getItem(IMPORTED_PLATES_STORAGE_KEY));
      setScannedPlates(
        allDetections
          .map(({ plate }) => ({ plate, isInRegistry: plate in importedStore }))
          .reverse(),
      );
    } catch (error) {
      console.error('Error loading scanned plates:', error);
    }
  };

  const clearScannedPlates = async () => {
    await AsyncStorage.setItem(ALL_DETECTIONS_STORAGE_KEY, JSON.stringify([]));
    setScannedPlates([]);
  };

const saveDetectionForMainList = async (plate: string) => {
const entries = await readAllDetectedPlates();
const now = Date.now();
const nextEntries = [...entries, { plate, timestamp: now }];
await AsyncStorage.setItem(ALL_DETECTIONS_STORAGE_KEY, JSON.stringify(nextEntries));
    setScannedPlates(
      nextEntries
.map((entry) => ({ plate: entry.plate, isInRegistry: entry.plate in importedPlatesRef.current }))
.reverse(),
);
};

  const saveMatchedPlateWithLocation = async (plate: string, location: Location.LocationObject) => {
    const matchedFile = getMatchedPlatesFile();
    const now = new Date();
    const date = now.toLocaleDateString('es-ES');
    const time = now.toLocaleTimeString('es-ES', { hour12: false });
    const coordinates = `${location.coords.latitude},${location.coords.longitude}`;
    const entry = `${plate},${date},${time},"${coordinates}"\n`;

    let currentContent = '';
    if ((await matchedFile.info()).exists) {
      currentContent = await matchedFile.text();
    } else {
      await matchedFile.create();
      currentContent = 'MATRÍCULA,FECHA,HORA,LATITUD/LONGITUD\n';
    }

    await matchedFile.write(currentContent + entry);
  };

  const isRecentlyDetected = (key: string) => {
    const lastDetectedAt = recentDetectionAtRef.current.get(key);
    return lastDetectedAt !== undefined && Date.now() - lastDetectedAt < scannerSettingsRef.current.duplicateWindowSeconds * 1_000;
  };

  const registerNewDetection = async (key: string) => {
    if (isRecentlyDetected(key)) return false;
    const now = Date.now();
    recentDetectionAtRef.current.set(key, now);
    await AsyncStorage.setItem(
      RECENT_REGISTRATIONS_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(recentDetectionAtRef.current.entries())),
    );
    return true;
  };

  const processCurrentFrame = async (automatic: boolean) => {
    if (isProcessingRef.current || !isAppActiveRef.current || !cameraRef.current || !cameraReady) return;

    isProcessingRef.current = true;
    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.85,
        base64: false,
        exif: false,
        skipProcessing: true,
      });

if (!photo.uri) {
        if (await registerNewDetection(INVALID_OCR_DEDUPLICATION_KEY)) showStandardToast('No se detectó matrícula válida', 'error');
return;
}

      const result = await TextRecognition.recognize(photo.uri);
      if (!isAppActiveRef.current || !isScreenFocusedRef.current || (automatic && scanModeRef.current !== 'video')) return;

      const cleanText = result.text.replace(/[^A-Z0-9]/gi, '').toUpperCase();
const match = cleanText.match(/\d{4}[B-DF-HJ-NP-TV-Z]{3}/);
if (!match?.[0]) {
        if (await registerNewDetection(INVALID_OCR_DEDUPLICATION_KEY)) showStandardToast('No se detectó matrícula válida', 'error');
return;
}

      const detectedPlate = match[0];
      if (!(await registerNewDetection(detectedPlate))) return;
      if (recentDetectionAtRef.current.delete(INVALID_OCR_DEDUPLICATION_KEY)) {
        await AsyncStorage.setItem(
          RECENT_REGISTRATIONS_STORAGE_KEY,
          JSON.stringify(Object.fromEntries(recentDetectionAtRef.current.entries())),
        );
      }
      await saveDetectionForMainList(detectedPlate);
      const rule = notificationRulesRef.current[detectedPlate];
      const hasCustomAlert = Boolean(globalNotificationsRef.current && rule?.active && rule.message);
      const showCustomAlert = (locationSaved = false) => {
        const suffix = locationSaved ? '' : '';
        showCustomToast(`🔔 ${rule?.message}${suffix}`);
      };

      if (!(detectedPlate in importedPlatesRef.current)) {
        showStandardToast(`${detectedPlate} sin registro`, 'success');
        if (hasCustomAlert) showCustomAlert();
        return;
      }

      setFrameColor('red');
      if (Platform.OS !== 'web') void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      setTimeout(() => setFrameColor('blue'), 500);

const location = await getFreshLocationForRegistration();

      if (location) {
        await saveMatchedPlateWithLocation(detectedPlate, location);
      }

      const standardMessage = `¡${detectedPlate} está en el registro!`;
      const customMessage = hasCustomAlert ? `🔔 ${rule?.message}` : null;

      showStandardToast(standardMessage, 'warning');

      if (hasCustomAlert) {
        showCustomToast(customMessage!);
      }

      void scheduleDetectionEvidence(
        photo.uri,
        photo.width,
        photo.height,
        standardMessage,
        customMessage,
        location,
      );
} catch (error) {
console.error('Error during scan:', error);
      if (await registerNewDetection(INVALID_OCR_DEDUPLICATION_KEY)) showStandardToast('No se detectó matrícula válida', 'error');
    } finally {
      isProcessingRef.current = false;
    }
  };

  useEffect(() => {
    if (!detectionEvidence || !evidenceImageLoaded) return;
    if (evidenceCaptureInProgressRef.current) return;

    evidenceCaptureInProgressRef.current = true;

    let firstFrame: number | null = null;
    let secondFrame: number | null = null;

    firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(async () => {
        try {
          if (!evidenceViewRef.current) return;

          const capturedUri = await captureRef(evidenceViewRef.current, {
            format: 'jpg',
            quality: 0.92,
            result: 'tmpfile',
          });

          await MediaLibrary.createAssetAsync(capturedUri);
        } catch (error) {
          console.error('Error guardando evidencia de detección:', error);
        } finally {
          setDetectionEvidence(null);
          setEvidenceImageLoaded(false);
          evidenceCaptureInProgressRef.current = false;
          evidenceCaptureFrameRef.current = null;
        }
      });

      evidenceCaptureFrameRef.current = secondFrame;
    });

    evidenceCaptureFrameRef.current = firstFrame;

    return () => {
      if (firstFrame !== null) cancelAnimationFrame(firstFrame);
      if (secondFrame !== null) cancelAnimationFrame(secondFrame);
    };
  }, [detectionEvidence, evidenceImageLoaded]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const cameraPermission = await Camera.requestCameraPermissionsAsync();

        if (cameraPermission.status !== 'granted') {
          if (!cancelled) {
            setInitialPermissionError('Acceso a la cámara denegado.');
            setHasInitialPermissions(false);
          }
          return;
        }

        let locationPermission = await Location.getForegroundPermissionsAsync();
        if (locationPermission.status !== 'granted') {
          locationPermission = await Location.requestForegroundPermissionsAsync();
        }

        if (locationPermission.status !== 'granted') {
          if (!cancelled) {
            setInitialPermissionError('Acceso a la ubicación denegado.');
            setHasInitialPermissions(false);
          }
          return;
        }

        if (!cancelled) {
          setHasInitialPermissions(true);
          setInitialPermissionError(null);
        }
      } catch (error) {
        console.error('Error solicitando permisos iniciales:', error);

        if (!cancelled) {
          setInitialPermissionError('No se pudieron solicitar los permisos iniciales.');
          setHasInitialPermissions(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void restoreSavedZoom();

    const subscription = AppState.addEventListener('change', (nextAppState: AppStateStatus) => {
      const wasActive = appState.current === 'active';
      const isReturningToActive = nextAppState === 'active' && appState.current !== 'active';

      if (wasActive && /inactive|background/.test(nextAppState)) {
        isAppActiveRef.current = false;
        setIsAppActive(false);
        void persistZoomIndex(zoomIndexRef.current);
        void pauseCameraPreview();
        stopLocationTracking();
      }

      if (isReturningToActive) {
        isAppActiveRef.current = true;
        setIsAppActive(true);
        void restoreSavedZoom();
        void resumeCameraPreview();
        if (isScreenFocusedRef.current) void ensureLocationTracking();
      }

      appState.current = nextAppState;
    });

    return () => subscription.remove();
  }, []);

  useEffect(() => {
    zoomIndexRef.current = zoomIndex;
  }, [zoomIndex]);

  useEffect(() => {
    importedPlatesRef.current = importedPlates;
  }, [importedPlates]);

  useEffect(() => {
    notificationRulesRef.current = notificationRules;
  }, [notificationRules]);

  useEffect(() => {
    globalNotificationsRef.current = globalNotificationsActive;
  }, [globalNotificationsActive]);

  useEffect(() => {
    scanModeRef.current = scanMode;
  }, [scanMode]);

  useEffect(() => {
    scannerSettingsRef.current = scannerSettings;
  }, [scannerSettings]);

  useFocusEffect(
    useCallback(() => {
      isScreenFocusedRef.current = true;
      setIsScreenFocused(true);
void loadNotificationSettings();
void loadOperationalSettings();
void loadSaveDetectionImageSetting();
      void loadRecentDetections();
void loadImportedPlates();
      void loadScannedPlates();

      return () => {
        isScreenFocusedRef.current = false;
        setIsScreenFocused(false);
        setCameraReady(false);
      };
    }, []),
  );

  useEffect(() => {
    if (!isScreenFocused) {
      stopLocationTracking();
      return;
    }

    void ensureLocationTracking();
    const statusTimer = setInterval(() => void refreshLocationService(), 10_000);
    return () => {
      clearInterval(statusTimer);
      stopLocationTracking();
    };
  }, [isScreenFocused, scannerSettings.gpsUpdateIntervalSeconds]);

  useEffect(() => {
    if (videoIntervalRef.current) {
      clearInterval(videoIntervalRef.current);
      videoIntervalRef.current = null;
    }

    if (scanMode !== 'video' || !isScreenFocused || !isAppActive || !cameraReady) return;

    const scanFrame = () => void processCurrentFrame(true);
    scanFrame();
    videoIntervalRef.current = setInterval(scanFrame, scannerSettings.videoIntervalSeconds * 1_000);

    return () => {
      if (videoIntervalRef.current) clearInterval(videoIntervalRef.current);
      videoIntervalRef.current = null;
    };
  }, [scanMode, isScreenFocused, isAppActive, cameraReady, scannerSettings.videoIntervalSeconds]);

  const handleZoomPreset = () => {
    const nextIndex = (zoomIndexRef.current + 1) % ZOOM_PRESETS.length;
    zoomIndexRef.current = nextIndex;
    setZoomIndex(nextIndex);
    void persistZoomIndex(nextIndex);
  };

  const handleModeChange = (mode: ScanMode) => {
    setScanMode(mode);
    scanModeRef.current = mode;
    if (mode === 'video') void ensureLocationTracking();
  };

  const getStandardToastBackgroundColor = (type: StandardToastType) => {
    switch (type) {
      case 'warning': return '#FF9500';
      case 'error': return '#000000';
      default: return '#808080';
    }
  };

  const getGpsPresentation = () => {
    switch (gpsStatus) {
      case 'active': return { label: 'GPS activo', color: '#34C759', icon: 'gps-fixed' as const };
      case 'permission_denied': return { label: 'GPS sin permiso', color: '#FF3B30', icon: 'location-disabled' as const };
      case 'services_disabled': return { label: 'GPS desactivado', color: '#FF3B30', icon: 'location-off' as const };
      case 'waiting': return { label: 'Buscando GPS', color: '#FF9500', icon: 'location-searching' as const };
      case 'unavailable': return { label: 'GPS no disponible', color: '#FF3B30', icon: 'gps-off' as const };
      default: return { label: 'Comprobando GPS', color: '#8E8E93', icon: 'location-searching' as const };
    }
  };

  if (hasInitialPermissions === null) {
    return (
      <ScreenContainer className="flex-1 items-center justify-center">
        <Text>Solicitando permisos iniciales...</Text>
      </ScreenContainer>
    );
  }

  if (hasInitialPermissions === false) {
    return (
      <ScreenContainer className="flex-1 items-center justify-center p-6">
        <Text className="text-center">
          {initialPermissionError ?? 'Faltan permisos necesarios para iniciar la aplicación.'}
        </Text>
      </ScreenContainer>
    );
  }

  const gpsPresentation = getGpsPresentation();

  return (
    <ScreenContainer className="flex-1 p-0">
      {isScreenFocused && (
        <CameraView
          ref={cameraRef}
          style={StyleSheet.absoluteFillObject}
          zoom={ZOOM_PRESETS[zoomIndex]}
          enableTorch={isTorchOn}
          onCameraReady={() => {
            if (isAppActiveRef.current) setCameraReady(true);
          }}
          facing="back"
        />
      )}

      <View style={styles.overlayContainer} pointerEvents="box-none">
        <View style={[styles.focusFrame, { borderColor: frameColor === 'blue' ? '#007AFF' : '#FF3B30' }]} pointerEvents="none" />

        <View style={[styles.gpsBadge, { borderColor: gpsPresentation.color }]} pointerEvents="none">
          <MaterialIcons name={gpsPresentation.icon} size={16} color={gpsPresentation.color} />
          <Text style={[styles.gpsBadgeText, { color: gpsPresentation.color }]}>{gpsPresentation.label}</Text>
        </View>
        <Text style={styles.versionLabel} pointerEvents="none">v{APP_VERSION}</Text>

        {standardToast && (
          <View style={[styles.standardToast, { backgroundColor: getStandardToastBackgroundColor(standardToast.type) }]} pointerEvents="none">
            <Text style={styles.toastText}>{standardToast.message}</Text>
          </View>
        )}
        {customToast && (
          <View style={styles.customToast} pointerEvents="none">
            <Text style={styles.toastText}>{customToast.message}</Text>
          </View>
        )}

        <View style={styles.overlay} pointerEvents="box-none">
          <View style={styles.modeSelector}>
            <TouchableOpacity onPress={() => handleModeChange('manual')} style={[styles.modeButton, scanMode === 'manual' && styles.modeButtonActive]}>
              <Text style={[styles.modeButtonText, scanMode === 'manual' && styles.modeButtonTextActive]}>MANUAL</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => handleModeChange('video')} style={[styles.modeButton, scanMode === 'video' && styles.modeButtonActive]}>
              <Text style={[styles.modeButtonText, scanMode === 'video' && styles.modeButtonTextActive]}>VÍDEO</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.scanRow} pointerEvents="box-none">
            <TouchableOpacity
              onPress={() => setIsTorchOn((current) => !current)}
              style={[styles.torchButtonLeft, { backgroundColor: isTorchOn ? 'rgba(255, 215, 0, 0.4)' : 'rgba(0, 0, 0, 0.6)' }]}
            >
              <MaterialIcons name={isTorchOn ? 'flash-on' : 'flash-off'} size={24} color={isTorchOn ? '#FFD700' : '#FFFFFF'} />
            </TouchableOpacity>

            {scanMode === 'manual' ? (
              <TouchableOpacity style={styles.scanButton} onPress={() => void processCurrentFrame(false)} disabled={!cameraReady}>
                <Text style={styles.scanButtonText}>Escanear</Text>
              </TouchableOpacity>
            ) : (
              <View style={styles.videoScanningStatus}>
                <View style={styles.videoDot} />
                <Text style={styles.videoScanningText}>ESCANEANDO</Text>
              </View>
            )}

            <TouchableOpacity onPress={handleZoomPreset} style={styles.zoomButtonRight}>
              <Text style={styles.zoomButtonText}>{ZOOM_LABELS[zoomIndex]}</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.platesContainer} pointerEvents="box-none">
            <View style={styles.platesHeader}>
              <Text style={styles.platesTitle}>Matrículas Detectadas:</Text>
              {scannedPlates.length > 0 && (
                <TouchableOpacity onPress={() => void clearScannedPlates()} style={styles.clearCircleButton}>
                  <MaterialIcons name="close" size={16} color="white" />
                </TouchableOpacity>
              )}
            </View>
            <ScrollView style={styles.platesScrollView}>
              {scannedPlates.length > 0 ? scannedPlates.map((item, index) => (
                <Text key={`${item.plate}-${index}`} style={[styles.plateText, item.isInRegistry && styles.plateTextInRegistry]}>
                  {item.plate}
                </Text>
              )) : <Text style={styles.plateText}>Ninguna matrícula detectada aún.</Text>}
            </ScrollView>
          </View>
        </View>
      </View>

      {detectionEvidence && (
        <View
          ref={evidenceViewRef}
          style={[
            styles.evidenceCaptureContainer,
            {
              width: evidenceWidth,
              height: evidenceHeight,
            },
          ]}
          pointerEvents="none"
          collapsable={false}
        >
          <Image
            source={{ uri: detectionEvidence.photoUri }}
            style={[
              styles.evidenceCaptureImage,
              {
                width: evidenceWidth,
                height: evidenceHeight,
              },
            ]}
            resizeMode="cover"
            onLoad={() => setEvidenceImageLoaded(true)}
          />

          <View style={styles.evidenceToastArea}>
            <View style={styles.evidenceStandardToast}>
              <Text style={styles.evidenceToastText}>
                {detectionEvidence.standardMessage}
              </Text>
            </View>

            {detectionEvidence.customMessage && (
              <View style={styles.evidenceCustomToast}>
                <Text style={styles.evidenceToastText}>
                  {detectionEvidence.customMessage}
                </Text>
              </View>
            )}
          </View>

          <View style={styles.evidenceMetadata}>
            <Text style={styles.evidenceMetadataText}>
              {detectionEvidence.date} · {detectionEvidence.time}
            </Text>

            {detectionEvidence.coordinates && (
              <Text style={styles.evidenceMetadataText}>
                GPS: {detectionEvidence.coordinates}
              </Text>
            )}
          </View>
        </View>
      )}
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  evidenceCaptureContainer: {
    position: 'absolute',
    left: -10000,
    top: -10000,
    backgroundColor: 'transparent',
    overflow: 'hidden',
  },
  evidenceCaptureImage: {
    position: 'absolute',
    left: 0,
    top: 0,
  },
  evidenceToastArea: {
    position: 'absolute',
    top: 35,
    left: 20,
    right: 20,
    alignItems: 'center',
  },
  evidenceStandardToast: {
    width: '100%',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 16,
    backgroundColor: 'rgba(255, 149, 0, 0.92)',
  },
  evidenceCustomToast: {
    marginTop: 8,
    width: '100%',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 16,
    backgroundColor: '#FF3B30',
  },
  evidenceToastText: {
    color: 'white',
    fontSize: 16,
    fontWeight: 'bold',
    textAlign: 'center',
  },
  evidenceMetadata: {
    position: 'absolute',
    left: 50,
    right: 50,
    bottom: 50,
    paddingVertical: 14,
    paddingHorizontal: 18,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.72)',
  },
  evidenceMetadataText: {
    color: 'white',
    fontSize: 20,
    fontWeight: '600',
    textAlign: 'center',
    marginVertical: 2,
  },
  overlayContainer: { ...StyleSheet.absoluteFillObject, backgroundColor: 'transparent' },
  overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'transparent', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 20 },
  focusFrame: { position: 'absolute', top: '25%', left: '10%', right: '10%', height: 120, borderWidth: 3, borderRadius: 12, backgroundColor: 'transparent' },
  gpsBadge: { position: 'absolute', top: 14, left: 16, flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 6, paddingHorizontal: 9, borderWidth: 1, borderRadius: 14, backgroundColor: 'rgba(0,0,0,0.65)', zIndex: 100 },
  gpsBadgeText: { fontSize: 12, fontWeight: '700' },
  versionLabel: { position: 'absolute', top: 20, right: 16, color: 'white', fontSize: 12, fontWeight: '600', opacity: 0.4 },
  standardToast: { position: 'absolute', top: 58, alignSelf: 'center', maxWidth: '86%', paddingVertical: 10, paddingHorizontal: 20, borderRadius: 20, zIndex: 100 },
  customToast: { position: 'absolute', top: 116, alignSelf: 'center', maxWidth: '86%', paddingVertical: 10, paddingHorizontal: 20, borderRadius: 20, zIndex: 101, backgroundColor: '#FF3B30' },
  toastText: { color: 'white', fontSize: 16, fontWeight: 'bold', textAlign: 'center' },
  modeSelector: { flexDirection: 'row', marginBottom: 10, borderRadius: 18, padding: 3, backgroundColor: 'rgba(0,0,0,0.62)' },
  modeButton: { paddingVertical: 7, paddingHorizontal: 17, borderRadius: 15 },
  modeButtonActive: { backgroundColor: '#007AFF' },
  modeButtonText: { color: '#D1D1D6', fontSize: 12, fontWeight: '700' },
  modeButtonTextActive: { color: 'white' },
  scanRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', width: '100%', position: 'relative', marginBottom: 20, height: 60 },
  torchButtonLeft: { position: 'absolute', left: 25, width: 48, height: 48, borderRadius: 24, justifyContent: 'center', alignItems: 'center', zIndex: 10 },
  zoomButtonRight: { position: 'absolute', right: 25, width: 48, height: 48, borderRadius: 24, justifyContent: 'center', alignItems: 'center', zIndex: 10, backgroundColor: 'rgba(0, 0, 0, 0.6)' },
  zoomButtonText: { color: 'white', fontSize: 14, fontWeight: 'bold' },
  scanButton: { backgroundColor: '#007AFF', paddingVertical: 15, paddingHorizontal: 30, borderRadius: 30 },
  scanButtonText: { color: 'white', fontSize: 18, fontWeight: 'bold' },
  videoScanningStatus: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingVertical: 15, paddingHorizontal: 23, borderRadius: 30, backgroundColor: 'rgba(255, 59, 48, 0.9)' },
  videoDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: 'white' },
  videoScanningText: { color: 'white', fontSize: 15, fontWeight: '800', letterSpacing: 0.5 },
  platesContainer: { backgroundColor: 'rgba(0,0,0,0.7)', width: '90%', maxHeight: 120, borderRadius: 10, padding: 10 },
  platesHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 },
  platesTitle: { color: 'white', fontSize: 16, fontWeight: 'bold' },
  clearCircleButton: { width: 26, height: 26, borderRadius: 13, backgroundColor: 'rgba(255,255,255,0.3)', justifyContent: 'center', alignItems: 'center' },
  platesScrollView: { maxHeight: 80 },
  plateText: { color: 'white', fontSize: 16, marginVertical: 2 },
  plateTextInRegistry: { color: '#FF3B30', fontWeight: 'bold' },
});
