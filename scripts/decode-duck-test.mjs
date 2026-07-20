// 鸭子图隐写解密验证工具
//   解密某张图: node scripts/decode-duck-test.mjs <图片路径或URL> [密码]
//   闭环自检:   node scripts/decode-duck-test.mjs --selftest
// 依赖本地 node_modules 里的 pngjs。用于不起服务/不重建 docker 时验证解密逻辑。
import fs from "fs";
import path from "path";
import crypto from "crypto";
import https from "https";
import http from "http";
import { PNG } from "pngjs";

const WATERMARK_SKIP_W_RATIO = 0.4;
const WATERMARK_SKIP_H_RATIO = 0.08;

function extractPayloadWithK(rgba, width, height, k) {
  const skipW = Math.floor(width * WATERMARK_SKIP_W_RATIO);
  const skipH = Math.floor(height * WATERMARK_SKIP_H_RATIO);
  const hasSkip = skipW > 0 && skipH > 0;
  const mask = (1 << k) - 1;
  const out = [];
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
              if (headerLen <= 0) throw new Error("Payload length invalid");
              need = 4 + headerLen;
            }
            if (need > 0 && out.length >= need) return Buffer.from(out.slice(4, need));
          }
        }
      }
    }
  }
  throw new Error("Insufficient image data");
}

function generateKeyStream(password, salt, length) {
  const keyMaterial = Buffer.from(password + salt.toString("hex"), "utf-8");
  const chunks = [];
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

function parseHeader(header, password) {
  let idx = 0;
  if (header.length < 1) throw new Error("Header corrupted");
  const hasPwd = header[0] === 1;
  idx += 1;
  let pwdHash = Buffer.alloc(0);
  let salt = Buffer.alloc(0);
  if (hasPwd) {
    if (header.length < idx + 48) throw new Error("Header corrupted");
    pwdHash = header.subarray(idx, idx + 32);
    idx += 32;
    salt = header.subarray(idx, idx + 16);
    idx += 16;
  }
  if (header.length < idx + 1) throw new Error("Header corrupted");
  const extLen = header[idx];
  idx += 1;
  if (header.length < idx + extLen + 4) throw new Error("Header corrupted");
  const ext = header.subarray(idx, idx + extLen).toString("utf-8");
  idx += extLen;
  const dataLen = header.readUInt32BE(idx);
  idx += 4;
  const data = header.subarray(idx);
  if (data.length !== dataLen) throw new Error("Data length mismatch");
  if (!hasPwd) return { data: Buffer.from(data), ext };
  if (!password) throw new Error("Password required");
  const checkHash = crypto
    .createHash("sha256")
    .update(Buffer.from(password + salt.toString("hex"), "utf-8"))
    .digest();
  if (!checkHash.equals(pwdHash)) throw new Error("Wrong password");
  const ks = generateKeyStream(password, salt, data.length);
  const plain = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) plain[i] = data[i] ^ ks[i];
  return { data: plain, ext };
}

