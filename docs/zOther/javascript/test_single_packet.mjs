// Test single packet decoding against RX filter
// Run with: node test_single_packet.js

const crypto = require('crypto');
const aesjs = require('aes-js');

// Configuration
const CHANNEL_NAME = '#wardriving';
const MAX_RX_PATH_LENGTH = 9;
const CHANNEL_GROUP_TEXT_HEADER = 0x15;  // GRP_TXT (FLOOD)
const ADVERT_HEADER = 0x11;              // ADVERT (FLOOD)
const GROUP_DATA_HEADER = 0x19;          // GRP_DATA (FLOOD)
const TRACE_HEADER = 0x25;               // TRACE (FLOOD)
const RX_PRINTABLE_THRESHOLD = 0.80;

// Test packets - uncomment the one you want to test
// GRP_TXT packet (current working example)
const TEST_PACKET_HEX = '15014E81ADF6994196D67F3F3286F4525F0E81C5D522D79FF9216519D973F80CE73CB4685CBFDE96700FCE9FE98E58C26C003A1414437B05D40949711DAF8488436FA5511B18';
// ADVERT packet example (would need real data)
// const TEST_PACKET_HEX = '11...';
// GRP_DATA packet example (would need real data)
// const TEST_PACKET_HEX = '19...';
// TRACE packet example (would need real data)
// const TEST_PACKET_HEX = '25...';

const TEST_PACKET = Buffer.from(TEST_PACKET_HEX.replace(/\s+/g, ''), 'hex');

console.log('========== RX PACKET FILTER TEST ==========');
console.log(`Testing packet: ${TEST_PACKET_HEX}`);
console.log(`Packet length: ${TEST_PACKET.length} bytes\n`);

// Derive channel key
async function deriveChannelKey(channelName) {
  const normalizedName = channelName.toLowerCase();
  const data = Buffer.from(normalizedName, 'utf-8');
  
  // Hash using SHA-256 (matching wardrive.js implementation)
  const hash = crypto.createHash('sha256').update(data).digest();
  
  // Take first 16 bytes
  return hash.slice(0, 16);
}

// Compute channel hash
async function computeChannelHash(channelSecret) {
  const hash = crypto.createHash('sha256').update(channelSecret).digest();
  return hash[0];
}

// Get printable ratio
function getPrintableRatio(str) {
  if (str.length === 0) return 0;
  let printableCount = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if ((code >= 32 && code <= 126) || code === 9 || code === 10 || code === 13) {
      printableCount++;
    }
  }
  return printableCount / str.length;
}

// Check if string contains only strict ASCII characters (32-126)
function isStrictAscii(str) {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 32 || code > 126) {
      return false;
    }
  }
  return true;
}

// Parse ADVERT packet name
function parseAdvertName(payload) {
  try {
    // ADVERT structure: [32 bytes pubkey][4 bytes timestamp][64 bytes signature][1 byte flags][name...]
    const PUBKEY_SIZE = 32;
    const TIMESTAMP_SIZE = 4;
    const SIGNATURE_SIZE = 64;
    const FLAGS_SIZE = 1;
    const NAME_OFFSET = PUBKEY_SIZE + TIMESTAMP_SIZE + SIGNATURE_SIZE + FLAGS_SIZE;
    
    if (payload.length <= NAME_OFFSET) {
      return { valid: false, name: '', reason: 'payload too short for name' };
    }
    
    const nameBytes = payload.slice(NAME_OFFSET);
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const name = decoder.decode(nameBytes).replace(/\0+$/, '').trim();
    
    console.log(`  ADVERT name extracted: "${name}" (${name.length} chars)`);
    
    if (name.length === 0) {
      return { valid: false, name: '', reason: 'name empty' };
    }
    
    // Check if name is printable
    const printableRatio = getPrintableRatio(name);
    console.log(`  ADVERT name printable ratio: ${(printableRatio * 100).toFixed(1)}%`);
    
    if (printableRatio < 0.9) {
      return { valid: false, name: name, reason: 'name not printable' };
    }
    
    // Check strict ASCII (no extended characters)
    if (!isStrictAscii(name)) {
      return { valid: false, name: name, reason: 'name contains non-ASCII chars' };
    }
    
    return { valid: true, name: name, reason: 'kept' };
    
  } catch (error) {
    console.error(`  Error parsing ADVERT name: ${error.message}`);
    return { valid: false, name: '', reason: 'parse error' };
  }
}

