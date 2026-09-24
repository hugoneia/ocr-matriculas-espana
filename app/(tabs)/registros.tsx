import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Linking, Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
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
}

interface StoredDetection {
  plate: string;
  timestamp?: number;
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

      if (typeof plate === 'string' && plate.trim()) {
        entries.push({
          plate: plate.trim().toUpperCase(),
          timestamp,
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
      const platesData = (await platesFile.text())
        .split('\n')
        .filter(Boolean)
        .slice(1)
        .map((line) => {
          const match = line.match(/^([^,]*),([^,]*),([^,]*),"([^"]*)"$/);
          if (!match) return null;

          const [, rawPlate = '', rawDate = '', rawTime = '', rawCoordinates = ''] = match;
          const [rawLatitude = '', rawLongitude = ''] = rawCoordinates.split(',');
          const plate = rawPlate.trim().toUpperCase();
          const latitude = rawLatitude.trim();
          const longitude = rawLongitude.trim();

          return plate && latitude && longitude
            ? { plate, date: rawDate.trim(), time: rawTime.trim(), latitude, longitude }
            : null;
        })
        .filter((item): item is ScannedPlate => item !== null)
        .filter((item) => item.plate in importedStore)
        .reverse();

      setScannedPlates(platesData);
    } catch (error) {
      console.error('Error loading scanned plates:', error);
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
          await AsyncStorage.removeItem(ALL_DETECTIONS_STORAGE_KEY);
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
                const match = line.match(/^([^,]*),([^,]*),([^,]*),"([^"]*)"$/);
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
              // Buscar la detección correspondiente en AsyncStorage.
              //
              // La hora del CSV puede ser posterior a la hora del OCR
              // porque entre ambas operaciones se obtiene el GPS.
              // Por eso se busca la detección de la misma matrícula cuyo
              // timestamp sea el más cercano, con un máximo de 5 minutos.
              // --------------------------------------------------------
              const rawDetections = await AsyncStorage.getItem(
                ALL_DETECTIONS_STORAGE_KEY,
              );

              if (rawDetections === null) {
                Alert.alert(
                  'Error',
                  'No se encontró el almacenamiento de detecciones. No se ha eliminado el registro.',
                );
                return;
              }

              const detections = parseStoredDetections(rawDetections);
              const targetTimestamp = parseSpanishDateTimeToTimestamp(
                item.date,
                item.time,
              );

              let detectionIndex = -1;
              let closestDifference = Number.POSITIVE_INFINITY;

              if (targetTimestamp !== null) {
                detections.forEach((detection, index) => {
                  if (
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

              // Para datos antiguos sin timestamp solo permitimos el borrado
              // si existe exactamente una detección de esa matrícula.
              if (detectionIndex === -1) {
                const samePlateIndexes = detections
                  .map((detection, index) => ({ detection, index }))
                  .filter(({ detection }) => detection.plate === item.plate)
                  .map(({ index }) => index);

                const indexesWithoutTimestamp = samePlateIndexes.filter(
                  (index) => typeof detections[index]?.timestamp !== 'number',
                );

                if (indexesWithoutTimestamp.length === 1 && samePlateIndexes.length === 1) {
                  detectionIndex = indexesWithoutTimestamp[0];
                }
              }

              if (detectionIndex === -1) {
                Alert.alert(
                  'Error',
                  'No se pudo asociar de forma segura este registro con la detección almacenada. No se ha eliminado nada.',
                );
                return;
              }

              // --------------------------------------------------------
              // Actualizar primero AsyncStorage.
              // --------------------------------------------------------
              detections.splice(detectionIndex, 1);

              await AsyncStorage.setItem(
                ALL_DETECTIONS_STORAGE_KEY,
                JSON.stringify(detections),
              );

              // --------------------------------------------------------
              // Después eliminar exactamente esa línea del CSV.
              // --------------------------------------------------------
              dataLines.splice(targetIndex, 1);

              if (dataLines.length === 0) {
                await platesFile.delete();
              } else {
                await platesFile.write(
                  `${[header, ...dataLines].join('\n')}\n`,
                );
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

      await Sharing.shareAsync(platesFile.uri, {
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
            <View style={styles.historyActions}>
              <TouchableOpacity style={styles.buttonExport} onPress={() => void handleExportRecords()}>
                <Text style={styles.buttonSmallText}>📤 Exportar</Text>
              </TouchableOpacity>
              {scannedPlates.length > 0 && (
                <TouchableOpacity style={styles.buttonSmall} onPress={handleClearOCR}>
                  <Text style={styles.buttonSmallText}>Eliminar</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
          <Text style={styles.helpText}>Solo se muestran detecciones que existen en el CSV importado.</Text>
          {scannedPlates.length > 0 ? (
            <FlatList
              data={scannedPlates}
              keyExtractor={(item, index) => `${item.plate}-${item.date}-${item.time}-${index}`}
              scrollEnabled={false}
              renderItem={({ item }) => (
                <View style={styles.plateItem}>
                  <View>
                    <TouchableOpacity onPress={() => void openPlateLocation(item)}>
                      <Text style={styles.plateText}>{item.plate}</Text>
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
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 40 },
  section: { marginBottom: 24, backgroundColor: '#fff', padding: 16, borderRadius: 12, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.1, shadowRadius: 2, elevation: 2 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 8 },
  historyActions: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 },
  sectionTitle: { fontSize: 18, fontWeight: 'bold', color: '#11181C', marginBottom: 12 },
  sectionTitleInHeader: { flex: 1, flexShrink: 1, marginBottom: 0 },
  button: { backgroundColor: '#007AFF', paddingVertical: 12, paddingHorizontal: 16, borderRadius: 8, alignItems: 'center', marginBottom: 12 },
  buttonDanger: { backgroundColor: '#FF3B30' },
  buttonText: { color: 'white', fontSize: 16, fontWeight: '600' },
  buttonSmall: { flexShrink: 0, backgroundColor: '#FF3B30', paddingVertical: 6, paddingHorizontal: 10, borderRadius: 6 },
  buttonExport: { flexShrink: 0, backgroundColor: '#007AFF', paddingVertical: 6, paddingHorizontal: 10, borderRadius: 6 },
  buttonSmallText: { color: 'white', fontSize: 12, fontWeight: '600' },
  helpText: { color: '#687076', fontSize: 13, lineHeight: 18, marginBottom: 12 },
  statusText: { fontSize: 14, color: '#22C55E', marginBottom: 12, fontWeight: '500' },
  plateItem: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#F5F5F5', paddingVertical: 12, paddingHorizontal: 12, borderRadius: 8, marginBottom: 8 },
  plateText: { fontSize: 16, fontWeight: 'bold', color: '#FF3B30' },
  plateSubText: { fontSize: 12, color: '#687076', marginTop: 2 },
  emptyText: { fontSize: 14, color: '#687076', fontStyle: 'italic', textAlign: 'center', marginVertical: 8 },
});
