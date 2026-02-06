/**
 * Database Service
 *
 * PostgreSQL persistence for transactions, nonces, and webhooks.
 * Falls back to in-memory storage if DATABASE_URL is not set.
 */

import { Pool, PoolClient } from 'pg';

// ============================================================================
// Types
// ============================================================================

export interface TransactionRecord {
  id: string;
  nonce: string;
  payer: string;
  receiver: string;
  token_address: string;
  token_symbol: string;
  amount: string;
  fee: string;
  fee_percent: number;
  network: string;
  tx_hash: string | null;
  status: 'pending' | 'success' | 'failed';
  error_reason: string | null;
  protocol: 'permit2' | 'erc3009';
  created_at: Date;
  settled_at: Date | null;
}

export interface NonceRecord {
  payer: string;
  nonce: string;
  token_address: string;
  used_at: Date;
  tx_hash: string;
}

export interface WebhookRecord {
  id: string;
  url: string;
  secret: string | null;
  events: string[]; // ['settlement.success', 'settlement.failed']
  active: boolean;
  created_at: Date;
}

// ============================================================================
// Database Connection
// ============================================================================

let pool: Pool | null = null;
let isInitialized = false;

// In-memory fallback
const memoryStore = {
  transactions: new Map<string, TransactionRecord>(),
  nonces: new Set<string>(),
  webhooks: new Map<string, WebhookRecord>(),
};

/**
 * Initialize database connection
 */
