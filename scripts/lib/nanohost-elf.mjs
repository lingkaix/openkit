/** Projects the NanoHost distribution owner's two targets and upstream Gateway archive names. */
export const NANOHOST_TARGETS = Object.freeze({
  'linux/amd64': Object.freeze({
    architecture: 'amd64',
    machine: 62,
    elfName: 'x86-64',
    gatewayArchive: 'openshell-gateway-x86_64-unknown-linux-gnu.tar.gz',
  }),
  'linux/arm64': Object.freeze({
    architecture: 'arm64',
    machine: 183,
    elfName: 'AArch64',
    gatewayArchive: 'openshell-gateway-aarch64-unknown-linux-gnu.tar.gz',
  }),
});

/** Rejects anything except the selected target's loadable little-endian ELF64 executable. */
export function assertNanoHostElf(bytes, target, label) {
  const platform = Object.hasOwn(NANOHOST_TARGETS, target) ? NANOHOST_TARGETS[target] : undefined;
  if (!platform) throw new Error(`Unsupported NanoHost target: ${target}`);
  if (
    bytes.length < 64 ||
    !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
    bytes[4] !== 2 ||
    bytes[5] !== 1 ||
    bytes[6] !== 1 ||
    ![2, 3].includes(bytes.readUInt16LE(16)) ||
    bytes.readUInt16LE(18) !== platform.machine ||
    bytes.readUInt32LE(20) !== 1 ||
    bytes.readUInt16LE(52) !== 64 ||
    !hasExecutableLoadSegment(bytes)
  ) {
    throw new Error(
      `${label} must be a loadable ELF64 ${platform.elfName} ET_EXEC or ET_DYN executable.`
    );
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

/** Derives loader and GNU libc symbol needs from the exact executable's ELF dynamic table. */
export function elfLibcRequirements(bytes) {
  const checkedOffset = (value, size = 1) => {
    const offset = Number(value);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + size > bytes.length) {
      throw new Error('NanoHost ELF dependency table is out of bounds.');
    }
    return offset;
  };
  const stringAt = (offset, limit) => {
    const end = bytes.indexOf(0, offset);
    if (end < offset || end >= limit) throw new Error('NanoHost ELF dependency string is invalid.');
    return bytes.subarray(offset, end).toString('utf8');
  };
  const table = checkedOffset(bytes.readBigUInt64LE(32));
  const segments = [];
  let interpreter = null;
  let dynamic;
  for (let index = 0; index < bytes.readUInt16LE(56); index += 1) {
    const row = checkedOffset(table + index * 56, 56);
    const type = bytes.readUInt32LE(row);
    const offset = checkedOffset(
      bytes.readBigUInt64LE(row + 8),
      Number(bytes.readBigUInt64LE(row + 32))
    );
    const size = Number(bytes.readBigUInt64LE(row + 32));
    if (type === 1) segments.push({ offset, size, address: bytes.readBigUInt64LE(row + 16) });
    if (type === 2) dynamic = { offset, size };
    if (type === 3) interpreter = stringAt(offset, offset + size);
  }
  if (!dynamic) return { interpreter, symbols: [], maximumGlibc: null };
  const tags = new Map();
  for (let row = dynamic.offset; row + 16 <= dynamic.offset + dynamic.size; row += 16) {
    const tag = bytes.readBigUInt64LE(row);
    if (tag === 0n) break;
    tags.set(tag, bytes.readBigUInt64LE(row + 8));
  }
  const fileOffset = (address, size) => {
    const segment = segments.find(
      (item) =>
        address >= item.address && address + BigInt(size) <= item.address + BigInt(item.size)
    );
    if (!segment) throw new Error('NanoHost ELF dependency address is not file-backed.');
    return checkedOffset(BigInt(segment.offset) + address - segment.address, size);
  };
  if (!tags.has(0x6ffffffen)) return { interpreter, symbols: [], maximumGlibc: null };
  if (!tags.has(5n) || !tags.has(10n) || !tags.has(0x6fffffffn))
    throw new Error('NanoHost ELF version needs are incomplete.');
  const strings = fileOffset(tags.get(5n), Number(tags.get(10n)));
  const stringEnd = strings + Number(tags.get(10n));
  const count = Number(tags.get(0x6fffffffn));
  if (count > 1024) throw new Error('NanoHost ELF version needs exceed the bound.');
  let row = fileOffset(tags.get(0x6ffffffen), 16);
  const symbols = new Set();
  for (let index = 0; index < count; index += 1) {
    checkedOffset(row, 16);
    if (bytes.readUInt16LE(row) !== 1)
      throw new Error('NanoHost ELF version needs schema is unknown.');
    const auxCount = bytes.readUInt16LE(row + 2);
    if (auxCount > 4096) throw new Error('NanoHost ELF symbol needs exceed the bound.');
    let aux = row + bytes.readUInt32LE(row + 8);
    for (let n = 0; n < auxCount; n += 1) {
      checkedOffset(aux, 16);
      const name = stringAt(checkedOffset(strings + bytes.readUInt32LE(aux + 8)), stringEnd);
      if (name.startsWith('GLIBC_')) symbols.add(name);
      const next = bytes.readUInt32LE(aux + 12);
      if (n + 1 < auxCount && next < 16)
        throw new Error('NanoHost ELF symbol needs chain is invalid.');
      aux += next;
    }
    const next = bytes.readUInt32LE(row + 12);
    if (index + 1 < count && next < 16)
      throw new Error('NanoHost ELF version needs chain is invalid.');
    row += next;
  }
  const versions = [...symbols].filter((name) => /^GLIBC_\d+(?:\.\d+)+$/.test(name));
  versions.sort((a, b) => {
    const left = a.slice(6).split('.').map(Number);
    const right = b.slice(6).split('.').map(Number);
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      const difference = (left[index] ?? 0) - (right[index] ?? 0);
      if (difference) return difference;
    }
    return 0;
  });
  return {
    interpreter,
    symbols: [...symbols].sort(),
    maximumGlibc: versions.at(-1)?.slice(6) ?? null,
  };
}