// Decrypt GRP_TXT payload
function decryptGroupTextPayload(payload, channelKey) {
  try {
    if (payload.length < 3) {
      console.log('  ❌ Payload too short for decryption');
      return null;
    }
    
    const channelHash = payload[0];
    const cipherMAC = payload.slice(1, 3);
    const encryptedData = payload.slice(3);
    
    console.log(`  Channel hash: 0x${channelHash.toString(16).padStart(2, '0')}`);
    console.log(`  Cipher MAC: ${cipherMAC.toString('hex')}`);
    console.log(`  Encrypted data: ${encryptedData.length} bytes`);
    
    if (encryptedData.length === 0) {
      console.log('  ❌ No encrypted data');
      return null;
    }
    
    // AES-ECB decryption
    const aesCbc = new aesjs.ModeOfOperation.ecb(Array.from(channelKey));
    const blockSize = 16;
    
    // Calculate how many full blocks we have
    const numBlocks = Math.floor(encryptedData.length / blockSize);
    const decryptedBytes = Buffer.alloc(numBlocks * blockSize);
    
    for (let i = 0; i < numBlocks; i++) {
      const blockStart = i * blockSize;
      const block = Array.from(encryptedData.slice(blockStart, blockStart + blockSize));
      const decryptedBlock = aesCbc.decrypt(block);
      decryptedBytes.set(decryptedBlock, blockStart);
    }
    
    console.log(`  Decrypted bytes (hex): ${decryptedBytes.slice(0, 32).toString('hex')}...`);
    
    // Parse: [4 bytes timestamp][1 byte flags][message]
    if (decryptedBytes.length < 5) {
      console.log('  ❌ Decrypted data too short');
      return null;
    }
    
    const timestamp = decryptedBytes.readUInt32LE(0);
    const flags = decryptedBytes[4];
    const messageBytes = decryptedBytes.slice(5);
    
    // Find null terminator
    let endIdx = messageBytes.indexOf(0);
    if (endIdx === -1) endIdx = messageBytes.length;
    
    const messageText = messageBytes.slice(0, endIdx).toString('utf-8').trim();
    
    console.log(`  Timestamp: ${timestamp} (${new Date(timestamp * 1000).toISOString()})`);
    console.log(`  Flags: 0x${flags.toString(16).padStart(2, '0')}`);
    console.log(`  Message: "${messageText}"`);
    
    return messageText;
    
  } catch (error) {
    console.log(`  ❌ Decryption error: ${error.message}`);
    return null;
  }
}

// Validate GRP_TXT packet
async function validateGrpTxtPacket(metadata) {
  console.log('Step 4: Derive channel key and hash');
  console.log('─────────────────────────────────');
  const channelKey = await deriveChannelKey(CHANNEL_NAME);
  const channelHash = await computeChannelHash(channelKey);
  
  console.log(`Channel: ${CHANNEL_NAME}`);
  console.log(`Derived key: ${channelKey.toString('hex')}`);
  console.log(`Computed hash: 0x${channelHash.toString(16).padStart(2, '0')}\n`);
  
  console.log('Step 5: Validate channel hash');
  console.log('─────────────────────────────────');
  const packetChannelHash = metadata.encryptedPayload[0];
  console.log(`Packet channel hash: 0x${packetChannelHash.toString(16).padStart(2, '0')}`);
  console.log(`Expected hash: 0x${channelHash.toString(16).padStart(2, '0')}`);
  
  if (packetChannelHash !== channelHash) {
    console.log(`❌ DROPPED: unknown channel hash`);
    return;
  }
  console.log(`✓ Channel hash matches!\n`);
  
  console.log('Step 6: Decrypt message');
  console.log('─────────────────────────────────');
  const plaintext = decryptGroupTextPayload(metadata.encryptedPayload, channelKey);
  
  if (!plaintext) {
    console.log(`❌ DROPPED: decrypt failed`);
    return;
  }
  console.log(`✓ Decryption successful\n`);
  
  console.log('Step 7: Validate printable ratio');
  console.log('─────────────────────────────────');
  const printableRatio = getPrintableRatio(plaintext);
  console.log(`Printable ratio: ${(printableRatio * 100).toFixed(1)}%`);
  console.log(`Threshold: ${(RX_PRINTABLE_THRESHOLD * 100).toFixed(1)}%`);
  
  if (printableRatio < RX_PRINTABLE_THRESHOLD) {
    console.log(`❌ DROPPED: plaintext not printable`);
    return;
  }
  console.log(`✓ Printable ratio OK\n`);
  
  console.log('═══════════════════════════════════════');
  console.log('✅ GRP_TXT PACKET PASSED ALL VALIDATIONS!');
  console.log('═══════════════════════════════════════');
  console.log(`\nFinal decrypted message: "${plaintext}"`);
}

