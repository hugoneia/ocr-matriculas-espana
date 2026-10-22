export interface ParsedDetectionCsvRow {
  rawPlate: string;
  rawDate: string;
  rawTime: string;
  rawCoordinates: string;
  rawPlace: string;
  rawHome: string;
}

/**
 * Analiza filas CSV de cinco columnas y exportaciones con IS_HOME como
 * sexta columna. Si no existe la sexta columna, rawHome toma el valor NO.
 */
export function parseDetectionCsvRow(
  line: string,
): ParsedDetectionCsvRow | null {
  const match = line.match(
    /^([^,]*),([^,]*),([^,]*),"([^"]*)"(?:,([^,]*))?(?:,([^,]*))?$/,
  );

  if (!match) return null;

  const [
    ,
    rawPlate = '',
    rawDate = '',
    rawTime = '',
    rawCoordinates = '',
    rawPlace = 'OK',
    rawHome = 'NO',
  ] = match;

  return {
    rawPlate,
    rawDate,
    rawTime,
    rawCoordinates,
    rawPlace,
    rawHome,
  };
}
