/**
 * Formato estricto de matrícula española ordinaria:
 * 4 números + 3 consonantes.
 *
 * No permite las vocales A, E, I, O, U ni la letra Ñ.
 */
export const SPANISH_PLATE_REGEX =
  /^\d{4}[BCDFGHJKLMNPRSTVWXYZ]{3}$/;

/**
 * Normaliza una matrícula sin aplicar correcciones OCR.
 *
 * Solo elimina espacios exteriores y convierte a mayúsculas.
 * La validación sigue siendo estricta.
 */
export function normalizeSpanishPlate(plate: string): string {
  return plate.trim().toUpperCase();
}

/**
 * Comprueba si una matrícula cumple exactamente
 * el formato español de 4 números + 3 consonantes.
 */
export function isValidSpanishPlate(plate: string): boolean {
  return SPANISH_PLATE_REGEX.test(normalizeSpanishPlate(plate));
}
