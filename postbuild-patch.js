/**
 * Postbuild patch for @x402/svm bundled in dist/index.js
 *
 * Fixes two issues with Phantom Lighthouse instruction injection:
 *
 * 1. Instruction count limit: 6 → 10 (Phantom adds 3 Lighthouse = 7 total)
 * 2. TransferChecked lookup: hardcoded instructions[2] → dynamic scan
 *    (Phantom inserts Lighthouse at indices 2-3, pushing Transfer to 4+)
 */

const fs = require('fs');
const BUNDLE = 'dist/index.js';

let code = fs.readFileSync(BUNDLE, 'utf8');
let patches = 0;

// Patch 1: Instruction count limit 6 → 10
const countBefore = code.split('instructions.length > 6').length - 1;
code = code.replace(/instructions\.length > 6/g, 'instructions.length > 10');
if (countBefore > 0) {
  patches += countBefore;
  console.log(`  [patch] instruction limit 6→10 (${countBefore} occurrences)`);
}

// Patch 2: TransferChecked lookup — find by program address instead of hardcoded [2]
// Original:   const transferIx = instructions[2];
// Patched:    Find first instruction whose programAddress is Token or Token-2022
//
// Also patch: const optionalInstructions = instructions.slice(3);
// To:         Skip indices 0,1 (compute budget) and the transfer instruction

const transferPattern = /const transferIx = instructions\[2\];/g;
const transferCount = code.split('const transferIx = instructions[2];').length - 1;
code = code.replace(
  transferPattern,
  `const _transferIdx = instructions.findIndex(ix => { const pa = ix.programAddress.toString(); return pa === TOKEN_PROGRAM_ADDRESS.toString() || pa === TOKEN_2022_PROGRAM_ADDRESS.toString(); }); const transferIx = _transferIdx >= 0 ? instructions[_transferIdx] : instructions[2];`
);
if (transferCount > 0) {
  patches += transferCount;
  console.log(`  [patch] transferIx lookup → dynamic scan (${transferCount} occurrences)`);
}

// Patch 3: Optional instructions slice — exclude compute budget + transfer
// Original:   const optionalInstructions = instructions.slice(3);
// Patched:    filter out indices 0, 1, and the transfer index
const slicePattern = /const optionalInstructions = instructions\.slice\(3\);/g;
const sliceCount = code.split('const optionalInstructions = instructions.slice(3);').length - 1;
code = code.replace(
  slicePattern,
  `const optionalInstructions = instructions.filter((_, i) => i !== 0 && i !== 1 && i !== _transferIdx);`
);
if (sliceCount > 0) {
  patches += sliceCount;
  console.log(`  [patch] optionalInstructions → filter-based (${sliceCount} occurrences)`);
}

fs.writeFileSync(BUNDLE, code);
console.log(`[postbuild] Applied ${patches} patches to ${BUNDLE}`);