// Validate ADVERT packet
function validateAdvertPacket(metadata) {
  console.log('Step 4: Parse ADVERT name');
  console.log('─────────────────────────────────');
  const nameResult = parseAdvertName(metadata.encryptedPayload);
  
  if (!nameResult.valid) {
    console.log(`❌ DROPPED: ${nameResult.reason}`);
    return;
  }
  
  console.log('═══════════════════════════════════════');
  console.log('✅ ADVERT PACKET PASSED ALL VALIDATIONS!');
  console.log('═══════════════════════════════════════');
  console.log(`\nNode name: "${nameResult.name}"`);
}

// Validate GRP_DATA packet (placeholder - would need real implementation)
function validateGrpDataPacket(metadata) {
  console.log('Step 4: Validate GRP_DATA');
  console.log('─────────────────────────────────');
  console.log('⚠️  GRP_DATA validation not fully implemented yet');
  console.log('   This would validate channel hash and decrypt structured data');
  console.log('   (Similar to GRP_TXT but for binary data instead of text)');
  
  // For now, just check minimum payload length
  if (metadata.encryptedPayload.length < 3) {
    console.log(`❌ DROPPED: GRP_DATA payload too short (${metadata.encryptedPayload.length} bytes)`);
    return;
  }
  
  console.log(`✓ Minimum payload length OK (${metadata.encryptedPayload.length} bytes)`);
  console.log('═══════════════════════════════════════');
  console.log('✅ GRP_DATA PACKET PASSED BASIC VALIDATION!');
  console.log('═══════════════════════════════════════');
}

// Validate TRACE packet (placeholder - would need real implementation)
function validateTracePacket(metadata) {
  console.log('Step 4: Validate TRACE');
  console.log('─────────────────────────────────');
  console.log('⚠️  TRACE validation not fully implemented yet');
  console.log('   This would parse SNR data for each hop in the path');
  console.log('   Very valuable for coverage mapping!');
  
  // For now, just check minimum payload length
  if (metadata.encryptedPayload.length < 1) {
    console.log(`❌ DROPPED: TRACE payload too short (${metadata.encryptedPayload.length} bytes)`);
    return;
  }
  
  console.log(`✓ Minimum payload length OK (${metadata.encryptedPayload.length} bytes)`);
  console.log('═══════════════════════════════════════');
  console.log('✅ TRACE PACKET PASSED BASIC VALIDATION!');
  console.log('═══════════════════════════════════════');
}

// Parse packet metadata
function parseRxPacketMetadata(raw) {
  const header = raw[0];
  const routeType = header & 0x03;
  
  // For FLOOD (0x01), path length is in byte 1
  // For DIRECT (0x02), path length is in byte 2
  let pathLengthOffset = 1;
  if (routeType === 0x02) {
    pathLengthOffset = 2;
  }
  
  const pathLength = raw[pathLengthOffset];
  
  const pathStartOffset = pathLengthOffset + 1;
  const pathBytes = raw.slice(pathStartOffset, pathStartOffset + pathLength);
  
  const firstHop = pathLength > 0 ? pathBytes[0] : null;
  const lastHop = pathLength > 0 ? pathBytes[pathLength - 1] : null;
  
  const encryptedPayload = raw.slice(pathStartOffset + pathLength);
  
  return {
    raw: raw,
    header: header,
    routeType: routeType,
    pathLength: pathLength,
    pathBytes: pathBytes,
    firstHop: firstHop,
    lastHop: lastHop,
    encryptedPayload: encryptedPayload
  };
}

