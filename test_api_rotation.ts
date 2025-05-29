#!/usr/bin/env deno run -A

import { apiKeyManager } from "./config.ts";

console.log("Testing API Key Rotation System");
console.log("================================");

// Test initial state
console.log(`\n1. Initial state:`);
console.log(`   Total keys: ${apiKeyManager.getTotalKeys()}`);
console.log(`   Current key: ${apiKeyManager.getCurrentKey().substring(0, 20)}...`);
console.log(`   All keys exhausted: ${apiKeyManager.areAllKeysExhausted()}`);

// Test rotation through all keys
console.log(`\n2. Testing rotation through all keys:`);
for (let i = 0; i < apiKeyManager.getTotalKeys(); i++) {
    const currentKey = apiKeyManager.getCurrentKey();
    console.log(`   Key ${i + 1}: ${currentKey.substring(0, 20)}...`);
    
    if (i < apiKeyManager.getTotalKeys() - 1) {
        const rotated = apiKeyManager.rotateToNextKey();
        console.log(`   Rotation successful: ${rotated}`);
    }
}

// Test exhaustion
console.log(`\n3. Testing exhaustion (one more rotation):`);
const rotated = apiKeyManager.rotateToNextKey();
console.log(`   Rotation successful: ${rotated}`);
console.log(`   All keys exhausted: ${apiKeyManager.areAllKeysExhausted()}`);

// Test reset
console.log(`\n4. Testing reset:`);
apiKeyManager.resetRotation();
console.log(`   Current key after reset: ${apiKeyManager.getCurrentKey().substring(0, 20)}...`);
console.log(`   All keys exhausted: ${apiKeyManager.areAllKeysExhausted()}`);

console.log(`\n✅ API Key Rotation System Test Complete!`);
