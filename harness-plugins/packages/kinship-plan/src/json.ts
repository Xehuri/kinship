/**
 * Convert an internal value to the lossless JSON value the dsh tool registry
 * expects. Plan data is already JSON; this boundary rejects a programming
 * error (undefined/function/symbol) instead of silently dropping it.
 *
 * @module kinship-plan/json
 */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { PlanValidationError } from './schema.js'

export function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new PlanValidationError('json', `non-finite number: ${String(value)}`)
    return value
  }
  if (Array.isArray(value)) return value.map(item => toJsonValue(item))
  if (typeof value === 'object') {
    const record: { [key: string]: JsonValue } = {}
    for (const [key, item] of Object.entries(value)) record[key] = toJsonValue(item)
    return record
  }
  throw new PlanValidationError('json', `value is not JSON: ${typeof value}`)
}
