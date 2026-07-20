import crypto from "crypto";
import { PNG } from "pngjs";

// 与 infinite-canvas canvas-agent 的鸭子图隐写算法保持一致
const WATERMARK_SKIP_W_RATIO = 0.4;
const WATERMARK_SKIP_H_RATIO = 0.08;

export type DuckDecodeResult = {
  kind: "text" | "image" | "video" | "audio" | "file";
  ext: string;
  text?: string;
  buffer?: Buffer;
};

// 从 RGB 通道低 k 位提取隐藏载荷（跳过左上水印区），布局：前 32bit=载荷字节数，随后为载荷
function extractPayloadWithK(rgba: Buffer, width: number, height: number, k: number): Buffer {
  const skipW = Math.floor(width * WATERMARK_SKIP_W_RATIO);
  const skipH = Math.floor(height * WATERMARK_SKIP_H_RATIO);
  const hasSkip = skipW > 0 && skipH > 0;
  const mask = (1 << k) - 1;

  const out: number[] = [];
  let curByte = 0;
  let curBits = 0;
  let need = -1;

  for (let y = 0; y < height; y++) {
    const rowSkipped = hasSkip && y < skipH;
    for (let x = 0; x < width; x++) {
      if (rowSkipped && x < skipW) continue;
      const base = (y * width + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const v = rgba[base + ch] & mask;
        for (let j = k - 1; j >= 0; j--) {
          curByte = (curByte << 1) | ((v >> j) & 1);
          curBits++;
          if (curBits === 8) {
            out.push(curByte);
            curByte = 0;
            curBits = 0;
            if (need < 0 && out.length === 4) {
              const headerLen = ((out[0] << 24) | (out[1] << 16) | (out[2] << 8) | out[3]) >>> 0;
              if (headerLen <= 0) throw new Error("Payload length invalid. 载荷长度异常");
              need = 4 + headerLen;
            }
            if (need > 0 && out.length >= need) {
              return Buffer.from(out.slice(4, need));
            }
          }
        }
      }
    }
  }
  throw new Error("Insufficient image data. 图像数据不足");
}

function generateKeyStream(password: string, salt: Buffer, length: number): Buffer {
  const keyMaterial = Buffer.from(password + salt.toString("hex"), "utf-8");
  const chunks: Buffer[] = [];
  let total = 0;
  let counter = 0;
  while (total < length) {
    const h = crypto
      .createHash("sha256")
      .update(Buffer.concat([keyMaterial, Buffer.from(String(counter), "utf-8")]))
      .digest();
    chunks.push(h);
    total += h.length;
    counter++;
  }
  return Buffer.concat(chunks).subarray(0, length);
}

function parseHeader(header: Buffer, password: string): { data: Buffer; ext: string } {
  let idx = 0;
  if (header.length < 1) throw new Error("Header corrupted. 文件头损坏");
  const hasPwd = header[0] === 1;
  idx += 1;
  let pwdHash = Buffer.alloc(0);
  let salt = Buffer.alloc(0);
  if (hasPwd) {
    if (header.length < idx + 48) throw new Error("Header corrupted. 文件头损坏");
    pwdHash = header.subarray(idx, idx + 32);
    idx += 32;
    salt = header.subarray(idx, idx + 16);
    idx += 16;
  }
  if (header.length < idx + 1) throw new Error("Header corrupted. 文件头损坏");
  const extLen = header[idx];
  idx += 1;
  if (header.length < idx + extLen + 4) throw new Error("Header corrupted. 文件头损坏");
  const ext = header.subarray(idx, idx + extLen).toString("utf-8");
  idx += extLen;
  const dataLen = header.readUInt32BE(idx);
  idx += 4;
  const data = header.subarray(idx);
  if (data.length !== dataLen) throw new Error("Data length mismatch. 数据长度不匹配");
  if (!hasPwd) return { data: Buffer.from(data), ext };
  if (!password) throw new Error("Password required. 需要密码");
  const checkHash = crypto
    .createHash("sha256")
    .update(Buffer.from(password + salt.toString("hex"), "utf-8"))
    .digest();
  if (!checkHash.equals(pwdHash)) throw new Error("Wrong password. 密码错误");
  const ks = generateKeyStream(password, salt, data.length);
  const plain = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) plain[i] = data[i] ^ ks[i];
  return { data: plain, ext };
}

// 视频被编码成 RGB 像素矩阵 PNG，这里还原为原始字节
function binpngToBytes(rawPng: Buffer): Buffer {
  const png = PNG.sync.read(rawPng);
  const { data, width, height } = png;
  const out = Buffer.alloc(width * height * 3);
  let p = 0;
  for (let i = 0; i < width * height; i++) {
    out[p++] = data[i * 4];
    out[p++] = data[i * 4 + 1];
    out[p++] = data[i * 4 + 2];
  }
  let end = out.length;
  while (end > 0 && out[end - 1] === 0) end--;
  return out.subarray(0, end);
}

const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif"];
const VIDEO_EXTS = ["mp4", "mov", "webm", "avi", "mkv", "m4v"];
const AUDIO_EXTS = ["wav", "mp3", "ogg", "flac", "aac", "m4a"];

// 解密鸭子图，提取隐藏的原始内容
export function decodeDuckImage(pngBuffer: Buffer, password = ""): DuckDecodeResult {
  const png = PNG.sync.read(pngBuffer);
  const { data, width, height } = png;

  let raw: Buffer | null = null;
  let ext: string | null = null;
  let lastErr: unknown = null;
  for (const k of [2, 6, 8]) {
    try {
      const header = extractPayloadWithK(data, width, height, k);
      const parsed = parseHeader(header, password);
      raw = parsed.data;
      ext = parsed.ext;
      break;
    } catch (error) {
      lastErr = error;
    }
  }
  if (raw === null || ext === null) throw lastErr || new Error("解析失败");

  let finalExt = ext;
  let finalBytes = raw;
  if (ext.endsWith(".binpng")) {
    finalBytes = binpngToBytes(raw);
    finalExt = ext.replace(".binpng", "") || "mp4";
  }

  const lower = finalExt.toLowerCase();
  if (lower === "txt") {
    return { kind: "text", ext: "txt", text: raw.toString("utf-8") };
  }
  if (IMAGE_EXTS.includes(lower)) return { kind: "image", ext: lower, buffer: finalBytes };
  if (VIDEO_EXTS.includes(lower)) return { kind: "video", ext: lower, buffer: finalBytes };
  if (AUDIO_EXTS.includes(lower)) return { kind: "audio", ext: lower, buffer: finalBytes };
  return { kind: "file", ext: finalExt || "bin", buffer: finalBytes };
}

export function imageMimeForExt(ext: string): string {
  const e = ext.toLowerCase();
  if (e === "jpg" || e === "jpeg") return "image/jpeg";
  if (e === "webp") return "image/webp";
  if (e === "gif") return "image/gif";
  return "image/png";
}
