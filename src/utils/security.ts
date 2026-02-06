/**
 * Security Utilities
 *
 * Helper functions for secure logging, validation, and error handling.
 */

// ============================================================================
// Constants
// ============================================================================

/** Maximum uint256 value (for BigInt bounds checking) */
export const MAX_UINT256 = 2n ** 256n - 1n;

/** Minimum valid amount (must be positive) */
export const MIN_AMOUNT = 1n;

// ============================================================================
// Address Redaction
// ============================================================================

/**
 * Redact an Ethereum address for logging
 * Example: 0x1234...5678
 */
export function redactAddress(address: string): string {
  if (!address || address.length < 10) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/**
 * Redact a transaction hash for logging
 * Example: 0xabcd...ef01
 */
export function redactHash(hash: string): string {
  if (!hash || hash.length < 10) return hash;
  return `${hash.slice(0, 10)}...${hash.slice(-4)}`;
}

// ============================================================================
// Amount Validation
// ============================================================================

/**
 * Validate that a string represents a valid BigInt amount
 * - Must be a valid numeric string
 * - Must be non-negative
 * - Must be within uint256 bounds
 */
export function validateAmount(amountStr: string): { valid: boolean; amount?: bigint; error?: string } {
  // Check for empty or invalid input
  if (!amountStr || typeof amountStr !== 'string') {
    return { valid: false, error: 'Amount is required' };
  }

  // Check for valid numeric string (no decimals, no negative sign at start allowed for final value)
  if (!/^-?\d+$/.test(amountStr)) {
    return { valid: false, error: 'Amount must be a valid integer string' };
  }

  try {
    const amount = BigInt(amountStr);

    // Check for negative
    if (amount < 0n) {
      return { valid: false, error: 'Amount cannot be negative' };
    }

    // Check for zero (optional - depends on use case)
    if (amount === 0n) {
      return { valid: false, error: 'Amount cannot be zero' };
    }

    // Check upper bound
    if (amount > MAX_UINT256) {
      return { valid: false, error: 'Amount exceeds maximum uint256 value' };
    }

    return { valid: true, amount };
  } catch {
    return { valid: false, error: 'Invalid amount format' };
  }
}

/**
 * Safe BigInt conversion with bounds checking
 * Returns null if invalid
 */
export function safeBigInt(value: string | number | bigint): bigint | null {
  try {
    const result = BigInt(value);
    if (result < 0n || result > MAX_UINT256) {
      return null;
    }
    return result;
  } catch {
    return null;
  }
}

// ============================================================================
// Configuration Validation
// ============================================================================

/**
 * Validate that a private key is in the correct format
 * Must be a 0x-prefixed 64-character hex string
 */
export function validatePrivateKey(key: string | undefined): { valid: boolean; error?: string } {
  if (!key) {
    return { valid: false, error: 'Private key is required' };
  }

  // Must start with 0x
  if (!key.startsWith('0x')) {
    return { valid: false, error: 'Private key must start with 0x' };
  }

  // Must be exactly 66 characters (0x + 64 hex chars)
  if (key.length !== 66) {
    return { valid: false, error: 'Private key must be 64 hex characters (66 with 0x prefix)' };
  }

  // Must be valid hex
  if (!/^0x[a-fA-F0-9]{64}$/.test(key)) {
    return { valid: false, error: 'Private key must be valid hexadecimal' };
  }

  return { valid: true };
}

/**
 * Validate that an Ethereum address is in the correct format
 */
export function validateAddress(address: string | undefined): { valid: boolean; error?: string } {
  if (!address) {
    return { valid: false, error: 'Address is required' };
  }

  if (!address.startsWith('0x')) {
    return { valid: false, error: 'Address must start with 0x' };
  }

  if (address.length !== 42) {
    return { valid: false, error: 'Address must be 40 hex characters (42 with 0x prefix)' };
  }

  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return { valid: false, error: 'Address must be valid hexadecimal' };
  }

  return { valid: true };
}

/**
 * Validate a positive integer configuration value
 */
export function validatePositiveInt(value: number, name: string, min?: number, max?: number): { valid: boolean; error?: string } {
  if (isNaN(value)) {
    return { valid: false, error: `${name} must be a valid number` };
  }

  if (value <= 0) {
    return { valid: false, error: `${name} must be positive` };
  }

  if (min !== undefined && value < min) {
    return { valid: false, error: `${name} must be at least ${min}` };
  }

  if (max !== undefined && value > max) {
    return { valid: false, error: `${name} must be at most ${max}` };
  }

  return { valid: true };
}

// ============================================================================
// Error Sanitization
// ============================================================================

/**
 * Sanitize an error message for external responses
 * Removes sensitive details like addresses, keys, etc.
 */
export function sanitizeError(error: string): string {
  // Remove any hex strings that look like private keys or long hashes
  let sanitized = error.replace(/0x[a-fA-F0-9]{64,}/g, '[REDACTED]');

  // Remove full addresses but keep truncated version
  sanitized = sanitized.replace(/0x[a-fA-F0-9]{40}/g, (match) => redactAddress(match));

  // Remove any URLs that might contain sensitive params
  sanitized = sanitized.replace(/https?:\/\/[^\s]+/g, '[URL]');

  return sanitized;
}