export async function initDatabase(): Promise<boolean> {
  const databaseUrl = process.env.DATABASE_URL || process.env.FACILITATOR_DATABASE_URL;

  if (!databaseUrl) {
    console.log('[DB] No DATABASE_URL set - using in-memory storage');
    console.log('[DB] ⚠️  Data will be lost on restart. Set DATABASE_URL for production.');
    isInitialized = true;
    return false;
  }

  try {
    pool = new Pool({
      connectionString: databaseUrl,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    // Test connection
    const client = await pool.connect();
    await client.query('SELECT NOW()');
    client.release();

    // Create tables
    await createTables();

    console.log('[DB] ✅ PostgreSQL connected');
    isInitialized = true;
    return true;
  } catch (error) {
    console.error('[DB] Failed to connect to PostgreSQL:', error);
    console.log('[DB] Falling back to in-memory storage');
    pool = null;
    isInitialized = true;
    return false;
  }
}

/**
 * Create database tables if they don't exist
 */
async function createTables(): Promise<void> {
  if (!pool) return;

  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS x402_transactions (
        id VARCHAR(64) PRIMARY KEY,
        nonce VARCHAR(78) NOT NULL,
        payer VARCHAR(42) NOT NULL,
        receiver VARCHAR(42) NOT NULL,
        token_address VARCHAR(42) NOT NULL,
        token_symbol VARCHAR(20) NOT NULL,
        amount VARCHAR(78) NOT NULL,
        fee VARCHAR(78) NOT NULL DEFAULT '0',
        fee_percent DECIMAL(5,2) NOT NULL DEFAULT 0,
        network VARCHAR(50) NOT NULL,
        tx_hash VARCHAR(66),
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        error_reason TEXT,
        protocol VARCHAR(20) NOT NULL DEFAULT 'permit2',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        settled_at TIMESTAMP WITH TIME ZONE,
        UNIQUE(payer, nonce)
      );

      CREATE INDEX IF NOT EXISTS idx_transactions_payer ON x402_transactions(payer);
      CREATE INDEX IF NOT EXISTS idx_transactions_status ON x402_transactions(status);
      CREATE INDEX IF NOT EXISTS idx_transactions_created ON x402_transactions(created_at DESC);

      CREATE TABLE IF NOT EXISTS x402_nonces (
        payer VARCHAR(42) NOT NULL,
        nonce VARCHAR(78) NOT NULL,
        token_address VARCHAR(42) NOT NULL,
        used_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        tx_hash VARCHAR(66) NOT NULL,
        PRIMARY KEY (payer, nonce)
      );

      CREATE TABLE IF NOT EXISTS x402_webhooks (
        id VARCHAR(64) PRIMARY KEY,
        url TEXT NOT NULL,
        secret VARCHAR(64),
        events TEXT[] NOT NULL DEFAULT ARRAY['settlement.success', 'settlement.failed'],
        active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);
    console.log('[DB] Tables created/verified');
  } finally {
    client.release();
  }
}

/**
 * Check if using PostgreSQL or in-memory
 */
export function isUsingPostgres(): boolean {
  return pool !== null;
}

// ============================================================================
// Transaction Operations
// ============================================================================

/**
 * Create a new transaction record
 *
 * IMPORTANT: Returns transaction ID only after successful persistence.
 * Throws on database errors to prevent proceeding without audit trail.
 */
export async function createTransaction(tx: Omit<TransactionRecord, 'id' | 'created_at' | 'settled_at'>): Promise<string> {
  const id = `tx_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  if (pool) {
    try {
      await pool.query(`
        INSERT INTO x402_transactions
          (id, nonce, payer, receiver, token_address, token_symbol, amount, fee, fee_percent, network, tx_hash, status, error_reason, protocol)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      `, [
        id,
        tx.nonce,
        tx.payer.toLowerCase(),
        tx.receiver.toLowerCase(),
        tx.token_address.toLowerCase(),
        tx.token_symbol,
        tx.amount,
        tx.fee,
        tx.fee_percent,
        tx.network,
        tx.tx_hash,
        tx.status,
        tx.error_reason,
        tx.protocol,
      ]);
    } catch (error) {
      console.error('[DB] Failed to create transaction record:', error);
      throw new Error('Database error: Failed to create transaction record');
    }
  } else {
    memoryStore.transactions.set(id, {
      ...tx,
      id,
      payer: tx.payer.toLowerCase(),
      receiver: tx.receiver.toLowerCase(),
      token_address: tx.token_address.toLowerCase(),
      created_at: new Date(),
      settled_at: null,
    });
  }

  return id;
}

/**
 * Update transaction status
 */
export async function updateTransaction(
  id: string,
  updates: Partial<Pick<TransactionRecord, 'status' | 'tx_hash' | 'error_reason' | 'settled_at'>>
): Promise<void> {
  if (pool) {
    const sets: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (updates.status !== undefined) {
      sets.push(`status = $${paramIndex++}`);
      values.push(updates.status);
    }
    if (updates.tx_hash !== undefined) {
      sets.push(`tx_hash = $${paramIndex++}`);
      values.push(updates.tx_hash);
    }
    if (updates.error_reason !== undefined) {
      sets.push(`error_reason = $${paramIndex++}`);
      values.push(updates.error_reason);
    }
    if (updates.settled_at !== undefined) {
      sets.push(`settled_at = $${paramIndex++}`);
      values.push(updates.settled_at);
    }

    if (sets.length > 0) {
      values.push(id);
      await pool.query(
        `UPDATE x402_transactions SET ${sets.join(', ')} WHERE id = $${paramIndex}`,
        values
      );
    }
  } else {
    const tx = memoryStore.transactions.get(id);
    if (tx) {
      Object.assign(tx, updates);
    }
  }
}

/**
 * Get transaction by ID
 */
export async function getTransaction(id: string): Promise<TransactionRecord | null> {
  if (pool) {
    const result = await pool.query('SELECT * FROM x402_transactions WHERE id = $1', [id]);
    return result.rows[0] || null;
  }
  return memoryStore.transactions.get(id) || null;
}

/**
 * Get recent transactions
 */
export async function getRecentTransactions(limit: number = 100): Promise<TransactionRecord[]> {
  if (pool) {
    const result = await pool.query(
      'SELECT * FROM x402_transactions ORDER BY created_at DESC LIMIT $1',
      [limit]
    );
    return result.rows;
  }
  return Array.from(memoryStore.transactions.values())
    .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
    .slice(0, limit);
}

/**
 * Get transaction statistics
 */
export async function getTransactionStats(): Promise<{
  total: number;
  successful: number;
  failed: number;
  pending: number;
  totalVolume: string;
  totalFees: string;
  volumeByToken: Record<string, string>;
}> {
  if (pool) {
    const statsResult = await pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'success') as successful,
        COUNT(*) FILTER (WHERE status = 'failed') as failed,
        COUNT(*) FILTER (WHERE status = 'pending') as pending,
        COALESCE(SUM(CASE WHEN status = 'success' THEN amount::numeric ELSE 0 END), 0)::text as total_volume,
        COALESCE(SUM(CASE WHEN status = 'success' THEN fee::numeric ELSE 0 END), 0)::text as total_fees
      FROM x402_transactions
    `);

    const volumeResult = await pool.query(`
      SELECT token_symbol, SUM(amount::numeric)::text as volume
      FROM x402_transactions WHERE status = 'success'
      GROUP BY token_symbol
    `);

    const volumeByToken: Record<string, string> = {};
    for (const row of volumeResult.rows) {
      volumeByToken[row.token_symbol] = row.volume;
    }

    const stats = statsResult.rows[0];
    return {
      total: parseInt(stats.total),
      successful: parseInt(stats.successful),
      failed: parseInt(stats.failed),
      pending: parseInt(stats.pending),
      totalVolume: stats.total_volume,
      totalFees: stats.total_fees,
      volumeByToken,
    };
  }

  // In-memory stats
  const txs = Array.from(memoryStore.transactions.values());
  const successful = txs.filter(t => t.status === 'success');

  const volumeByToken: Record<string, bigint> = {};
  let totalVolume = 0n;
  let totalFees = 0n;

  for (const tx of successful) {
    totalVolume += BigInt(tx.amount);
    totalFees += BigInt(tx.fee);
    volumeByToken[tx.token_symbol] = (volumeByToken[tx.token_symbol] || 0n) + BigInt(tx.amount);
  }

  return {
    total: txs.length,
    successful: successful.length,
    failed: txs.filter(t => t.status === 'failed').length,
    pending: txs.filter(t => t.status === 'pending').length,
    totalVolume: totalVolume.toString(),
    totalFees: totalFees.toString(),
    volumeByToken: Object.fromEntries(
      Object.entries(volumeByToken).map(([k, v]) => [k, v.toString()])
    ),
  };
}

