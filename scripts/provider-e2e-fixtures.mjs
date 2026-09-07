import { deflateSync } from "node:zlib"

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, bytes) {
  const kind = Buffer.from(type)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(bytes.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([kind, bytes])))
  return Buffer.concat([length, kind, bytes, checksum])
}
/** A real PNG fixture with four red squares and two blue squares. */
export function imageFixture() {
  const width = 420, height = 180
  const pixels = Buffer.alloc((width * 3 + 1) * height, 255)
  for (let y = 0; y < height; y++) {
    pixels[y * (width * 3 + 1)] = 0
    for (let x = 0; x < width; x++) {
      const column = Math.floor(x / 70)
      const square = x % 70 >= 15 && x % 70 < 55 && y >= 65 && y < 105
      if (!square) continue
      const offset = y * (width * 3 + 1) + 1 + x * 3
      const red = column < 4
      pixels[offset] = red ? 220 : 20
      pixels[offset + 1] = 30
      pixels[offset + 2] = red ? 30 : 230
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4)
  header[8] = 8; header[9] = 2
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))])
}
