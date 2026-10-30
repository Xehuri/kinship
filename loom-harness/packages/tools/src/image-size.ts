/**
 * 纯 TS 图片头解析：只读取尺寸，不依赖任何图片库。
 *
 * 目的是在图片 base64 进入模型上下文之前做硬限制拦截。生产事故：
 * read 返回 1027x15000 的 JPEG，后续 LLM 调用 400 "Image not recognized"。
 *
 * 解析失败（头部不完整、格式损坏、不支持的 mime）统一返回 null，由调用方
 * 转成明确的工具错误。
 */

export interface ImageDimensions {
  width: number;
  height: number;
}

/** 单边最大像素数。 */
export const DEFAULT_MAX_IMAGE_DIMENSION = 4096;

/** 总像素上限（4096x4096 以内）。 */
export const DEFAULT_MAX_IMAGE_PIXELS = 16_000_000;

/** 图片文件字节上限（base64 后约 13.3MB）。 */
export const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const RIFF_SIGNATURE = Buffer.from("RIFF", "ascii");
const WEBP_SIGNATURE = Buffer.from("WEBP", "ascii");

/** JPEG 里带尺寸信息的 SOF 标记：C0-CF，排除 DHT(C4)、JPG(C8)、DAC(CC)。 */
function isJpegSofMarker(marker: number): boolean {
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    marker !== 0xc4 &&
    marker !== 0xc8 &&
    marker !== 0xcc
  );
}

function validDimensions(width: number, height: number): ImageDimensions | null {
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

function readPngDimensions(data: Buffer): ImageDimensions | null {
  // 8 字节签名 + 4 字节长度 + "IHDR" + 4 字节宽 + 4 字节高。
  if (data.length < 24) return null;
  if (!data.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (data.toString("ascii", 12, 16) !== "IHDR") return null;
  return validDimensions(data.readUInt32BE(16), data.readUInt32BE(20));
}

function readJpegDimensions(data: Buffer): ImageDimensions | null {
  if (data.length < 4) return null;
  if (data.readUInt16BE(0) !== 0xffd8) return null;

  let offset = 2;
  while (offset < data.length) {
    // 跳过填充字节（连续 0xFF）；最后一个 0xFF 是标记前缀。
    if (data[offset] !== 0xff) return null;
    while (offset < data.length && data[offset] === 0xff) offset += 1;
    if (offset >= data.length) return null;

    const marker = data[offset];
    if (marker === undefined) return null;
    offset += 1;

    // 无长度的独立标记：SOI / EOI / TEM / RST0-RST7。
    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      if (marker === 0xd9) return null;
      continue;
    }

    // 其余标记后跟 2 字节大端长度（长度包含这 2 字节自身）。
    if (offset + 2 > data.length) return null;
    const segmentLength = data.readUInt16BE(offset);
    if (segmentLength < 2) return null;
    const segmentEnd = offset + segmentLength;
    if (segmentEnd > data.length) return null;

    if (isJpegSofMarker(marker)) {
      // 段内：precision(1) + height(2) + width(2)，段长至少 7。
      if (segmentLength < 7) return null;
      const height = data.readUInt16BE(offset + 3);
      const width = data.readUInt16BE(offset + 5);
      return validDimensions(width, height);
    }

    offset = segmentEnd;
  }
  return null;
}

function readGifDimensions(data: Buffer): ImageDimensions | null {
  if (data.length < 10) return null;
  const header = data.toString("ascii", 0, 6);
  if (header !== "GIF87a" && header !== "GIF89a") return null;
  return validDimensions(data.readUInt16LE(6), data.readUInt16LE(8));
}

function readWebpDimensions(data: Buffer): ImageDimensions | null {
  if (data.length < 20) return null;
  if (!data.subarray(0, 4).equals(RIFF_SIGNATURE)) return null;
  if (!data.subarray(8, 12).equals(WEBP_SIGNATURE)) return null;

  let offset = 12;
  while (offset + 8 <= data.length) {
    const fourCc = data.toString("ascii", offset, offset + 4);
    const chunkSize = data.readUInt32LE(offset + 4);
    const payload = offset + 8;

    if (fourCc === "VP8X") {
      // 10 字节负载：flags(1) + reserved(3) + 宽-1(3, LE) + 高-1(3, LE)。
      if (payload + 10 > data.length) return null;
      const width = data.readUIntLE(payload + 4, 3) + 1;
      const height = data.readUIntLE(payload + 7, 3) + 1;
      return validDimensions(width, height);
    }

    if (fourCc === "VP8 ") {
      // 帧标签(3) + 关键帧签名(3) + 14 位宽 + 14 位高（均为 LE）。
      if (payload + 10 > data.length) return null;
      if (
        data[payload + 3] !== 0x9d ||
        data[payload + 4] !== 0x01 ||
        data[payload + 5] !== 0x2a
      ) {
        return null;
      }
      const width = data.readUInt16LE(payload + 6) & 0x3fff;
      const height = data.readUInt16LE(payload + 8) & 0x3fff;
      return validDimensions(width, height);
    }

    if (fourCc === "VP8L") {
      // 0x2f 签名 + 14 位宽-1 + 14 位高-1，位流 LE。
      if (payload + 5 > data.length) return null;
      if (data[payload] !== 0x2f) return null;
      const bits = data.readUInt32LE(payload + 1);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >>> 14) & 0x3fff) + 1;
      return validDimensions(width, height);
    }

    // RIFF 块按偶数边界对齐。
    const nextOffset = payload + chunkSize + (chunkSize & 1);
    if (nextOffset <= offset) return null;
    offset = nextOffset;
  }
  return null;
}

/**
 * 解析 png/jpeg/gif/webp 的像素尺寸。无法识别或头部损坏时返回 null。
 */
export function readImageDimensions(
  data: Buffer,
  mimeType: string,
): ImageDimensions | null {
  switch (mimeType.toLowerCase()) {
    case "image/png":
      return readPngDimensions(data);
    case "image/jpeg":
    case "image/jpg":
      return readJpegDimensions(data);
    case "image/gif":
      return readGifDimensions(data);
    case "image/webp":
      return readWebpDimensions(data);
    default:
      return null;
  }
}
