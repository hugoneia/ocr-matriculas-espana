import AsyncStorage from "@react-native-async-storage/async-storage";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";

export const IMPORTED_PLATES_STORAGE_KEY = "imported_plates";

export interface ImportedPlateData {
  fecha: string;
  hora: string;
}

export function normalizeImportedPlates(
  rawValue: string | null,
): Record<string, ImportedPlateData> {
  if (!rawValue) return {};

  try {
    const parsed = JSON.parse(rawValue);
    if (Array.isArray(parsed)) {
      return parsed.reduce<Record<string, ImportedPlateData>>((store, plate) => {
        if (typeof plate === "string" && plate.trim()) {
          store[plate.trim().toUpperCase()] = { fecha: "", hora: "" };
        }
        return store;
      }, {});
    }

    if (parsed && typeof parsed === "object") {
      return Object.keys(parsed).reduce<Record<string, ImportedPlateData>>((store, plate) => {
        const value = parsed[plate] ?? {};
        store[plate.toUpperCase()] = {
          fecha: typeof value.fecha === "string" ? value.fecha : "",
          hora: typeof value.hora === "string" ? value.hora : "",
        };
        return store;
      }, {});
    }
  } catch (error) {
    console.error("Error parsing imported plates:", error);
  }

  return {};
}

export async function getImportedPlates(): Promise<Record<string, ImportedPlateData>> {
  return normalizeImportedPlates(
    await AsyncStorage.getItem(IMPORTED_PLATES_STORAGE_KEY),
  );
}

export async function importPlatesCSV(
  sharedFile?: { uri: string; name: string },
): Promise<{
  newImportedPlates: Record<string, ImportedPlateData>;
  newCount: number;
} | null> {
  let selectedUri: string;

  if (sharedFile) {
    selectedUri = sharedFile.uri;
  } else {
    const result = await DocumentPicker.getDocumentAsync({
      type: [
        "text/csv",
        "text/comma-separated-values",
        "application/csv",
        "application/vnd.ms-excel",
        "text/plain",
      ],
      copyToCacheDirectory: true,
    });

    if (result.canceled || !result.assets?.length) return null;
    selectedUri = result.assets[0].uri;
  }

  const tempUri = `${FileSystem.cacheDirectory}temp_import.csv`;
  await FileSystem.deleteAsync(tempUri, { idempotent: true });
  await FileSystem.copyAsync({ from: selectedUri, to: tempUri });

  const lines = (
    await FileSystem.readAsStringAsync(tempUri, {
      encoding: FileSystem.EncodingType.UTF8,
    })
  )
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => line.trim() !== "");

  const newImportedPlates: Record<string, ImportedPlateData> = {};
  const firstRowIsHeader = lines[0]?.toUpperCase().includes("MATR") ?? false;

  for (let i = firstRowIsHeader ? 1 : 0; i < lines.length; i += 1) {
    const columns = lines[i].split(",");
    const plate = columns[0]?.replace(/"/g, "").trim().toUpperCase();
    if (!plate) continue;

    newImportedPlates[plate] = {
      fecha: columns[1]?.replace(/"/g, "").trim() ?? "",
      hora: columns[2]?.replace(/"/g, "").trim() ?? "",
    };
  }

  const previousImportedPlates = await getImportedPlates();
  const newCount = Object.keys(newImportedPlates).filter(
    (plate) => !(plate in previousImportedPlates),
  ).length;

  await AsyncStorage.setItem(
    IMPORTED_PLATES_STORAGE_KEY,
    JSON.stringify(newImportedPlates),
  );

  await FileSystem.deleteAsync(tempUri, { idempotent: true });

  return { newImportedPlates, newCount };
}
