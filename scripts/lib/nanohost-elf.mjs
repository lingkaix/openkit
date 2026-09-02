/** Rejects anything except a loadable little-endian ELF64 AArch64 executable. */
export function assertAarch64Elf(bytes, label) {
  if (
    bytes.length < 64 ||
    !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
    bytes[4] !== 2 ||
    bytes[5] !== 1 ||
    bytes[6] !== 1 ||
    ![2, 3].includes(bytes.readUInt16LE(16)) ||
    bytes.readUInt16LE(18) !== 183 ||
    bytes.readUInt32LE(20) !== 1 ||
    bytes.readUInt16LE(52) !== 64 ||
    !hasExecutableLoadSegment(bytes)
  ) {
    throw new Error(`${label} must be a loadable ELF64 AArch64 ET_EXEC or ET_DYN executable.`);
  }
}

/** Returns whether the bounded ELF64 program table has an executable file-backed load segment. */
function hasExecutableLoadSegment(bytes) {
  const signedAddressLimit = 1n << 63n;
  const segmentValueLimit = 1n << 32n;
  const entry = bytes.readBigUInt64LE(24);
  const tableOffset = bytes.readBigUInt64LE(32);
  const entrySize = bytes.readUInt16LE(54);
  const entryCount = bytes.readUInt16LE(56);
  const tableEnd = tableOffset + BigInt(entrySize) * BigInt(entryCount);
  if (
    tableOffset < 64n ||
    entrySize !== 56 ||
    entryCount === 0 ||
    tableEnd > BigInt(bytes.length)
  ) {
    return false;
  }
  for (let index = 0; index < entryCount; index += 1) {
    const offset = Number(tableOffset) + index * entrySize;
    const type = bytes.readUInt32LE(offset);
    const flags = bytes.readUInt32LE(offset + 4);
    const fileOffset = bytes.readBigUInt64LE(offset + 8);
    const virtualAddress = bytes.readBigUInt64LE(offset + 16);
    const fileSize = bytes.readBigUInt64LE(offset + 32);
    const memorySize = bytes.readBigUInt64LE(offset + 40);
    const alignment = bytes.readBigUInt64LE(offset + 48);
    const aligned =
      alignment <= 1n ||
      ((alignment & (alignment - 1n)) === 0n &&
        fileOffset % alignment === virtualAddress % alignment);
    if (
      type === 1 &&
      (flags & 1) === 1 &&
      virtualAddress < signedAddressLimit &&
      entry < signedAddressLimit &&
      fileOffset < segmentValueLimit &&
      fileSize < segmentValueLimit &&
      memorySize < segmentValueLimit &&
      alignment < segmentValueLimit &&
      fileSize > 0n &&
      memorySize >= fileSize &&
      fileOffset + fileSize <= BigInt(bytes.length) &&
      virtualAddress + memorySize <= signedAddressLimit &&
      entry >= virtualAddress &&
      entry < virtualAddress + fileSize &&
      aligned
    ) {
      return true;
    }
  }
  return false;
}
