import { describe, expect, it } from 'vitest';
import { appendHomeColumnToCsv, mergeImportedHomeRecords, normalizeHomeRecordStates, removeHomeRecordAt, toggleHomeRecord } from '../utils/home-records';

const rows = [
  '1234ABC,01/01/2026,10:00:00,"40.1,-3.1",OK',
  '1234ABC,02/01/2026,11:00:00,"40.2,-3.2",OK',
  '5678BCD,03/01/2026,12:00:00,"40.3,-3.3",OK',
];

describe('marcas de domicilio', () => {
  it('solo permite una fila de domicilio por matrícula', () => {
    const initial = normalizeHomeRecordStates(null, rows);
    const next = toggleHomeRecord(toggleHomeRecord(initial, 0), 1);
    expect(next.map((s) => s.isHome)).toEqual([false, true, false]);
    expect(toggleHomeRecord(next, 2).map((s) => s.isHome)).toEqual([false, true, true]);
  });

  it('conserva el estado si solo cambian las coordenadas', () => {
    const initial = toggleHomeRecord(normalizeHomeRecordStates(null, rows), 0);
    const changed = ['1234ABC,01/01/2026,10:00:00,"40.9,-3.9",OK', ...rows.slice(1)];
    const restored = normalizeHomeRecordStates(JSON.stringify(initial), changed);
    expect(restored[0].isHome).toBe(true);
    expect(restored[0].id).toBe(initial[0].id);
  });

  it('elimina el estado correspondiente al borrar una fila', () => {
    const initial = toggleHomeRecord(toggleHomeRecord(normalizeHomeRecordStates(null, rows), 1), 2);
    const remaining = removeHomeRecordAt(initial, 0);
    expect(remaining.map((s) => s.plate)).toEqual(['1234ABC', '5678BCD']);
    expect(remaining.map((s) => s.isHome)).toEqual([true, true]);
  });

  it('añade SI/NO al CSV exportado sin cambiar el original', () => {
    const csv = `MATRÍCULA,FECHA,HORA,LATITUD/LONGITUD,LUGAR\n${rows.join('\n')}\n`;
    const states = toggleHomeRecord(normalizeHomeRecordStates(null, rows), 1);
    const exported = appendHomeColumnToCsv(csv, states);
    expect(exported).toContain('LUGAR,IS_HOME');
    expect(exported).toContain('1234ABC,02/01/2026,11:00:00,"40.2,-3.2",OK,SI');
    expect(exported).toContain('1234ABC,01/01/2026,10:00:00,"40.1,-3.1",OK,NO');
    expect(csv).not.toContain('IS_HOME');
  });

  it('no duplica IS_HOME al volver a exportar un CSV que ya lo contiene', () => {
    const previouslyExported =
      'MATRÍCULA,FECHA,HORA,LATITUD/LONGITUD,LUGAR,IS_HOME\n' +
      '1234ABC,01/01/2026,10:00:00,"40.1,-3.1",OK,NO\n' +
      '5678BCD,03/01/2026,12:00:00,"40.3,-3.3",OK,SI\n';

    const states = toggleHomeRecord(
      normalizeHomeRecordStates(null, rows),
      0,
    );

    const result = appendHomeColumnToCsv(previouslyExported, states);
    const resultLines = result.trimEnd().split('\n');

    expect(resultLines[0]).toBe(
      'MATRÍCULA,FECHA,HORA,LATITUD/LONGITUD,LUGAR,IS_HOME',
    );
    expect(resultLines[1]).toBe(
      '1234ABC,01/01/2026,10:00:00,"40.1,-3.1",OK,SI',
    );
    expect(resultLines[2]).toBe(
      '5678BCD,03/01/2026,12:00:00,"40.3,-3.3",OK,NO',
    );
    expect(resultLines[0].split(',').filter(
      (column) => column === 'IS_HOME',
    )).toHaveLength(1);
  });

  it('mantiene las marcas alineadas cuando hay líneas vacías en el CSV', () => {
    const csvWithBlankLine =
      'MATRÍCULA,FECHA,HORA,LATITUD/LONGITUD,LUGAR\n' +
      '1234ABC,01/01/2026,10:00:00,"40.1,-3.1",OK\n' +
      '\n' +
      '5678BCD,03/01/2026,12:00:00,"40.3,-3.3",OK\n';

    const csvRows = [
      '1234ABC,01/01/2026,10:00:00,"40.1,-3.1",OK',
      '5678BCD,03/01/2026,12:00:00,"40.3,-3.3",OK',
    ];
    const states = toggleHomeRecord(
      normalizeHomeRecordStates(null, csvRows),
      1,
    );

    const result = appendHomeColumnToCsv(csvWithBlankLine, states);

    expect(result).toContain(
      '5678BCD,03/01/2026,12:00:00,"40.3,-3.3",OK,SI',
    );
    expect(result).toContain(
      '1234ABC,01/01/2026,10:00:00,"40.1,-3.1",OK,NO',
    );
  });


  it('marca un registro duplicado como domicilio si la matrícula aún no tiene uno', () => {
    const existing = [rows[0], rows[1]];
    const result = mergeImportedHomeRecords(
      existing,
      [{
        row: rows[1],
        isHome: true,
        plate: '1234ABC',
      }],
      null,
    );

    expect(result.rows).toEqual(existing);
    expect(result.importedCount).toBe(0);
    expect(result.duplicateCount).toBe(1);
    expect(result.states.map((state) => state.isHome)).toEqual([false, true]);
  });

  it('conserva el domicilio existente aunque se importe otro SI para la misma matrícula', () => {
    const initial = toggleHomeRecord(normalizeHomeRecordStates(null, rows), 0);
    const result = mergeImportedHomeRecords(
      rows,
      [{
        row: rows[1],
        isHome: true,
        plate: '1234ABC',
      }],
      JSON.stringify(initial),
    );

    expect(result.states.map((state) => state.isHome)).toEqual([true, false, false]);
    expect(result.duplicateCount).toBe(1);
  });

  it('permite domicilios independientes para matrículas diferentes', () => {
    const result = mergeImportedHomeRecords(
      [],
      [
        { row: rows[0], isHome: true, plate: '1234ABC' },
        { row: rows[2], isHome: true, plate: '5678BCD' },
      ],
      null,
    );

    expect(result.importedCount).toBe(2);
    expect(result.states.map((state) => state.isHome)).toEqual([true, true]);
  });

  it('no elimina un domicilio existente cuando la fila importada indica NO', () => {
    const initial = toggleHomeRecord(normalizeHomeRecordStates(null, rows), 0);
    const result = mergeImportedHomeRecords(
      rows,
      [{
        row: rows[0],
        isHome: false,
        plate: '1234ABC',
      }],
      JSON.stringify(initial),
    );

    expect(result.states.map((state) => state.isHome)).toEqual([true, false, false]);
  });

  it('acepta CSV antiguo sin IS_HOME y conserva las marcas existentes', () => {
    const initial = toggleHomeRecord(normalizeHomeRecordStates(null, rows), 2);
    const result = mergeImportedHomeRecords(
      rows,
      [{
        row: '9999ZZZ,04/01/2026,13:00:00,"40.4,-3.4",OK',
        isHome: false,
        plate: '9999ZZZ',
      }],
      JSON.stringify(initial),
    );

    expect(result.importedCount).toBe(1);
    expect(result.states.map((state) => state.isHome)).toEqual([false, false, true, false]);
  });

});