// Main test
async function testPacket() {
  try {
    console.log('Step 1: Parse packet metadata');
    console.log('─────────────────────────────────');
    const metadata = parseRxPacketMetadata(TEST_PACKET);
    
    console.log(`Header: 0x${metadata.header.toString(16).padStart(2, '0')}`);
    console.log(`Route type: ${metadata.routeType} (${metadata.routeType === 1 ? 'FLOOD' : 'OTHER'})`);
    console.log(`Path length: ${metadata.pathLength} bytes`);
    console.log(`Path: ${Array.from(metadata.pathBytes).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
    console.log(`First hop: 0x${metadata.firstHop?.toString(16).padStart(2, '0')}`);
    console.log(`Last hop: 0x${metadata.lastHop?.toString(16).padStart(2, '0')}`);
    console.log(`Encrypted payload: ${metadata.encryptedPayload.length} bytes\n`);
    
    console.log('Step 2: Validate path length');
    console.log('─────────────────────────────────');
    if (metadata.pathLength > MAX_RX_PATH_LENGTH) {
      console.log(`❌ DROPPED: pathLen>${MAX_RX_PATH_LENGTH} (${metadata.pathLength} hops)`);
      return;
    }
    console.log(`✓ Path length OK (${metadata.pathLength} ≤ ${MAX_RX_PATH_LENGTH})\n`);
    
    console.log('Step 3: Validate packet type');
    console.log('─────────────────────────────────');
    
    // Handle different packet types
    if (metadata.header === CHANNEL_GROUP_TEXT_HEADER) {
      console.log(`✓ Packet type: GRP_TXT (0x15)\n`);
      await validateGrpTxtPacket(metadata);
      
    } else if (metadata.header === ADVERT_HEADER) {
      console.log(`✓ Packet type: ADVERT (0x11)\n`);
      validateAdvertPacket(metadata);
      
    } else if (metadata.header === GROUP_DATA_HEADER) {
      console.log(`✓ Packet type: GRP_DATA (0x19)\n`);
      validateGrpDataPacket(metadata);
      
    } else if (metadata.header === TRACE_HEADER) {
      console.log(`✓ Packet type: TRACE (0x25)\n`);
      validateTracePacket(metadata);
      
    } else {
      console.log(`❌ DROPPED: unsupported ptype (header=0x${metadata.header.toString(16).padStart(2, '0')})`);
      return;
    }
    
  } catch (error) {
    console.error('❌ Test error:', error.message);
    console.error(error.stack);
  }
}
    
    console.log('Step 4: Derive channel key and hash');
    console.log('─────────────────────────────────');
    const channelKey = await deriveChannelKey(CHANNEL_NAME);
    const channelHash = await computeChannelHash(channelKey);
    
    console.log(`Channel: ${CHANNEL_NAME}`);
    console.log(`Derived key: ${channelKey.toString('hex')}`);
    console.log(`Computed hash: 0x${channelHash.toString(16).padStart(2, '0')}\n`);
    
    console.log('Step 5: Validate channel hash');
    console.log('─────────────────────────────────');
    const packetChannelHash = metadata.encryptedPayload[0];
    console.log(`Packet channel hash: 0x${packetChannelHash.toString(16).padStart(2, '0')}`);
    console.log(`Expected hash: 0x${channelHash.toString(16).padStart(2, '0')}`);
    
    if (packetChannelHash !== channelHash) {
      console.log(`❌ DROPPED: unknown channel hash`);
      return;
    }
    console.log(`✓ Channel hash matches!\n`);
    
    console.log('Step 6: Decrypt message');
    console.log('─────────────────────────────────');
    const plaintext = decryptGroupTextPayload(metadata.encryptedPayload, channelKey);
    
    if (!plaintext) {
      console.log(`❌ DROPPED: decrypt failed`);
      return;
    }
    console.log(`✓ Decryption successful\n`);
    
    console.log('Step 7: Validate printable ratio');
    console.log('─────────────────────────────────');
    const printableRatio = getPrintableRatio(plaintext);
    console.log(`Printable ratio: ${(printableRatio * 100).toFixed(1)}%`);
    console.log(`Threshold: ${(RX_PRINTABLE_THRESHOLD * 100).toFixed(1)}%`);
    
    if (printableRatio < RX_PRINTABLE_THRESHOLD) {
      console.log(`❌ DROPPED: plaintext not printable`);
      return;
    }
    console.log(`✓ Printable ratio OK\n`);
    
    console.log('═══════════════════════════════════════');
    console.log('✅ PACKET PASSED ALL VALIDATIONS!');
    console.log('═══════════════════════════════════════');
    console.log(`\nFinal decrypted message: "${plaintext}"`);
    
  } catch (error) {
    console.error('❌ Test error:', error.message);
    console.error(error.stack);
  }
}

(async () => {
  await testPacket();
})();
