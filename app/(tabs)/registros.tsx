import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Linking, Modal, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useFocusEffect } from 'expo-router';

import { ScreenContainer } from '@/components/screen-container';

const IMPORTED_PLATES_STORAGE_KEY = 'imported_plates';
const ALL_DETECTIONS_STORAGE_KEY = 'all_scanned_plate_detections';
const MAP_NEW_RECORD_KEYS_STORAGE_KEY = 'map_new_record_keys';
const MANUAL_RECORD_KEYS_STORAGE_KEY = 'manual_detection_record_keys';
const PLATES_FILE_NAME = 'matriculas_detectadas.csv';

const getPlatesFile = () => new File(Paths.document, PLATES_FILE_NAME);

interface ImportedPlateData {
  fecha: string;
  hora: string;
}

interface ScannedPlate {
  plate: string;
  date: string;
  time: string;
  latitude: string;
  longitude: string;
  manual?: boolean;
}

function getManualRecordKey(record: Pick<ScannedPlate, 'plate' | 'date' | 'time'>): string {
  return [record.plate.trim().toUpperCase(), record.date.trim(), record.time.trim()].join('|');
}

interface StoredDetection {
  plate: string;
  timestamp?: number;
  manual?: boolean;
}

function parseStoredDetections(rawValue: string | null): StoredDetection[] {
  if (!rawValue) return [];

  try {
    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) return [];

    return parsed.reduce<StoredDetection[]>((entries, entry) => {
      const plate = typeof entry === 'string' ? entry : entry?.plate;
      const timestamp =
        typeof entry === 'object' && typeof entry?.timestamp === 'number'
          ? entry.timestamp
          : undefined;
      const manual = typeof entry === 'object' && entry?.manual === true;

      if (typeof plate === 'string' && plate.trim()) {
        entries.push({
          plate: plate.trim().toUpperCase(),
          timestamp,
          ...(manual ? { manual: true } : {}),
        });
      }

      return entries;
    }, []);
  } catch (error) {
    console.error('Error parsing stored detections:', error);
    return [];
  }
}

function parseSpanishDateTimeToTimestamp(date: string, time: string): number | null {
  const dateParts = date.split('/').map(Number);
  const timeParts = time.split(':').map(Number);

  if (
    dateParts.length !== 3 ||
    timeParts.length < 2 ||
    dateParts.some(Number.isNaN) ||
    timeParts.some(Number.isNaN)
  ) {
    return null;
  }

  const [day, month, year] = dateParts;
  const [hour, minute, second = 0] = timeParts;

  const parsed = new Date(
    year,
    month - 1,
    day,
    hour,
    minute,
    second,
  );

  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day ||
    parsed.getHours() !== hour ||
    parsed.getMinutes() !== minute ||
    parsed.getSeconds() !== second
  ) {
    return null;
  }

  return parsed.getTime();
}

