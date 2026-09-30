import MapView, {
  Marker,
  PROVIDER_GOOGLE,
  type MapMarkerDragEvent,
  type Region,
} from "react-native-maps";
import * as FileSystem from "expo-file-system/legacy";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { useFocusEffect } from "expo-router";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";

import { ScreenContainer } from "@/components/screen-container";

type Coordinate = {
  latitude: number;
  longitude: number;
};

type CsvRecord = {
  rowIndex: number;
  originalLine: string;
  plate: string;
  date: string;
  time: string;
  coordinatesText: string;
  coordinate: Coordinate;
  place: string;
};

type CoordinateGroup = {
  key: string;
  coordinate: Coordinate;
  records: CsvRecord[];
};

const CSV_FILE = `${FileSystem.documentDirectory}matriculas_detectadas.csv`;

const CSV_HEADER = "MATRÍCULA,FECHA,HORA,LATITUD/LONGITUD,LUGAR";

function parseCoordinate(value: string): Coordinate | null {
  const match = value.trim().match(
    /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/
  );

  if (!match) {
    return null;
  }

  const latitude = Number(match[1]);
  const longitude = Number(match[2]);

  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return null;
  }

  return {
    latitude,
    longitude,
  };
}

function parseCsvLine(line: string, rowIndex: number): CsvRecord | null {
  const match = line.match(
    /^([^,]*),([^,]*),([^,]*),"([^"]*)"(?:,([^,]*))?$/
  );

  if (!match) {
    return null;
  }

  const [
    ,
    rawPlate = "",
    rawDate = "",
    rawTime = "",
    rawCoordinates = "",
    rawPlace = "",
  ] = match;

  const coordinate = parseCoordinate(rawCoordinates);

  if (!coordinate) {
    return null;
  }

  return {
    rowIndex,
    originalLine: line,
    plate: rawPlate.trim().toUpperCase(),
    date: rawDate.trim(),
    time: rawTime.trim(),
    coordinatesText: rawCoordinates.trim(),
    coordinate,
    place: rawPlace.trim(),
  };
}

const EARTH_RADIUS_METERS = 6371000;
const NEARBY_RADIUS_METERS = 10;
const MARKER_GREEN = "#22C55E";
const MARKER_CLOSE_ZOOM_LATITUDE_DELTA = 0.004;

function distanceInMeters(a: Coordinate, b: Coordinate): number {
  const latitude1 = (a.latitude * Math.PI) / 180;
  const latitude2 = (b.latitude * Math.PI) / 180;
  const deltaLatitude = ((b.latitude - a.latitude) * Math.PI) / 180;
  const deltaLongitude = ((b.longitude - a.longitude) * Math.PI) / 180;

  const sinLatitude = Math.sin(deltaLatitude / 2);
  const sinLongitude = Math.sin(deltaLongitude / 2);

  const haversine =
    sinLatitude * sinLatitude +
    Math.cos(latitude1) *
      Math.cos(latitude2) *
      sinLongitude *
      sinLongitude;

  return (
    2 *
    EARTH_RADIUS_METERS *
    Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
  );
}

function buildUpdatedLine(
  record: CsvRecord,
  coordinate: Coordinate
): string {
  const coordinates = `${coordinate.latitude},${coordinate.longitude}`;

  return `${record.plate},${record.date},${record.time},"${coordinates}",${record.place}`;
}

