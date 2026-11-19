export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function invalid(message) {
  throw new ApiError(400, 'invalid_input', message);
}

export function fields(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('Передайте объект JSON.');
  const extra = Object.keys(body).find(key => !allowed.includes(key));
  if (extra) invalid('В запросе есть неизвестное поле.');
}

export function string(value, max, label, min = 1) {
  if (typeof value !== 'string' || value.includes('\0') || !value.isWellFormed() ||
      [...value].length < min || [...value].length > max) invalid('Проверьте поле «' + label + '».');
  return value;
}

export function positiveId(value) {
  if (!/^[1-9]\d{0,9}$/.test(value) || Number(value) > 2147483647) invalid('Некорректный идентификатор записи.');
  return Number(value);
}

export async function transaction(pool, operation) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const result = await operation(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}