// ============================================================================
// Nonce Operations
// ============================================================================

/**
 * Check if nonce has been used
 *
 * SECURITY: Fails safe - if database check fails, returns true (assume used)
 * to prevent potential replay attacks during database outages.
 */
export async function isNonceUsed(payer: string, nonce: string): Promise<boolean> {
  const key = `${payer.toLowerCase()}:${nonce}`;

  if (pool) {
    try {
      const result = await pool.query(
        'SELECT 1 FROM x402_nonces WHERE payer = $1 AND nonce = $2',
        [payer.toLowerCase(), nonce]
      );
      return result.rows.length > 0;
    } catch (error) {
      console.error('[DB] Failed to check nonce, failing safe (assuming used):', error);
      // SECURITY: Fail safe - assume nonce is used to prevent replay attacks
      return true;
    }
  }

  return memoryStore.nonces.has(key);
}

/**
 * Mark nonce as used
 *
 * CRITICAL: This must succeed for replay protection.
 * Throws on database errors to alert caller.
 */
export async function markNonceUsed(
  payer: string,
  nonce: string,
  tokenAddress: string,
  txHash: string
): Promise<void> {
  const key = `${payer.toLowerCase()}:${nonce}`;

  if (pool) {
    try {
      await pool.query(`
        INSERT INTO x402_nonces (payer, nonce, token_address, tx_hash)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (payer, nonce) DO NOTHING
      `, [payer.toLowerCase(), nonce, tokenAddress.toLowerCase(), txHash]);
    } catch (error) {
      console.error('[DB] CRITICAL: Failed to mark nonce as used:', error);
      // Still add to memory as backup
      memoryStore.nonces.add(key);
      // Re-throw to alert caller
      throw new Error('Failed to record nonce - replay protection may be compromised');
    }
  }

  // Always add to memory (even when using DB) for fast lookup
  memoryStore.nonces.add(key);
}

// ============================================================================
// Webhook Operations
// ============================================================================

/**
 * Register a webhook
 */
export async function registerWebhook(
  url: string,
  events: string[] = ['settlement.success', 'settlement.failed'],
  secret?: string
): Promise<string> {
  const id = `wh_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  if (pool) {
    await pool.query(`
      INSERT INTO x402_webhooks (id, url, secret, events)
      VALUES ($1, $2, $3, $4)
    `, [id, url, secret || null, events]);
  } else {
    memoryStore.webhooks.set(id, {
      id,
      url,
      secret: secret || null,
      events,
      active: true,
      created_at: new Date(),
    });
  }

  return id;
}

/**
 * Get all active webhooks for an event
 */
export async function getWebhooksForEvent(event: string): Promise<WebhookRecord[]> {
  if (pool) {
    const result = await pool.query(
      'SELECT * FROM x402_webhooks WHERE active = true AND $1 = ANY(events)',
      [event]
    );
    return result.rows;
  }

  return Array.from(memoryStore.webhooks.values())
    .filter(w => w.active && w.events.includes(event));
}

/**
 * Deactivate a webhook
 */
export async function deactivateWebhook(id: string): Promise<void> {
  if (pool) {
    await pool.query('UPDATE x402_webhooks SET active = false WHERE id = $1', [id]);
  } else {
    const webhook = memoryStore.webhooks.get(id);
    if (webhook) {
      webhook.active = false;
    }
  }
}

/**
 * List all webhooks
 */
export async function listWebhooks(): Promise<WebhookRecord[]> {
  if (pool) {
    const result = await pool.query('SELECT * FROM x402_webhooks ORDER BY created_at DESC');
    return result.rows;
  }
  return Array.from(memoryStore.webhooks.values());
}

// ============================================================================
// Cleanup
// ============================================================================

/**
 * Close database connection
 */
export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