function binpngToBytes(rawPng) {
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

function decodeDuckImage(pngBuffer, password = "") {
  const png = PNG.sync.read(pngBuffer);
  const { data, width, height } = png;
  console.log(`图片尺寸 ${width}x${height}`);
  let raw = null;
  let ext = null;
  let lastErr = null;
  for (const k of [2, 6, 8]) {
    try {
      const header = extractPayloadWithK(data, width, height, k);
      const parsed = parseHeader(header, password);
      raw = parsed.data;
      ext = parsed.ext;
      console.log(`[hit] k=${k} 提取成功 ext=${ext}`);
      break;
    } catch (error) {
      console.log(`[miss] k=${k}: ${error.message}`);
      lastErr = error;
    }
  }
  if (raw === null) throw lastErr || new Error("解析失败");
  let finalExt = ext;
  let finalBytes = raw;
  if (ext.endsWith(".binpng")) {
    finalBytes = binpngToBytes(raw);
    finalExt = ext.replace(".binpng", "") || "mp4";
  }
  return { ext: finalExt, buffer: finalBytes };
}

// ===== 加密侧（镜像 duck_payload_exporter.py，仅用于 --selftest 闭环验证）=====
function buildFileHeader(raw, ext, password) {
  const extBytes = Buffer.from(ext, "utf-8");
  const hasPwd = !!password;
  let payload = raw;
  let salt = Buffer.alloc(0);
  let pwdHash = Buffer.alloc(0);
  if (hasPwd) {
    salt = crypto.randomBytes(16);
    const ks = generateKeyStream(password, salt, raw.length);
    payload = Buffer.alloc(raw.length);
    for (let i = 0; i < raw.length; i++) payload[i] = raw[i] ^ ks[i];
    pwdHash = crypto
      .createHash("sha256")
      .update(Buffer.from(password + salt.toString("hex"), "utf-8"))
      .digest();
  }
  const parts = [Buffer.from([hasPwd ? 1 : 0])];
  if (hasPwd) parts.push(pwdHash, salt);
  parts.push(Buffer.from([extBytes.length]), extBytes);
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(payload.length, 0);
  parts.push(lenBuf, payload);
  return Buffer.concat(parts);
}

function embedPayloadLsb(rgba, width, height, fileHeader, k) {
  const skipW = Math.floor(width * WATERMARK_SKIP_W_RATIO);
  const skipH = Math.floor(height * WATERMARK_SKIP_H_RATIO);
  const hasSkip = skipW > 0 && skipH > 0;
  const mask = (1 << k) - 1;
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(fileHeader.length, 0);
  const payload = Buffer.concat([prefix, fileHeader]);
  const bits = [];
  for (const byte of payload) for (let j = 7; j >= 0; j--) bits.push((byte >> j) & 1);
  let g = 0;
  for (let y = 0; y < height && g * k < bits.length; y++) {
    const rowSkipped = hasSkip && y < skipH;
    for (let x = 0; x < width && g * k < bits.length; x++) {
      if (rowSkipped && x < skipW) continue;
      const base = (y * width + x) * 4;
      for (let ch = 0; ch < 3 && g * k < bits.length; ch++) {
        let v = 0;
        for (let b = 0; b < k; b++) {
          const bitIdx = g * k + b;
          v = (v << 1) | (bitIdx < bits.length ? bits[bitIdx] : 0);
        }
        rgba[base + ch] = (rgba[base + ch] & ~mask) | v;
        g++;
      }
    }
  }
  return rgba;
}

function runSelfTest() {
  const width = 200;
  const height = 200;
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = i % 256;
    rgba[i * 4 + 1] = (i * 3) % 256;
    rgba[i * 4 + 2] = (i * 7) % 256;
    rgba[i * 4 + 3] = 255;
  }
  const message = "hello 鸭子隐写 self-test 12345";
  let allOk = true;
  for (const k of [2, 6, 8]) {
    const buf = Buffer.from(rgba);
    const header = buildFileHeader(Buffer.from(message, "utf-8"), "txt", "");
    embedPayloadLsb(buf, width, height, header, k);
    try {
      const extracted = extractPayloadWithK(buf, width, height, k);
      const parsed = parseHeader(extracted, "");
      const text = parsed.data.toString("utf-8");
      const ok = text === message && parsed.ext === "txt";
      console.log(`k=${k}: ${ok ? "PASS" : "FAIL"} ext=${parsed.ext} text=${JSON.stringify(text)}`);
      if (!ok) allOk = false;
    } catch (e) {
      console.log(`k=${k}: FAIL ${e.message}`);
      allOk = false;
    }
  }
  console.log(allOk ? "\n自检通过：加密→解密闭环正确，解密逻辑没问题。" : "\n自检失败：解密逻辑存在问题。");
  process.exit(allOk ? 0 : 1);
}

function loadInput(src) {
  if (/^https?:\/\//i.test(src)) {
    const client = src.startsWith("https") ? https : http;
    return new Promise((resolve, reject) => {
      client
        .get(src, (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks)));
        })
        .on("error", reject);
    });
  }
  return Promise.resolve(fs.readFileSync(src));
}

async function main() {
  const src = process.argv[2];
  if (src === "--selftest") {
    runSelfTest();
    return;
  }
  const password = process.argv[3] || "";
  if (!src) {
    console.error("用法: node scripts/decode-duck-test.mjs <图片路径或URL> [密码]");
    console.error("      node scripts/decode-duck-test.mjs --selftest");
    process.exit(1);
  }
  const buffer = await loadInput(src);
  console.log(`已读取图片 ${buffer.length} 字节`);
  const result = decodeDuckImage(buffer, password);
  const outPath = path.resolve(`duck-decoded.${result.ext}`);
  fs.writeFileSync(outPath, result.buffer);
  console.log(`解密成功: ext=${result.ext} bytes=${result.buffer.length}`);
  console.log(`已写出: ${outPath}`);
}

main().catch((error) => {
  console.error(`解密失败: ${error.message}`);
  process.exit(1);
});
