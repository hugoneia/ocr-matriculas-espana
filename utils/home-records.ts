export interface HomeRecordIdentity {
  plate: string;
  date: string;
  time: string;
}

export interface HomeRecordState extends HomeRecordIdentity {
  id: string;
  isHome: boolean;
}

function identityFromLine(line: string): HomeRecordIdentity {
  const match = line.match(/^([^,]*),([^,]*),([^,]*),/);
  return {
    plate: (match?.[1] ?? '').replace(/"/g, '').trim().toUpperCase(),
    date: (match?.[2] ?? '').replace(/"/g, '').trim(),
    time: (match?.[3] ?? '').replace(/"/g, '').trim(),
  };
}

function newId(index: number, identity: HomeRecordIdentity): string {
  return `home-${index}-${identity.plate}-${identity.date}-${identity.time}-${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeHomeRecordStates(rawValue: string | null, rows: string[]): HomeRecordState[] {
  let previous: unknown[] = [];
  try {
    const parsed: unknown = rawValue ? JSON.parse(rawValue) : [];
    if (Array.isArray(parsed)) previous = parsed;
  } catch {
    previous = [];
  }

  const homes = new Set<string>();
  return rows.map((line, index) => {
    const identity = identityFromLine(line);
    const candidate = previous[index];
    const valid = candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)
      && (candidate as Record<string, unknown>).plate === identity.plate
      && (candidate as Record<string, unknown>).date === identity.date
      && (candidate as Record<string, unknown>).time === identity.time;
    const stored = valid ? candidate as Record<string, unknown> : null;
    const id = stored && typeof stored.id === 'string' && stored.id
      ? stored.id : newId(index, identity);
    const isHome = stored?.isHome === true && !!identity.plate && !homes.has(identity.plate);
    if (isHome) homes.add(identity.plate);
    return { id, ...identity, isHome };
  });
}

export function toggleHomeRecord(states: HomeRecordState[], targetIndex: number): HomeRecordState[] {
  if (targetIndex < 0 || targetIndex >= states.length) return states;
  const target = states[targetIndex];
  const setHome = !target.isHome;
  return states.map((state, index) => {
    if (index === targetIndex) return { ...state, isHome: setHome };
    if (setHome && state.plate === target.plate) return { ...state, isHome: false };
    return state;
  });
}

export function removeHomeRecordAt(states: HomeRecordState[], targetIndex: number): HomeRecordState[] {
  if (targetIndex < 0 || targetIndex >= states.length) return states;
  return states.filter((_, index) => index !== targetIndex);
}


export interface ImportedHomeRecord {
  row: string;
  isHome: boolean;
  plate: string;
}

export interface MergedHomeRecords {
  rows: string[];
  states: HomeRecordState[];
  importedCount: number;
  duplicateCount: number;
  newlyImportedKeys: string[];
}

function detectionKeyFromLine(line: string): string {
  const parts = line.split(',');
  if (parts.length < 3) return line;

  return [
    parts[0].trim().replace(/"/g, '').toUpperCase(),
    parts[1].trim().replace(/"/g, ''),
    parts[2].trim().replace(/"/g, ''),
  ].join('|');
}

/**
 * Combina filas importadas con el historial existente y restaura IS_HOME.
 *
 * - La identidad de un registro depende de matrícula, fecha y hora.
 * - Los registros existentes no se sustituyen por duplicados.
 * - Solo se asigna un domicilio por matrícula.
 * - Una marca SI importada puede marcar un duplicado existente si esa
 *   matrícula todavía no tiene domicilio.
 * - NO nunca elimina una marca de domicilio existente.
 */
export function mergeImportedHomeRecords(
  existingRows: string[],
  importedRows: ImportedHomeRecord[],
  rawHomeStates: string | null,
): MergedHomeRecords {
  const rows = [...existingRows];
  const existingStates = normalizeHomeRecordStates(rawHomeStates, rows);

  const homePlateSet = new Set(
    existingStates
      .filter((state) => state.isHome)
      .map((state) => state.plate.toUpperCase()),
  );

  const existingSet = new Set(rows.map(detectionKeyFromLine));
  const requestedHomeKeys: string[] = [];
  const newlyImportedKeys: string[] = [];
  let importedCount = 0;
  let duplicateCount = 0;

  for (const imported of importedRows) {
    const key = detectionKeyFromLine(imported.row);

    if (existingSet.has(key)) {
      duplicateCount += 1;
    } else {
      existingSet.add(key);
      rows.push(imported.row);
      newlyImportedKeys.push(key);
      importedCount += 1;
    }

    const plate = imported.plate.trim().toUpperCase();

    if (imported.isHome && plate && !homePlateSet.has(plate)) {
      requestedHomeKeys.push(key);
      homePlateSet.add(plate);
    }
  }

  const states = normalizeHomeRecordStates(
    JSON.stringify(existingStates),
    rows,
  );

  for (const key of requestedHomeKeys) {
    const targetIndex = rows.findIndex(
      (row) => detectionKeyFromLine(row) === key,
    );
    if (targetIndex < 0) continue;

    const target = states[targetIndex];
    if (!target) continue;

    for (let index = 0; index < states.length; index += 1) {
      const state = states[index];
      if (state?.plate === target.plate) {
        states[index] = {
          ...state,
          isHome: index === targetIndex,
        };
      }
    }
  }

  return {
    rows,
    states,
    importedCount,
    duplicateCount,
    newlyImportedKeys,
  };
}

export function appendHomeColumnToCsv(content: string, states: HomeRecordState[]): string {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n').filter((line) => line.trim() !== '');

  if (lines.length <= 1) return content;

  // Eliminar cualquier IS_HOME previo del encabezado y añadirlo una sola vez.
  const headerColumns = lines[0]
    .split(',')
    .filter((column) => column.trim().toUpperCase() !== 'IS_HOME');
  headerColumns.push('IS_HOME');

  const outputRows = lines.slice(1).map((line, index) => {
    // Aceptar las cinco columnas internas y las seis de una exportación previa.
    const match = line.match(
      /^([^,]*),([^,]*),([^,]*),"([^"]*)"(?:,([^,]*))?(?:,([^,]*))?$/,
    );

    if (!match) return line;

    const [
      ,
      plate = '',
      date = '',
      time = '',
      coordinates = '',
      place = 'OK',
    ] = match;

    const homeValue = states[index]?.isHome === true ? 'SI' : 'NO';
    return `${plate},${date},${time},"${coordinates}",${place},${homeValue}`;
  });

  return [headerColumns.join(','), ...outputRows].join('\n') + '\n';
}
