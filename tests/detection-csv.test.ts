import { describe, expect, it } from 'vitest';
import { parseDetectionCsvRow } from '../utils/detection-csv';

describe('parseDetectionCsvRow', () => {
  it('acepta CSV original de cinco columnas', () => {
    const result = parseDetectionCsvRow(
      '1234ABC,01/10/2026,10:15:00,"40.4168,-3.7038",OK',
    );

    expect(result).toEqual({
      rawPlate: '1234ABC',
      rawDate: '01/10/2026',
      rawTime: '10:15:00',
      rawCoordinates: '40.4168,-3.7038',
      rawPlace: 'OK',
      rawHome: 'NO',
    });
  });

  it('lee IS_HOME=SI en un CSV exportado de seis columnas', () => {
    const result = parseDetectionCsvRow(
      '1234ABC,01/10/2026,10:15:00,"40.4168,-3.7038",OK,SI',
    );

    expect(result).toEqual({
      rawPlate: '1234ABC',
      rawDate: '01/10/2026',
      rawTime: '10:15:00',
      rawCoordinates: '40.4168,-3.7038',
      rawPlace: 'OK',
      rawHome: 'SI',
    });
  });

  it('acepta el valor NO de la columna IS_HOME', () => {
    const result = parseDetectionCsvRow(
      '5678BCD,02/10/2026,11:20:00,"40.4000,-3.7000",OK,NO',
    );

    expect(result?.rawPlate).toBe('5678BCD');
    expect(result?.rawPlace).toBe('OK');
    expect(result?.rawHome).toBe('NO');
  });

  it('rechaza filas que no siguen el formato esperado', () => {
    expect(parseDetectionCsvRow('fila incorrecta')).toBeNull();
  });
});