export default function MapaScreen() {
  const mapRef = useRef<MapView | null>(null);

  const [records, setRecords] = useState<CsvRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedPlate, setSelectedPlate] = useState<string | null>(null);
  const [showSuggestions, setShowSuggestions] = useState(false);

  const [selectedRecord, setSelectedRecord] = useState<CsvRecord | null>(null);
  const [editingCoordinate, setEditingCoordinate] =
    useState<Coordinate | null>(null);

  const [selectionGroup, setSelectionGroup] =
    useState<CoordinateGroup | null>(null);

  const [saving, setSaving] = useState(false);
  const [mapLatitudeDelta, setMapLatitudeDelta] = useState(0.08);

  const mapType = selectedRecord ? "satellite" : "standard";

  const loadRecords = useCallback(async () => {
    try {
      const info = await FileSystem.getInfoAsync(CSV_FILE);

      if (!info.exists) {
        setRecords([]);
        setLoaded(true);
        return;
      }

      const content = await FileSystem.readAsStringAsync(CSV_FILE);

      const lines = content
        .split(/\r?\n/)
        .filter((line) => line.trim() !== "");

      const parsed: CsvRecord[] = [];

      for (let i = 1; i < lines.length; i += 1) {
        const record = parseCsvLine(lines[i], i);

        if (record) {
          parsed.push(record);
        }
      }

      setRecords(parsed);
    } catch (error) {
      console.error("Error cargando registros para el mapa:", error);
      Alert.alert("Mapa", "No se pudieron cargar los registros del CSV.");
      setRecords([]);
    } finally {
      setLoaded(true);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadRecords();
    }, [loadRecords]),
  );

  const filteredRecords = useMemo(() => {
    if (!selectedPlate) {
      return records;
    }

    return records.filter((record) => record.plate === selectedPlate);
  }, [records, selectedPlate]);

  const groups = useMemo<CoordinateGroup[]>(
    () =>
      filteredRecords.map((record) => ({
        key: `${record.rowIndex}`,
        coordinate: record.coordinate,
        records: [record],
      })),
    [filteredRecords],
  );

  const plateSuggestions = useMemo(() => {
    const query = searchQuery.trim().toUpperCase();

    if (!query) {
      return [];
    }

    const uniquePlates = Array.from(
      new Set(records.map((record) => record.plate).filter(Boolean))
    );

    return uniquePlates
      .filter((plate) => plate.includes(query))
      .sort();
  }, [records, searchQuery]);

  const initialRegion = useMemo<Region | null>(() => {
    if (groups.length === 0) {
      return null;
    }

    const first = groups[0].coordinate;

    return {
      latitude: first.latitude,
      longitude: first.longitude,
      latitudeDelta: 0.08,
      longitudeDelta: 0.08,
    };
  }, [groups]);

  const handleMapLoaded = () => {
    if (!mapRef.current || groups.length === 0) {
      return;
    }

    mapRef.current.fitToCoordinates(
      groups.map((group) => group.coordinate),
      {
        edgePadding: {
          top: 100,
          right: 50,
          bottom: 150,
          left: 50,
        },
        animated: false,
      }
    );
  };

  const handleSelectPlate = (plate: string | null) => {
    setSelectedPlate(plate);
    setSearchQuery(plate ?? "");
    setShowSuggestions(false);

    requestAnimationFrame(() => {
      if (!mapRef.current) {
        return;
      }

      const nextRecords = plate
        ? records.filter((record) => record.plate === plate)
        : records;

      const nextCoordinates = nextRecords.map((record) => record.coordinate);

      if (nextCoordinates.length > 0) {
        mapRef.current.fitToCoordinates(nextCoordinates, {
          edgePadding: {
            top: 100,
            right: 50,
            bottom: 150,
            left: 50,
          },
          animated: true,
        });
      }
    });
  };

  const handleMarkerPress = (group: CoordinateGroup) => {
    const tappedRecord = group.records[0];

    const nearbyRecords = filteredRecords.filter(
      (record) =>
        distanceInMeters(tappedRecord.coordinate, record.coordinate) <=
        NEARBY_RADIUS_METERS,
    );

    if (nearbyRecords.length === 1) {
      startEditing(tappedRecord);
      return;
    }

    setSelectionGroup({
      key: `${tappedRecord.rowIndex}`,
      coordinate: tappedRecord.coordinate,
      records: nearbyRecords,
    });
  };

  const startEditing = (record: CsvRecord) => {
    setSelectionGroup(null);
    setSelectedRecord(record);
    setEditingCoordinate(record.coordinate);

    requestAnimationFrame(() => {
      mapRef.current?.animateToRegion(
        {
          latitude: record.coordinate.latitude,
          longitude: record.coordinate.longitude,
          latitudeDelta: 0.001,
          longitudeDelta: 0.001,
        },
        350
      );
    });
  };

  const cancelEditing = () => {
    setSelectedRecord(null);
    setEditingCoordinate(null);

    requestAnimationFrame(() => {
      if (mapRef.current && groups.length > 0) {
        mapRef.current.fitToCoordinates(
          groups.map((group) => group.coordinate),
          {
            edgePadding: {
              top: 100,
              right: 50,
              bottom: 150,
              left: 50,
            },
            animated: true,
          }
        );
      }
    });
  };

  const handleDragEnd = (event: MapMarkerDragEvent) => {
    const coordinate = event.nativeEvent.coordinate;

    setEditingCoordinate({
      latitude: coordinate.latitude,
      longitude: coordinate.longitude,
    });
  };

  const saveEditing = async () => {
    if (!selectedRecord || !editingCoordinate || saving) {
      return;
    }

    setSaving(true);

    try {
      const info = await FileSystem.getInfoAsync(CSV_FILE);

      if (!info.exists) {
        throw new Error("El archivo CSV ya no existe.");
      }

      const content = await FileSystem.readAsStringAsync(CSV_FILE);
      const lines = content
        .split(/\r?\n/)
        .filter((line) => line.trim() !== "");

      if (
        selectedRecord.rowIndex <= 0 ||
        selectedRecord.rowIndex >= lines.length
      ) {
        throw new Error("La fila seleccionada ya no existe.");
      }

      const currentLine = lines[selectedRecord.rowIndex];

      if (currentLine !== selectedRecord.originalLine) {
        throw new Error(
          "El registro cambió desde que se abrió el mapa. Recarga los registros antes de editarlo."
        );
      }

      lines[selectedRecord.rowIndex] = buildUpdatedLine(
        selectedRecord,
        editingCoordinate
      );

      const output = `${lines.join("\n")}\n`;

      await FileSystem.writeAsStringAsync(CSV_FILE, output);

      setSelectedRecord(null);
      setEditingCoordinate(null);

      await loadRecords();

      Alert.alert("Mapa", "Ubicación guardada correctamente.");
    } catch (error) {
      console.error("Error guardando ubicación:", error);

      Alert.alert(
        "Mapa",
        error instanceof Error
          ? error.message
          : "No se pudo guardar la ubicación."
      );
    } finally {
      setSaving(false);
    }
  };

  const handleSearchChange = (text: string) => {
    setSearchQuery(text);
    setShowSuggestions(text.trim().length > 0);

    if (selectedPlate && text.trim().toUpperCase() !== selectedPlate) {
      setSelectedPlate(null);
    }
  };

  const handleClearSearch = () => {
    handleSelectPlate(null);
    setSearchQuery("");
    setShowSuggestions(false);
  };

  const currentCoordinate = editingCoordinate ?? selectedRecord?.coordinate;

  return (
    <ScreenContainer className="flex-1 p-4">
      <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Mapa</Text>

        {!selectedRecord ? (
          <Text style={styles.subtitle}>
            {selectedPlate
              ? `${filteredRecords.length} registro${
                  filteredRecords.length === 1 ? "" : "s"
                }`
              : `${records.length} registros`}
          </Text>
        ) : (
          <Text style={styles.subtitle}>
            Ajusta la ubicación y guarda el registro
          </Text>
        )}
      </View>

      {!selectedRecord && (
        <View style={styles.searchContainer}>
          <View style={styles.searchRow}>
            <TextInput
              value={searchQuery}
              onChangeText={handleSearchChange}
              onFocus={() => {
                if (searchQuery.trim()) {
                  setShowSuggestions(true);
                }
              }}
              placeholder="Buscar matrícula..."
              placeholderTextColor="#777"
              autoCapitalize="characters"
              autoCorrect={false}
              style={styles.searchInput}
            />

            {(searchQuery.length > 0 || selectedPlate) && (
              <Pressable
                onPress={handleClearSearch}
                style={styles.clearButton}
              >
                <Text style={styles.clearButtonText}>×</Text>
              </Pressable>
            )}
          </View>

          {showSuggestions && plateSuggestions.length > 0 && (
            <View style={styles.suggestions}>
              <FlatList
                keyboardShouldPersistTaps="handled"
                data={plateSuggestions}
                keyExtractor={(item) => item}
                renderItem={({ item }) => (
                  <Pressable
                    onPress={() => handleSelectPlate(item)}
                    style={styles.suggestion}
                  >
                    <Text style={styles.suggestionText}>{item}</Text>
                  </Pressable>
                )}
              />
            </View>
          )}

          {!selectedPlate && searchQuery.trim() === "" && (
            <Pressable
              onPress={() => handleSelectPlate(null)}
              style={styles.allButton}
            >
              <Text style={styles.allButtonText}>Todas</Text>
            </Pressable>
          )}
        </View>
      )}

      {selectedRecord && currentCoordinate && (
        <View style={styles.editBar}>
          <View style={styles.editInfo}>
            <Text style={styles.editTitle}>
              Editando {selectedRecord.plate}
            </Text>
            <Text style={styles.editCoordinates}>
              {currentCoordinate.latitude.toFixed(6)},{" "}
              {currentCoordinate.longitude.toFixed(6)}
            </Text>
          </View>

          <View style={styles.editActions}>
            <Pressable
              onPress={cancelEditing}
              disabled={saving}
              style={[styles.actionButton, styles.cancelButton]}
            >
              <Text style={styles.cancelButtonText}>Cancelar</Text>
            </Pressable>

            <Pressable
              onPress={saveEditing}
              disabled={saving}
              style={[styles.actionButton, styles.saveButton]}
            >
              <Text style={styles.saveButtonText}>
                {saving ? "Guardando..." : "Guardar"}
              </Text>
            </Pressable>
          </View>
        </View>
      )}

      <View style={styles.mapContainer}>
        {!loaded ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>Cargando registros...</Text>
          </View>
        ) : groups.length === 0 && !selectedRecord ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>Sin ubicaciones</Text>
            <Text style={styles.emptyText}>
              No hay registros con coordenadas válidas para mostrar.
            </Text>
          </View>
        ) : (
          <MapView
            ref={mapRef}
            style={StyleSheet.absoluteFill}
            mapType={mapType}
            initialRegion={initialRegion ?? undefined}
            provider={PROVIDER_GOOGLE}
            onMapReady={handleMapLoaded}
            onRegionChangeComplete={(region) => {
              setMapLatitudeDelta(region.latitudeDelta);
            }}
          >
            {!selectedRecord &&
              groups.map((group) => (
                <Marker
                  key={group.key}
                  coordinate={group.coordinate}
                  anchor={{ x: 0.5, y: 0.5 }}
                  title={
                    group.records.length === 1
                      ? group.records[0].plate
                      : `${group.records.length} registros`
                  }
                  description={
                    group.records.length === 1
                      ? `${group.records[0].date} ${group.records[0].time}`
                      : "Pulsa para seleccionar un registro"
                  }
                  onPress={() => handleMarkerPress(group)}
                >
                  {mapLatitudeDelta <= MARKER_CLOSE_ZOOM_LATITUDE_DELTA ? (
                    <MaterialIcons
                      name="fmd-good"
                      size={25}
                      color={MARKER_GREEN}
                    />
                  ) : (
                    <View
                      collapsable={false}
                      style={styles.markerBullet}
                    />
                  )}
                </Marker>
              ))}

            {selectedRecord && currentCoordinate && (
              <Marker
                coordinate={currentCoordinate}
                draggable
                title={selectedRecord.plate}
                description="Arrastra el marcador para ajustar la ubicación"
                onDragEnd={handleDragEnd}
              >
                <MaterialIcons
                  name="fmd-good"
                  size={28}
                  color={MARKER_GREEN}
                />
              </Marker>
            )}
          </MapView>
        )}
      </View>

      {selectionGroup && (
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Seleccionar registro</Text>

            <Text style={styles.modalSubtitle}>
              {selectionGroup.records.length} registros en esta ubicación
            </Text>

            <FlatList
              data={selectionGroup.records}
              keyExtractor={(item) => `${item.rowIndex}-${item.originalLine}`}
              renderItem={({ item }) => (
                <Pressable
                  onPress={() => startEditing(item)}
                  style={styles.recordItem}
                >
                  <Text style={styles.recordPlate}>{item.plate}</Text>
                  <Text style={styles.recordDetails}>
                    {item.date} · {item.time}
                  </Text>
                </Pressable>
              )}
            />

            <Pressable
              onPress={() => setSelectionGroup(null)}
              style={styles.modalClose}
            >
              <Text style={styles.modalCloseText}>Cerrar</Text>
            </Pressable>
          </View>
        </View>
      )}
      </View>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#fff",
    borderRadius: 12,
    overflow: "hidden",
  },
  header: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },
  title: {
    fontSize: 24,
    fontWeight: "700",
    color: "#111",
  },
  subtitle: {
    marginTop: 2,
    fontSize: 13,
    color: "#666",
  },
  searchContainer: {
    zIndex: 10,
    paddingHorizontal: 12,
    paddingBottom: 8,
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 10,
    backgroundColor: "#fff",
  },
  searchInput: {
    flex: 1,
    height: 44,
    paddingHorizontal: 12,
    color: "#111",
    fontSize: 16,
  },
  clearButton: {
    width: 40,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  clearButtonText: {
    fontSize: 28,
    lineHeight: 30,
    color: "#777",
  },
  suggestions: {
    position: "absolute",
    left: 12,
    right: 12,
    top: 53,
    maxHeight: 220,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 10,
    overflow: "hidden",
    elevation: 6,
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 8,
    shadowOffset: {
      width: 0,
      height: 3,
    },
  },
  suggestion: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#ddd",
  },
  suggestionText: {
    fontSize: 16,
    fontWeight: "600",
    color: "#111",
  },
  allButton: {
    alignSelf: "flex-start",
    marginTop: 6,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: "#eee",
  },
  allButtonText: {
    fontSize: 13,
    color: "#333",
    fontWeight: "600",
  },
  editBar: {
    zIndex: 10,
    paddingHorizontal: 12,
    paddingBottom: 8,
    backgroundColor: "#fff",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#ccc",
  },
  editInfo: {
    marginBottom: 8,
  },
  editTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: "#111",
  },
  editCoordinates: {
    marginTop: 2,
    fontSize: 13,
    color: "#555",
  },
  editActions: {
    flexDirection: "row",
    gap: 8,
  },
  actionButton: {
    flex: 1,
    minHeight: 42,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
  },
  cancelButton: {
    backgroundColor: "#eee",
  },
  cancelButtonText: {
    color: "#222",
    fontWeight: "600",
  },
  saveButton: {
    backgroundColor: "#007AFF",
  },
  saveButtonText: {
    color: "#fff",
    fontWeight: "700",
  },
  mapContainer: {
    flex: 1,
    position: "relative",
  },
  markerBullet: {
    width: 11,
    height: 11,
    borderRadius: 999,
    backgroundColor: "#22C55E",
    borderWidth: 1.5,
    borderColor: "#fff",
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 30,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#222",
    marginBottom: 6,
  },
  emptyText: {
    textAlign: "center",
    color: "#666",
    fontSize: 14,
  },
  modalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "flex-end",
    zIndex: 20,
  },
  modalCard: {
    maxHeight: "75%",
    backgroundColor: "#fff",
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 18,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: "700",
    color: "#111",
  },
  modalSubtitle: {
    marginTop: 4,
    marginBottom: 12,
    color: "#666",
    fontSize: 13,
  },
  recordItem: {
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#ddd",
  },
  recordPlate: {
    fontSize: 16,
    fontWeight: "700",
    color: "#111",
  },
  recordDetails: {
    marginTop: 3,
    color: "#666",
    fontSize: 13,
  },
  modalClose: {
    marginTop: 12,
    marginBottom: 16,
    minHeight: 44,
    borderRadius: 9,
    backgroundColor: "#eee",
    alignItems: "center",
    justifyContent: "center",
  },
  modalCloseText: {
    color: "#222",
    fontWeight: "600",
  },
});
