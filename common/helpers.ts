/**
 * Returns true if and only if the value is null or undefined.
 *
 * @param value
 */
export function isNil (value: any): boolean {
  // Uses == over === which compares both null and undefined.
  return value == null;
}

/**
 * Returns true if and only if the value is an object and not an array.
 *
 * @param value
 */
export function isObject (value: any): boolean {
  // typeof [] will result in an 'object' so this additionally uses Array.isArray
  // to confirm it's just an object.
  return typeof value === 'object' && !Array.isArray(value);
}

/**
 * Returns the exception as a string for an error message, such as `Error: boom` or
 * `RangeError: Maximum call stack size exceeded`.
 *
 * @param e The thrown value.
 */
export function describeException (e: any): string {
  try {
    return String(e);
  } catch (conversionError) {
    return 'an exception that cannot be converted to a string';
  }
}