function normalizeImportedPlates(rawValue: string | null): Record<string, ImportedPlateData> {
  if (!rawValue) return {};

  try {
    const parsed = JSON.parse(rawValue);
    if (Array.isArray(parsed)) {
      return parsed.reduce<Record<string, ImportedPlateData>>((store, plate) => {
        if (typeof plate === 'string' && plate.trim()) store[plate.trim().toUpperCase()] = { fecha: '', hora: '' };
        return store;
      }, {});
    }

    if (parsed && typeof parsed === 'object') {
      return Object.keys(parsed).reduce<Record<string, ImportedPlateData>>((store, plate) => {
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

export default function RegistrosScreen() {
  const [importedPlates, setImportedPlates] = useState<Record<string, ImportedPlateData>>({});
  const [scannedPlates, setScannedPlates] = useState<ScannedPlate[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [showManualEntryModal, setShowManualEntryModal] = useState(false);
  const [manualPlate, setManualPlate] = useState('');
  const [manualCoordinates, setManualCoordinates] = useState('');
  const [manualDate, setManualDate] = useState('');
  const [manualTime, setManualTime] = useState('');

  useFocusEffect(
    useCallback(() => {
      void loadImportedPlates();
      void loadScannedPlates();
    }, []),
  );

  const loadImportedPlates = async () => {
    setImportedPlates(normalizeImportedPlates(await AsyncStorage.getItem(IMPORTED_PLATES_STORAGE_KEY)));
  };

  const loadScannedPlates = async () => {
    try {
      const platesFile = getPlatesFile();
      if (!(await platesFile.info()).exists) {
        setScannedPlates([]);
        return;
      }

      const importedStore = normalizeImportedPlates(await AsyncStorage.getItem(IMPORTED_PLATES_STORAGE_KEY));
      let manualRecordKeys: string[] = [];

      try {
        const rawManualKeys = await AsyncStorage.getItem(MANUAL_RECORD_KEYS_STORAGE_KEY);
        const parsedManualKeys = rawManualKeys ? JSON.parse(rawManualKeys) : [];
        if (Array.isArray(parsedManualKeys)) {
          manualRecordKeys = parsedManualKeys.filter(
            (key): key is string => typeof key === 'string',
          );
        }
      } catch (error) {
        console.warn('No se pudieron leer las marcas de registros manuales:', error);
      }

      const platesData = (await platesFile.text())
        .split('\n')
        .filter(Boolean)
        .slice(1)
        .map((line) => {
          const match = line.match(/^([^,]*),([^,]*),([^,]*),"([^"]*)"(?:,([^,]*))?$/);
          if (!match) return null;

          const [, rawPlate = '', rawDate = '', rawTime = '', rawCoordinates = ''] = match;
          const [rawLatitude = '', rawLongitude = ''] = rawCoordinates.split(',');
          const plate = rawPlate.trim().toUpperCase();
          const latitude = rawLatitude.trim();
          const longitude = rawLongitude.trim();

          return plate && latitude && longitude
            ? {
                plate,
                date: rawDate.trim(),
                time: rawTime.trim(),
                latitude,
                longitude,
              }
            : null;
        })
        .filter((item): item is ScannedPlate => item !== null)
        .map((item) => ({
          ...item,
          manual: manualRecordKeys.includes(getManualRecordKey(item)),
        }))
        .filter((item) => item.manual || item.plate in importedStore)
        .reverse();

      setScannedPlates(platesData);
    } catch (error) {
      console.error('Error loading scanned plates:', error);
    }
  };

  const openManualEntry = () => {
    const now = new Date();
    setManualPlate('');
    setManualCoordinates('');
    setManualDate(now.toLocaleDateString('es-ES'));
    setManualTime(
      now.toLocaleTimeString('es-ES', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }),
    );
    setShowManualEntryModal(true);
  };

  const handleSaveManualEntry = async () => {
    const plate = manualPlate.trim().toUpperCase();
    const date = manualDate.trim();
    const time = manualTime.trim();

    if (!/^\d{4}[BCDFGHJKLMNPRSTVWXYZ]{3}$/.test(plate)) {
      Alert.alert(
        'Matrícula no válida',
        'Introduce una matrícula española válida con 4 números y 3 letras.',
      );
      return;
    }

    // Se aplica la misma normalización de comas decimales que en Ajustes.
    const normalizedCoordinates = manualCoordinates.replace(/(\d),(\d)/g, '$1.$2').trim();
    const coordinateParts = normalizedCoordinates.split(',');

    if (coordinateParts.length !== 2 ||
        !coordinateParts[0].trim() ||
        !coordinateParts[1].trim() ||
        !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(coordinateParts[0].trim()) ||
        !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(coordinateParts[1].trim())) {
      Alert.alert(
        'Coordenadas no válidas',
        'Introduce latitud y longitud separadas por una coma. También se admiten comas decimales españolas.',
      );
      return;
    }

    const latitudeNumber = Number(coordinateParts[0].trim());
    const longitudeNumber = Number(coordinateParts[1].trim());

    if (!Number.isFinite(latitudeNumber) ||
        !Number.isFinite(longitudeNumber) ||
        latitudeNumber < -90 || latitudeNumber > 90 ||
        longitudeNumber < -180 || longitudeNumber > 180) {
      Alert.alert(
        'Coordenadas no válidas',
        'La latitud debe estar entre -90 y 90 y la longitud entre -180 y 180.',
      );
      return;
    }

    if (!/^\d{1,2}:\d{2}(?::\d{2})?$/.test(time) ||
        parseSpanishDateTimeToTimestamp(date, time) === null) {
      Alert.alert(
        'Fecha u hora no válidas',
        'Usa la fecha DD/MM/AAAA y la hora HH:mm o HH:mm:ss. Comprueba que existan realmente.',
      );
      return;
    }

    const recordKey = getManualRecordKey({ plate, date, time });
    const canonicalCoordinates = `${latitudeNumber},${longitudeNumber}`;
    const platesFile = getPlatesFile();

    try {
      let currentContent = '';

      if ((await platesFile.info()).exists) {
        currentContent = (await platesFile.text())
          .replace(/^\uFEFF/, '')
          .replace(/\r\n/g, '\n');
      }

      if (!currentContent.trim()) {
        currentContent = 'MATRÍCULA,FECHA,HORA,LATITUD/LONGITUD,LUGAR\n';
      }

      const existingLines = currentContent
        .split('\n')
        .filter((line) => line.trim() !== '');

      const existingRows = existingLines.slice(1);
      const duplicate = existingRows.some((line) => {
        const match = line.match(/^([^,]*),([^,]*),([^,]*),"([^"]*)"(?:,([^,]*))?$/);
        return Boolean(
          match &&
          match[1].trim().toUpperCase() === plate &&
          match[2].trim() === date &&
          match[3].trim() === time
        );
      });

      if (duplicate) {
        Alert.alert(
          'Registro duplicado',
          'Ya existe un registro con esa matrícula, fecha y hora.',
        );
        return;
      }

      // Registrar la marca antes de escribir el CSV. Si falla el CSV,
      // la marca huérfana no mostrará ninguna fila.
      let manualKeys: string[] = [];
      try {
        const rawKeys = await AsyncStorage.getItem(MANUAL_RECORD_KEYS_STORAGE_KEY);
        const parsedKeys = rawKeys ? JSON.parse(rawKeys) : [];
        if (Array.isArray(parsedKeys)) {
          manualKeys = parsedKeys.filter(
            (key): key is string => typeof key === 'string',
          );
        }
      } catch {
        manualKeys = [];
      }

      await AsyncStorage.setItem(
        MANUAL_RECORD_KEYS_STORAGE_KEY,
        JSON.stringify(Array.from(new Set([...manualKeys, recordKey]))),
      );

      const header = existingLines[0] || 'MATRÍCULA,FECHA,HORA,LATITUD/LONGITUD,LUGAR';
      const newRow = `${plate},${date},${time},"${canonicalCoordinates}",OK`;
      await platesFile.write(`${[header, ...existingRows, newRow].join('\n')}\n`);

      // Marcar el registro como nuevo para el mapa.
      try {
        const rawMapKeys = await AsyncStorage.getItem(MAP_NEW_RECORD_KEYS_STORAGE_KEY);
        const parsedMapKeys = rawMapKeys ? JSON.parse(rawMapKeys) : [];
        const mapKeys = Array.isArray(parsedMapKeys)
          ? parsedMapKeys.filter((key): key is string => typeof key === 'string')
          : [];
        await AsyncStorage.setItem(
          MAP_NEW_RECORD_KEYS_STORAGE_KEY,
          JSON.stringify(Array.from(new Set([...mapKeys, recordKey]))),
        );
      } catch (error) {
        console.warn('El registro se guardó, pero no se pudo marcar como nuevo en el mapa:', error);
      }

      // Mantener la lista interna de detecciones de la pestaña Cámara.
      try {
        const rawDetections = await AsyncStorage.getItem(ALL_DETECTIONS_STORAGE_KEY);
        const detections = parseStoredDetections(rawDetections);
        const timestamp = parseSpanishDateTimeToTimestamp(date, time);

        detections.push({
          plate,
          ...(timestamp !== null ? { timestamp } : {}),
          manual: true,
        });

        await AsyncStorage.setItem(
          ALL_DETECTIONS_STORAGE_KEY,
          JSON.stringify(detections),
        );
      } catch (error) {
        console.warn('El registro se guardó en el historial, pero no en la lista interna:', error);
      }

      setShowManualEntryModal(false);
      await loadScannedPlates();

      Alert.alert(
        'Registro guardado',
        plate in importedPlates
          ? 'La detección manual se ha añadido al historial.'
          : 'La detección manual se ha añadido al historial. La matrícula no figura en el registro importado.',
      );
    } catch (error) {
      console.error('Error al guardar el registro manual:', error);
      Alert.alert('Error', 'No se pudo guardar el registro manual.');
    }
  };

  const openPlateLocation = async (plate: ScannedPlate) => {
    try {
      const plateLabel = plate.plate || 'Vehículo';
      const scheme = Platform.OS === 'ios' ? 'maps:0,0?q=' : 'geo:0,0?q=';
      const latLng = `${plate.latitude},${plate.longitude}`;

      const url = Platform.select({
        ios: `${scheme}${plateLabel}@${latLng}&z=20`,
        android: `${scheme}${latLng}(${plateLabel})?z=20`,
      });

      if (url) {
        await Linking.openURL(url);
      }
    } catch (error) {
      console.error('Error al abrir mapa:', error);
      Alert.alert(
        'Error',
        'Ocurrió un error al intentar abrir el mapa',
      );
    }
  };

  const handleImportCSV = async () => {
    try {
      setIsLoading(true);
      const result = await DocumentPicker.getDocumentAsync({
        type: ['text/csv', 'text/comma-separated-values', 'application/csv', 'application/vnd.ms-excel', 'text/plain'],
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.length) return;

      const selectedAsset = result.assets[0];
      const tempUri = `${FileSystem.cacheDirectory}temp_import.csv`;
      await FileSystem.deleteAsync(tempUri, { idempotent: true });
      await FileSystem.copyAsync({ from: selectedAsset.uri, to: tempUri });

      const lines = (await FileSystem.readAsStringAsync(tempUri, { encoding: FileSystem.EncodingType.UTF8 }))
        .replace(/^\uFEFF/, '')
        .replace(/\r\n/g, '\n')
        .split('\n')
        .filter((line) => line.trim() !== '');
      const newImportedPlates: Record<string, ImportedPlateData> = {};
      const firstRowIsHeader = lines[0]?.toUpperCase().includes('MATR') ?? false;

      for (let i = firstRowIsHeader ? 1 : 0; i < lines.length; i += 1) {
        const columns = lines[i].split(',');
        const plate = columns[0]?.replace(/"/g, '').trim().toUpperCase();
        if (!plate) continue;
        newImportedPlates[plate] = {
          fecha: columns[1]?.replace(/"/g, '').trim() ?? '',
          hora: columns[2]?.replace(/"/g, '').trim() ?? '',
        };
      }

      await AsyncStorage.setItem(IMPORTED_PLATES_STORAGE_KEY, JSON.stringify(newImportedPlates));
      setImportedPlates(newImportedPlates);
      await FileSystem.deleteAsync(tempUri, { idempotent: true });
      await loadScannedPlates();
      Alert.alert('Éxito', `Se importaron ${Object.keys(newImportedPlates).length} matrículas correctamente.`);
    } catch (error) {
      console.error('Error importing CSV:', error);
      Alert.alert('Error', 'No se pudo importar el archivo CSV.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleImportDetectionRecords = () => {
    Alert.alert(
      'Importar registros',
      'Los registros del CSV se añadirán a los registros existentes. Los registros actuales no serán sustituidos ni modificados. ¿Deseas continuar?',
      [
        {
          text: 'Cancelar',
          style: 'cancel',
        },
        {
          text: 'Aceptar',
          onPress: () => {
            void importDetectionRecords();
          },
        },
      ],
    );
  };

  const importDetectionRecords = async () => {
    try {
      setIsLoading(true);

      const result = await DocumentPicker.getDocumentAsync({
        type: ['text/csv', 'text/comma-separated-values', 'application/csv', 'application/vnd.ms-excel', 'text/plain'],
        copyToCacheDirectory: true,
      });

      if (result.canceled || !result.assets?.length) return;

      const selectedAsset = result.assets[0];
      const tempUri = `${FileSystem.cacheDirectory}temp_detection_import.csv`;

      await FileSystem.deleteAsync(tempUri, { idempotent: true });
      await FileSystem.copyAsync({ from: selectedAsset.uri, to: tempUri });

      const lines = (await FileSystem.readAsStringAsync(tempUri, {
        encoding: FileSystem.EncodingType.UTF8,
      }))
        .replace(/^\uFEFF/, '')
        .replace(/\r\n/g, '\n')
        .split('\n')
        .filter((line) => line.trim() !== '');

      const firstRowIsHeader = lines[0]?.toUpperCase().includes('MATR') ?? false;
      const importedRows: string[] = [];

      for (let i = firstRowIsHeader ? 1 : 0; i < lines.length; i += 1) {
        const match = lines[i].match(/^([^,]*),([^,]*),([^,]*),"([^"]*)"(?:,([^,]*))?$/);

        if (!match) continue;

        const [, rawPlate = '', rawDate = '', rawTime = '', rawCoordinates = '', rawPlace = 'OK'] = match;
        const plate = rawPlate.trim().replace(/"/g, '').toUpperCase();
        const date = rawDate.trim().replace(/"/g, '');
        const time = rawTime.trim().replace(/"/g, '');
        const coordinates = rawCoordinates.trim();

        const coordinateParts = coordinates.split(',');
        const latitude = coordinateParts[0]?.trim() ?? '';
        const longitude = coordinateParts[1]?.trim() ?? '';

        if (!plate || !date || !time || !latitude || !longitude) continue;

        if (
          !Number.isFinite(Number(latitude)) ||
          !Number.isFinite(Number(longitude))
        ) {
          continue;
        }

        const place = rawPlace.trim().replace(/"/g, '') || 'OK';

        importedRows.push(
          `${plate},${date},${time},"${latitude},${longitude}",${place}`,
        );
      }

      if (importedRows.length === 0) {
        Alert.alert(
          'Importar detecciones',
          'No se encontraron registros válidos en el CSV seleccionado.',
        );
        return;
      }

      const platesFile = getPlatesFile();
      let currentContent = '';

      if ((await platesFile.info()).exists) {
        currentContent = await platesFile.text();
      }

      if (!currentContent.trim()) {
        currentContent = 'MATRÍCULA,FECHA,HORA,LATITUD/LONGITUD,LUGAR\n';
      }

      const existingLines = currentContent
        .replace(/^\uFEFF/, '')
        .replace(/\r\n/g, '\n')
        .split('\n')
        .filter((line) => line.trim() !== '');

      const header = existingLines[0] ?? 'MATRÍCULA,FECHA,HORA,LATITUD/LONGITUD,LUGAR';
      const existingRows = existingLines.slice(1);

      const getDetectionKey = (row: string) => {
        const parts = row.split(',');
        if (parts.length < 3) {
          return row;
        }

        return [
          parts[0].trim().toUpperCase(),
          parts[1].trim(),
          parts[2].trim(),
        ].join('|');
      };

      const existingSet = new Set(existingRows.map(getDetectionKey));
      const newlyImportedKeys: string[] = [];
      let importedCount = 0;
      let duplicateCount = 0;

      for (const row of importedRows) {
        const detectionKey = getDetectionKey(row);

        if (existingSet.has(detectionKey)) {
          duplicateCount += 1;
          continue;
        }

        existingSet.add(detectionKey);
        existingRows.push(row);
        newlyImportedKeys.push(detectionKey);
        importedCount += 1;
      }

      await platesFile.write(`${[header, ...existingRows].join('\n')}\n`);

      if (newlyImportedKeys.length > 0) {
        try {
          const storedNewRecordKeys = await AsyncStorage.getItem(
            MAP_NEW_RECORD_KEYS_STORAGE_KEY,
          );

          let storedKeys: string[] = [];

          if (storedNewRecordKeys) {
            const parsedKeys = JSON.parse(storedNewRecordKeys);

            if (Array.isArray(parsedKeys)) {
              storedKeys = parsedKeys.filter(
                (key): key is string => typeof key === 'string',
              );
            }
          }

          const mergedKeys = Array.from(
            new Set([...storedKeys, ...newlyImportedKeys]),
          );

          await AsyncStorage.setItem(
            MAP_NEW_RECORD_KEYS_STORAGE_KEY,
            JSON.stringify(mergedKeys),
          );
        } catch (error) {
          console.warn(
            'Los registros se importaron, pero no se pudo guardar su estado de nuevos en el mapa:',
            error,
          );
        }
      }

      await FileSystem.deleteAsync(tempUri, { idempotent: true });

      await loadScannedPlates();

      Alert.alert(
        'Importar detecciones',
        `Nuevas: ${importedCount}\nDuplicadas: ${duplicateCount}`,
      );
    } catch (error) {
      console.error('Error importing detection records:', error);
      Alert.alert(
        'Importar detecciones',
        'No se pudieron importar los registros.',
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleClearCSV = () => {
    Alert.alert('Limpiar Registros CSV', '¿Eliminar todas las matrículas importadas?', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Eliminar',
        style: 'destructive',
        onPress: async () => {
          await AsyncStorage.removeItem(IMPORTED_PLATES_STORAGE_KEY);
          setImportedPlates({});
          await loadScannedPlates();
          Alert.alert('Completado', 'Registros CSV eliminados.');
        },
      },
    ]);
  };

  const handleClearOCR = () => {
    Alert.alert('Eliminar Registros OCR', '¿Eliminar todas las detecciones guardadas?', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Eliminar',
        style: 'destructive',
        onPress: async () => {
          const platesFile = getPlatesFile();
          if ((await platesFile.info()).exists) await platesFile.delete();
          // Retirar del mapa las marcas nuevas que pertenecen a registros manuales.
          try {
            const rawManualKeys = await AsyncStorage.getItem(MANUAL_RECORD_KEYS_STORAGE_KEY);
            const parsedManualKeys = rawManualKeys ? JSON.parse(rawManualKeys) : [];
            const manualKeys = Array.isArray(parsedManualKeys)
              ? parsedManualKeys.filter((key): key is string => typeof key === 'string')
              : [];

            if (manualKeys.length > 0) {
              const rawMapKeys = await AsyncStorage.getItem(MAP_NEW_RECORD_KEYS_STORAGE_KEY);
              const parsedMapKeys = rawMapKeys ? JSON.parse(rawMapKeys) : [];

              if (Array.isArray(parsedMapKeys)) {
                const remainingMapKeys = parsedMapKeys.filter(
                  (key): key is string =>
                    typeof key === 'string' && !manualKeys.includes(key),
                );
                await AsyncStorage.setItem(
                  MAP_NEW_RECORD_KEYS_STORAGE_KEY,
                  JSON.stringify(remainingMapKeys),
                );
              }
            }
          } catch (error) {
            console.warn('No se pudieron limpiar todas las marcas manuales del mapa:', error);
          }

          await AsyncStorage.removeItem(ALL_DETECTIONS_STORAGE_KEY);
          await AsyncStorage.removeItem(MANUAL_RECORD_KEYS_STORAGE_KEY);
          setScannedPlates([]);
          Alert.alert('Completado', 'Registros OCR eliminados.');
        },
      },
    ]);
  };

  const handleDeleteOCRRecord = (item: ScannedPlate) => {
    Alert.alert(
      'Eliminar registro',
      `¿Eliminar la detección de ${item.plate} del ${item.date} a las ${item.time}?`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Eliminar',
          style: 'destructive',
          onPress: async () => {
            try {
              const platesFile = getPlatesFile();

              if (!(await platesFile.info()).exists) {
                Alert.alert('Error', 'No se encontró el archivo de registros.');
                return;
              }

              // --------------------------------------------------------
              // Localizar exactamente la línea correspondiente del CSV.
              // Se comprueban matrícula + fecha + hora + coordenadas.
              // --------------------------------------------------------
              const rawFile = await platesFile.text();
              const lines = rawFile
                .replace(/^\uFEFF/, '')
                .replace(/\r\n/g, '\n')
                .split('\n');

              const header = lines[0] ?? '';
              const dataLines = lines.slice(1).filter((line) => line.trim() !== '');

              const targetIndex = dataLines.findIndex((line) => {
                const match = line.match(/^([^,]*),([^,]*),([^,]*),"([^"]*)"(?:,([^,]*))?$/);
                if (!match) return false;

                const [, rawPlate = '', rawDate = '', rawTime = '', rawCoordinates = ''] = match;
                const [rawLatitude = '', rawLongitude = ''] = rawCoordinates.split(',');

                return (
                  rawPlate.trim().toUpperCase() === item.plate &&
                  rawDate.trim() === item.date &&
                  rawTime.trim() === item.time &&
                  rawLatitude.trim() === item.latitude &&
                  rawLongitude.trim() === item.longitude
                );
              });

              if (targetIndex === -1) {
                Alert.alert(
                  'Error',
                  'No se encontró exactamente ese registro en el archivo de historial.',
                );
                return;
              }

              // --------------------------------------------------------
              // El CSV es la fuente principal del historial visible.
              //
              // La detección de AsyncStorage es secundaria: se intenta
              // localizar y eliminar también, pero ningún fallo o ausencia
              // de esa detección puede impedir borrar la fila seleccionada
              // del historial.
              // --------------------------------------------------------
              let detectionsToUpdate: StoredDetection[] | null = null;
              let detectionIndex = -1;

              try {
                const rawDetections = await AsyncStorage.getItem(
                  ALL_DETECTIONS_STORAGE_KEY,
                );

                if (rawDetections !== null) {
                  const detections = parseStoredDetections(rawDetections);
                  const targetTimestamp = parseSpanishDateTimeToTimestamp(
                    item.date,
                    item.time,
                  );

                  if (item.manual) {
                    // Las entradas manuales se identifican por su marca
                    // y por el timestamp exacto, nunca por aproximación.
                    if (targetTimestamp !== null) {
                      detectionIndex = detections.findIndex(
                        (detection) =>
                          detection.manual === true &&
                          detection.plate === item.plate &&
                          detection.timestamp === targetTimestamp,
                      );
                    }
                  } else {
                    // Una fila OCR nunca debe eliminar una entrada manual.
                    let closestDifference = Number.POSITIVE_INFINITY;

                    if (targetTimestamp !== null) {
                      detections.forEach((detection, index) => {
                        if (
                          detection.manual === true ||
                          detection.plate !== item.plate ||
                          typeof detection.timestamp !== 'number'
                        ) {
                          return;
                        }

                        const difference = Math.abs(
                          detection.timestamp - targetTimestamp,
                        );

                        if (
                          difference <= 5 * 60 * 1000 &&
                          difference < closestDifference
                        ) {
                          closestDifference = difference;
                          detectionIndex = index;
                        }
                      });
                    }

                    // Para datos antiguos sin timestamp solo permitimos asociar
                    // automáticamente si existe exactamente una detección OCR
                    // de esa matrícula y además es la única detección OCR disponible.
                    if (detectionIndex === -1) {
                      const samePlateIndexes = detections
                        .map((detection, index) => ({ detection, index }))
                        .filter(
                          ({ detection }) =>
                            detection.manual !== true &&
                            detection.plate === item.plate,
                        )
                        .map(({ index }) => index);

                      const indexesWithoutTimestamp = samePlateIndexes.filter(
                        (index) => typeof detections[index]?.timestamp !== 'number',
                      );

                      if (
                        indexesWithoutTimestamp.length === 1 &&
                        samePlateIndexes.length === 1
                      ) {
                        detectionIndex = indexesWithoutTimestamp[0];
                      }
                    }
                  }

                  if (detectionIndex !== -1) {
                    detectionsToUpdate = detections;
                  }
                }
              } catch (error) {
                console.warn(
                  'No se pudo actualizar la detección interna al borrar el historial:',
                  error,
                );
              }

              // --------------------------------------------------------
              // Eliminar siempre la fila exacta del CSV.
              // --------------------------------------------------------
              dataLines.splice(targetIndex, 1);

              if (dataLines.length === 0) {
                await platesFile.delete();
              } else {
                await platesFile.write(
                  `${[header, ...dataLines].join('\n')}\n`,
                );
              }

              // --------------------------------------------------------
              // La limpieza de AsyncStorage es secundaria. Si falla, el
              // registro del CSV ya se ha eliminado y no se revierte.
              // --------------------------------------------------------
              if (detectionsToUpdate !== null && detectionIndex !== -1) {
                try {
                  detectionsToUpdate.splice(detectionIndex, 1);

                  await AsyncStorage.setItem(
                    ALL_DETECTIONS_STORAGE_KEY,
                    JSON.stringify(detectionsToUpdate),
                  );
                } catch (error) {
                  console.warn(
                    'El registro del historial se eliminó, pero no se pudo limpiar la detección interna:',
                    error,
                  );
                }
              }


              if (item.manual) {
                const recordKey = getManualRecordKey(item);

                try {
                  const rawManualKeys = await AsyncStorage.getItem(MANUAL_RECORD_KEYS_STORAGE_KEY);
                  const parsedManualKeys = rawManualKeys ? JSON.parse(rawManualKeys) : [];
                  const manualKeys = Array.isArray(parsedManualKeys)
                    ? parsedManualKeys.filter(
                        (key): key is string =>
                          typeof key === 'string' && key !== recordKey,
                      )
                    : [];
                  await AsyncStorage.setItem(
                    MANUAL_RECORD_KEYS_STORAGE_KEY,
                    JSON.stringify(manualKeys),
                  );
                } catch (error) {
                  console.warn('No se pudo limpiar la marca del registro manual:', error);
                }

                try {
                  const rawMapKeys = await AsyncStorage.getItem(MAP_NEW_RECORD_KEYS_STORAGE_KEY);
                  const parsedMapKeys = rawMapKeys ? JSON.parse(rawMapKeys) : [];
                  const mapKeys = Array.isArray(parsedMapKeys)
                    ? parsedMapKeys.filter(
                        (key): key is string =>
                          typeof key === 'string' && key !== recordKey,
                      )
                    : [];
                  await AsyncStorage.setItem(
                    MAP_NEW_RECORD_KEYS_STORAGE_KEY,
                    JSON.stringify(mapKeys),
                  );
                } catch (error) {
                  console.warn('No se pudo limpiar la marca del mapa:', error);
                }
              }

              // Recargar el historial desde el CSV.
              await loadScannedPlates();

              Alert.alert('Completado', 'Registro eliminado correctamente.');
            } catch (error) {
              console.error('Error deleting OCR record:', error);
              Alert.alert(
                'Error',
                'No se pudo eliminar el registro. No se han realizado más cambios.',
              );
            }
          },
        },
      ],
    );
  };

  const handleExportRecords = async () => {
    try {
      const platesFile = getPlatesFile();
      if (!(await platesFile.info()).exists) {
        Alert.alert('Exportar registros', 'No hay registros para exportar.');
        return;
      }

      const content = await platesFile.text();
      if (content.split('\n').filter((line) => line.trim() !== '').length <= 1) {
        Alert.alert('Exportar registros', 'No hay registros para exportar.');
        return;
      }

      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert('Exportar registros', 'La función de compartir no está disponible en este dispositivo.');
        return;
      }

      const now = new Date();
      const pad = (value: number) => value.toString().padStart(2, '0');
      const timestamp =
        `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
        `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

      const exportFile = new File(
        Paths.cache,
        `matriculas_detectadas_${timestamp}.csv`,
      );

      await exportFile.write(content);

      await Sharing.shareAsync(exportFile.uri, {
        dialogTitle: 'Exportar registros',
        mimeType: 'text/csv',
      });
    } catch (error) {
      console.error('Error exporting OCR records:', error);
      Alert.alert('Exportar registros', 'No se pudieron exportar los registros.');
    }
  };

  return (
    <ScreenContainer className="flex-1 p-4">
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Registro de Matrículas (CSV)</Text>
          <Text style={styles.helpText}>Importa el registro con matrícula, fecha y hora. Las columnas de ubicación de origen se conservan fuera de esta vista.</Text>
          <TouchableOpacity style={styles.button} onPress={handleImportCSV} disabled={isLoading}>
            {isLoading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Importar Archivo CSV</Text>}
          </TouchableOpacity>
          {Object.keys(importedPlates).length > 0 && (
            <>
              <Text style={styles.statusText}>Registros cargados: {Object.keys(importedPlates).length} matrículas</Text>
              <TouchableOpacity style={[styles.button, styles.buttonDanger]} onPress={handleClearCSV}>
                <Text style={styles.buttonText}>Limpiar Registros CSV</Text>
              </TouchableOpacity>
            </>
          )}
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, styles.sectionTitleInHeader]}>Historial</Text>
            <TouchableOpacity
              style={styles.buttonAddManual}
              onPress={openManualEntry}
              accessibilityRole="button"
              accessibilityLabel="Añadir registro manual"
            >
              <MaterialIcons name="add" size={25} color="#FFFFFF" />
            </TouchableOpacity>
          </View>
          <View style={styles.historyActions}>
            <TouchableOpacity style={styles.buttonExport} onPress={() => void handleExportRecords()}>
              <Text style={styles.buttonSmallText}>📤 Exportar</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.buttonImport}
              onPress={() => void handleImportDetectionRecords()}
              disabled={isLoading}
            >
              <Text style={styles.buttonSmallText}>📥 Importar</Text>
            </TouchableOpacity>
            {scannedPlates.length > 0 && (
              <TouchableOpacity style={styles.buttonSmall} onPress={handleClearOCR}>
                <Text style={styles.buttonSmallText}>Eliminar</Text>
              </TouchableOpacity>
            )}
          </View>
          <Text style={styles.helpText}>Se muestran las detecciones de matrículas importadas y los registros manuales marcados con *.</Text>
          {scannedPlates.length > 0 ? (
            <FlatList
              data={scannedPlates}
              keyExtractor={(item, index) => `${item.plate}-${item.date}-${item.time}-${index}`}
              scrollEnabled={false}
              renderItem={({ item }) => (
                <View style={styles.plateItem}>
                  <View>
                    <TouchableOpacity onPress={() => void openPlateLocation(item)}>
                      <Text style={styles.plateText}>{item.manual ? '* ' : ''}{item.plate}</Text>
                    </TouchableOpacity>
                    <Text style={styles.plateSubText}>{item.date} {item.time}</Text>
                  </View>
                  <TouchableOpacity
                    onPress={() => handleDeleteOCRRecord(item)}
                    accessibilityRole="button"
                    accessibilityLabel={`Eliminar registro ${item.plate}`}
                    hitSlop={8}
                  >
                    <MaterialIcons name="close" size={22} color="#FF3B30" />
                  </TouchableOpacity>
                </View>
              )}
            />
          ) : <Text style={styles.emptyText}>No hay coincidencias registradas aún.</Text>}
        </View>
      </ScrollView>

      <Modal
        visible={showManualEntryModal}
        animationType="slide"
        transparent
        onRequestClose={() => setShowManualEntryModal(false)}
      >
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={24}
        >
          <ScrollView
            contentContainerStyle={styles.modalScrollContent}
            keyboardShouldPersistTaps="handled"
          >
            <View style={styles.modalContent}>
              <Text style={styles.modalTitleText}>Añadir registro manual</Text>

              <Text style={styles.inputLabel}>Matrícula:</Text>
              <TextInput
                style={[
                  styles.textInput,
                  manualPlate.trim().length > 0 &&
                  !/^\d{4}[BCDFGHJKLMNPRSTVWXYZ]{3}$/.test(manualPlate.trim().toUpperCase())
                    ? styles.textInputInvalid
                    : manualPlate.trim().length > 0
                      ? styles.textInputValid
                      : null,
                ]}
                value={manualPlate}
                onChangeText={(value) => setManualPlate(value.toUpperCase())}
                placeholder="Ej.: 1234 BCD"
                autoCapitalize="characters"
                autoCorrect={false}
                maxLength={7}
              />

              {manualPlate.trim().length > 0 &&
                !/^\d{4}[BCDFGHJKLMNPRSTVWXYZ]{3}$/.test(manualPlate.trim().toUpperCase()) && (
                  <Text style={styles.validationErrorText}>
                    Introduce 4 números y 3 letras válidas.
                  </Text>
                )}

              {/^\d{4}[BCDFGHJKLMNPRSTVWXYZ]{3}$/.test(manualPlate.trim().toUpperCase()) &&
                !(manualPlate.trim().toUpperCase() in importedPlates) && (
                  <Text style={styles.validationWarningText}>
                    Esta matrícula no figura en el registro importado. Puedes continuar y guardar la detección manual.
                  </Text>
                )}

              <Text style={styles.inputLabel}>Coordenadas GPS (latitud,longitud):</Text>
              <TextInput
                style={styles.textInput}
                value={manualCoordinates}
                onChangeText={setManualCoordinates}
                placeholder="40.340719,-3.666870"
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Text style={styles.modalHelpText}>
                También se admiten comas decimales españolas.
              </Text>

              <Text style={styles.inputLabel}>Fecha (DD/MM/AAAA):</Text>
              <TextInput
                style={styles.textInput}
                value={manualDate}
                onChangeText={setManualDate}
                placeholder="DD/MM/AAAA"
                keyboardType="numbers-and-punctuation"
              />

              <Text style={styles.inputLabel}>Hora (HH:mm:ss):</Text>
              <TextInput
                style={styles.textInput}
                value={manualTime}
                onChangeText={setManualTime}
                placeholder="HH:mm:ss"
                keyboardType="numbers-and-punctuation"
              />

              <View style={styles.modalButtonsRow}>
                <TouchableOpacity
                  style={[styles.modalButton, styles.modalButtonCancel]}
                  onPress={() => setShowManualEntryModal(false)}
                >
                  <Text style={styles.modalButtonText}>Cancelar</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.modalButton, styles.modalButtonSave]}
                  onPress={() => void handleSaveManualEntry()}
                >
                  <Text style={styles.modalButtonText}>Guardar</Text>
                </TouchableOpacity>
              </View>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 40 },
  section: { marginBottom: 24, backgroundColor: '#fff', padding: 16, borderRadius: 12, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.1, shadowRadius: 2, elevation: 2 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 8 },
  historyActions: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0, marginBottom: 8 },
  buttonAddManual: { width: 42, height: 42, borderRadius: 8, backgroundColor: '#007AFF', alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  sectionTitle: { fontSize: 18, fontWeight: 'bold', color: '#11181C', marginBottom: 12 },
  sectionTitleInHeader: { flex: 1, flexShrink: 1, marginBottom: 0 },
  button: { backgroundColor: '#007AFF', paddingVertical: 12, paddingHorizontal: 16, borderRadius: 8, alignItems: 'center', marginBottom: 12 },
  buttonDanger: { backgroundColor: '#FF3B30' },
  buttonText: { color: 'white', fontSize: 16, fontWeight: '600' },
  buttonSmall: { flexShrink: 0, backgroundColor: '#FF3B30', paddingVertical: 6, paddingHorizontal: 10, borderRadius: 6 },
  buttonExport: { flexShrink: 0, backgroundColor: '#007AFF', paddingVertical: 6, paddingHorizontal: 10, borderRadius: 6 },
  buttonImport: { flexShrink: 0, backgroundColor: '#34C759', paddingVertical: 6, paddingHorizontal: 10, borderRadius: 6 },
  buttonSmallText: { color: 'white', fontSize: 12, fontWeight: '600' },
  helpText: { color: '#687076', fontSize: 13, lineHeight: 18, marginBottom: 12 },
  statusText: { fontSize: 14, color: '#22C55E', marginBottom: 12, fontWeight: '500' },
  plateItem: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#F5F5F5', paddingVertical: 12, paddingHorizontal: 12, borderRadius: 8, marginBottom: 8 },
  plateText: { fontSize: 16, fontWeight: 'bold', color: '#FF3B30' },
  plateSubText: { fontSize: 12, color: '#687076', marginTop: 2 },
  emptyText: { fontSize: 14, color: '#687076', fontStyle: 'italic', textAlign: 'center', marginVertical: 8 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', paddingHorizontal: 20 },
  modalScrollContent: { flexGrow: 1, justifyContent: 'center', paddingVertical: 24 },
  modalContent: { backgroundColor: 'white', borderRadius: 12, padding: 20, width: '100%', maxWidth: 400, alignSelf: 'center' },
  modalTitleText: { fontSize: 18, fontWeight: 'bold', marginBottom: 16, textAlign: 'center', color: '#11181C' },
  inputLabel: { fontSize: 14, fontWeight: '600', color: '#374151', marginBottom: 6 },
  textInput: { borderWidth: 1, borderColor: '#D1D5DB', borderRadius: 8, padding: 10, fontSize: 15, marginBottom: 16, backgroundColor: '#F9FAFB', color: '#007AFF' },
  textInputValid: { borderColor: '#34C759' },
  textInputInvalid: { borderColor: '#FF3B30' },
  validationErrorText: { color: '#FF3B30', fontSize: 13, marginTop: -10, marginBottom: 12 },
  validationWarningText: { color: '#FF9500', fontSize: 13, fontWeight: '600', marginTop: -8, marginBottom: 12 },
  modalHelpText: { color: '#687076', fontSize: 12, marginTop: -10, marginBottom: 12 },
  modalButtonsRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
  modalButton: { flex: 1, paddingVertical: 12, borderRadius: 8, alignItems: 'center', marginHorizontal: 6 },
  modalButtonCancel: { backgroundColor: '#687076' },
  modalButtonSave: { backgroundColor: '#007AFF' },
  modalButtonText: { color: 'white', fontSize: 16, fontWeight: '600' },
});
