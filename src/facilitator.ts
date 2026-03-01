/**
 * Silverback x402 Facilitator — SDK-based EVM + SVM settlement
 *
 * Uses @x402/core, @x402/evm, @x402/svm for full protocol compliance:
 * - ERC-3009 (Base USDC) — automatic
 * - Permit2 (alt tokens when proxy deploys) — automatic
 * - EIP-6492 smart wallet support — automatic
 * - v1 + v2 payload formats — automatic
 */

import { x402Facilitator } from '@x402/core/facilitator';
import { ExactEvmScheme } from '@x402/evm/exact/facilitator';
import { toFacilitatorEvmSigner } from '@x402/evm';
import { createPublicClient, createWalletClient, http, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

// SKALE Base Hub — zero gas, ~1s finality
const skaleBase = defineChain({
  id: 1187947933,
  name: 'SKALE Base Hub',
  nativeCurrency: { name: 'sFUEL', symbol: 'sFUEL', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://skale-base.skalenodes.com/v1/base'] },
  },
  blockExplorers: {
    default: { name: 'Explorer', url: 'https://skale-base-explorer.skalenodes.com' },
  },
});

const SKALE_BASE_CAIP2 = 'eip155:1187947933';

let facilitator: x402Facilitator | null = null;
let evmAddress = '';
let svmAddress = '';
let skaleEnabled = false;

/**
 * Initialize the EVM facilitator (Base mainnet).
 */
export function initializeEvm(privateKey: string, rpcUrl?: string): void {
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  evmAddress = account.address;

  const transport = http(rpcUrl);

  const publicClient = createPublicClient({ chain: base, transport });
  const walletClient = createWalletClient({ account, chain: base, transport });

  const combined = {
    address: account.address,
    readContract: (args: any) => publicClient.readContract(args),
    verifyTypedData: (args: any) => publicClient.verifyTypedData(args),
    writeContract: (args: any) => walletClient.writeContract(args),
    sendTransaction: (args: any) => walletClient.sendTransaction(args),
    waitForTransactionReceipt: (args: any) => publicClient.waitForTransactionReceipt(args),
    getCode: (args: any) => publicClient.getCode(args),
  };

  const signer = toFacilitatorEvmSigner(combined as any);
  const scheme = new ExactEvmScheme(signer);

  if (!facilitator) {
    facilitator = new x402Facilitator();
  }
  facilitator.register('eip155:8453', scheme);

  console.log(`[facilitator] EVM initialized — ${evmAddress}`);
}

/**
 * Initialize the SKALE Base facilitator.
 * Uses the same private key as Base EVM — zero gas, no funding needed.
 */
export function initializeSkale(privateKey: string): void {
  try {
    const account = privateKeyToAccount(privateKey as `0x${string}`);
    const transport = http(skaleBase.rpcUrls.default.http[0]);

    const publicClient = createPublicClient({ chain: skaleBase, transport });
    const walletClient = createWalletClient({ account, chain: skaleBase, transport });

    const combined = {
      address: account.address,
      readContract: (args: any) => publicClient.readContract(args),
      verifyTypedData: (args: any) => publicClient.verifyTypedData(args),
      writeContract: (args: any) => walletClient.writeContract(args),
      sendTransaction: (args: any) => walletClient.sendTransaction(args),
      waitForTransactionReceipt: (args: any) => publicClient.waitForTransactionReceipt(args),
      getCode: (args: any) => publicClient.getCode(args),
    };

    const signer = toFacilitatorEvmSigner(combined as any);
    const scheme = new ExactEvmScheme(signer);

    if (!facilitator) {
      facilitator = new x402Facilitator();
    }
    facilitator.register(SKALE_BASE_CAIP2, scheme);
    skaleEnabled = true;

    console.log(`[facilitator] SKALE Base initialized — ${account.address} (zero gas)`);
  } catch (err) {
    console.warn('[facilitator] SKALE init failed:', err instanceof Error ? err.message : err);
  }
}

/**
 * Initialize the Solana facilitator (mainnet).
 * Key format: base58-encoded private key or JSON byte array.
 */
export async function initializeSvm(privateKeyInput: string): Promise<void> {
  try {
    const { ExactSvmScheme } = await import('@x402/svm/exact/facilitator');
    const { toFacilitatorSvmSigner, SOLANA_MAINNET_CAIP2 } = await import('@x402/svm');
    const { createKeyPairSignerFromBytes } = await import('@solana/kit');

    // Decode private key — support JSON byte array or base58
    let keyBytes: Uint8Array;
    if (privateKeyInput.startsWith('[')) {
      keyBytes = new Uint8Array(JSON.parse(privateKeyInput));
    } else {
      const { getBase58Codec } = await import('@solana/kit');
      const codec = getBase58Codec();
      const encoded = codec.encode(privateKeyInput);
      keyBytes = new Uint8Array(encoded.length);
      keyBytes.set(encoded);
    }

    const keypair = await createKeyPairSignerFromBytes(keyBytes as any);
    svmAddress = keypair.address;

    const rawSvmSigner = toFacilitatorSvmSigner(keypair);

    // Wrap signer with diagnostic logging to capture exact Solana errors
    const svmSigner = {
      ...rawSvmSigner,
      signTransaction: async (transaction: string, feePayer: string, network: string) => {
        console.log(`[SVM] signTransaction: feePayer=${feePayer}, network=${network}, txLen=${transaction.length}`);
        try {
          const result = await rawSvmSigner.signTransaction(transaction, feePayer, network);
          console.log(`[SVM] signTransaction: SUCCESS (resultLen=${result.length})`);
          return result;
        } catch (err: any) {
          console.error(`[SVM] signTransaction FAILED:`, err.message || err);
          throw err;
        }
      },
      simulateTransaction: async (transaction: string, network: string) => {
        console.log(`[SVM] simulateTransaction: network=${network}, txLen=${transaction.length}`);
        try {
          await rawSvmSigner.simulateTransaction(transaction, network);
          console.log(`[SVM] simulateTransaction: SUCCESS`);
        } catch (err: any) {
          console.error(`[SVM] ❌ simulateTransaction FAILED:`, err.message || err);
          throw err;
        }
      },
    };

    const svmScheme = new ExactSvmScheme(svmSigner);

    if (!facilitator) {
      facilitator = new x402Facilitator();
    }
    facilitator.register(SOLANA_MAINNET_CAIP2, svmScheme);

    console.log(`[facilitator] Solana initialized — ${svmAddress}`);
  } catch (err) {
    console.warn('[facilitator] Solana init failed:', err instanceof Error ? err.message : err);
  }
}

/** Get the x402Facilitator instance (throws if not initialized) */
export function getFacilitator(): x402Facilitator {
  if (!facilitator) throw new Error('Facilitator not initialized');
  return facilitator;
}

/** Check readiness */
export function isReady(): boolean {
  return facilitator !== null;
}

/** Get facilitator wallet addresses */
export function getAddresses() {
  return { evm: evmAddress, svm: svmAddress, skale: skaleEnabled ? evmAddress : '' };
}
