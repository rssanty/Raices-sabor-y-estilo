// Quitar fondo — backend único.
// Pipeline:
//   Node.js
//   ├── ONNX Runtime → RMBG-2.0 → máscara alpha
//   └── Sharp: imagen ORIGINAL + máscara ORIGINAL → PNG transparente
//
// La imagen original NO se re-codifica para inferir: solo se extrae la
// máscara con la IA y se combina a resolución completa con Sharp.

import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import cors from 'cors';
import multer from 'multer';
import sharp from 'sharp';
import ort from 'onnxruntime-node';
import { BackgroundRemover } from '@tugrul/rembg';

// Silenciar warnings ruidosos de ONNX (MergeShapeInfo, GatherND...).
// Son avisos internos del grafo RMBG-2.0 y no afectan al resultado.
try {
  ort.env.logLevel = 'error';
} catch { /* ignorar */ }

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, 'public');
const modelsDir = path.join(__dirname, 'models');

// RMBG-2.0 (~977 MB). Se descarga solo la primera vez que se usa.
const MODEL_URL =
  process.env.BG_MODEL_URL ||
  'https://github.com/danielgatis/rembg/releases/download/v0.0.0/bria-rmbg-2.0.onnx';
const MODEL_PATH = process.env.BG_MODEL_PATH || path.join(modelsDir, 'rmbg-2.0.onnx');
const MODEL_MIN_BYTES = 800 * 1024 * 1024;

const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
const MODEL_SIZE = 1024;
const MAX_BYTES = 25 * 1024 * 1024;

// Una sola inferencia a la vez (la IA en CPU consume mucha RAM).
let removerPromise = null;
let tail = Promise.resolve();
function enqueue(task) {
  const run = tail.then(task, task);
  tail = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function ensureModel() {
  try {
    const st = await fs.promises.stat(MODEL_PATH);
    if (st.size >= MODEL_MIN_BYTES) return MODEL_PATH;
    await fs.promises.unlink(MODEL_PATH).catch(() => {});
  } catch {
    /* no existe: descargar */
  }
  await fs.promises.mkdir(modelsDir, { recursive: true });
  const tmpPath = `${MODEL_PATH}.download`;
  await fs.promises.unlink(tmpPath).catch(() => {});
  console.log(`[bg-remove] Descargando modelo RMBG-2.0 (~977 MB)...`);
  let res;
  try {
    res = await fetch(MODEL_URL, { signal: AbortSignal.timeout(60 * 60 * 1000) });
  } catch (err) {
    const e = new Error('No se pudo descargar el modelo RMBG-2.0. Revisa la conexión.');
    e.status = 502;
    e.cause = err;
    throw e;
  }
  if (!res.ok || !res.body) {
    const e = new Error(`Descarga del modelo falló (HTTP ${res.status}).`);
    e.status = 502;
    throw e;
  }
  try {
    await pipeline(res.body, fs.createWriteStream(tmpPath));
    const st = await fs.promises.stat(tmpPath);
    if (st.size < MODEL_MIN_BYTES) throw new Error(`Descarga incompleta (${(st.size / 1024 / 1024).toFixed(1)} MB).`);
    await fs.promises.rename(tmpPath, MODEL_PATH);
  } catch (err) {
    await fs.promises.unlink(tmpPath).catch(() => {});
    const e = new Error(`No se pudo guardar el modelo: ${err.message}`);
    e.status = 502;
    e.cause = err;
    throw e;
  }
  console.log(`[bg-remove] Modelo guardado en ${MODEL_PATH}`);
  return MODEL_PATH;
}

function getRemover() {
  if (!removerPromise) {
    removerPromise = (async () => {
      const modelPath = await ensureModel();
      const session = await ort.InferenceSession.create(modelPath, { logLevel: 'error' });
      return new BackgroundRemover(session, MEAN, STD);
    })().catch((err) => {
      removerPromise = null;
      throw err;
    });
  }
  return removerPromise;
}

async function buildInputTensor(rgbBuffer) {
  const { data, info } = await sharp(rgbBuffer)
    .resize(MODEL_SIZE, MODEL_SIZE, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (!info || info.width !== MODEL_SIZE || info.height !== MODEL_SIZE || info.channels < 3) {
    throw new Error('No se pudo preparar la imagen para la IA');
  }
  const chw = new Float32Array(3 * MODEL_SIZE * MODEL_SIZE);
  for (let c = 0; c < 3; c++) {
    const mean = MEAN[c];
    const std = STD[c];
    const off = c * MODEL_SIZE * MODEL_SIZE;
    for (let i = 0; i < MODEL_SIZE * MODEL_SIZE; i++) {
      chw[off + i] = (data[i * info.channels + c] / 255 - mean) / std;
    }
  }
  return new ort.Tensor('float32', chw, [1, 3, MODEL_SIZE, MODEL_SIZE]);
}

function rawToMask(raw, h, w) {
  let mi = Infinity;
  let ma = -Infinity;
  for (let i = 0; i < h * w; i++) {
    const v = raw[i];
    if (v < mi) mi = v;
    if (v > ma) ma = v;
  }
  const range = ma - mi;
  const out = new Uint8Array(h * w);
  for (let i = 0; i < h * w; i++) {
    const n = range > 0 ? (raw[i] - mi) / range : 0;
    out[i] = Math.round(Math.max(0, Math.min(1, n)) * 255);
  }
  return out;
}

export function removeBackgroundFromBuffer(inputBuffer) {
  if (!Buffer.isBuffer(inputBuffer) || !inputBuffer.length) {
    const e = new Error('Buffer de imagen vacío');
    e.status = 400;
    throw e;
  }
  if (inputBuffer.length > MAX_BYTES) {
    const e = new Error('Imagen demasiado grande para la IA (máx 25 MB)');
    e.status = 413;
    throw e;
  }
  return enqueue(async () => {
    const meta = await sharp(inputBuffer).metadata().catch(() => null);
    const originalWidth = meta?.width || 0;
    const originalHeight = meta?.height || 0;
    if (!originalWidth || !originalHeight) {
      const e = new Error('No se pudo leer la imagen');
      e.status = 400;
      throw e;
    }
    let remover;
    try {
      remover = await getRemover();
    } catch (err) {
      if (!err.status) {
        const e = new Error('El modelo de IA no pudo iniciarse. Revisa conexión (1ª vez descarga ~977 MB) y RAM (~4 GB).');
        e.status = 502;
        e.cause = err;
        throw e;
      }
      throw err;
    }

    // ── Rama ONNX: solo la máscara alpha ──
    let maskFull;
    try {
      const rgb = await sharp(inputBuffer).removeAlpha().toColorspace('srgb').toBuffer();
      const rgbMeta = await sharp(rgb).metadata().catch(() => null);
      if (!rgbMeta || rgbMeta.channels !== 3) {
        const e = new Error('Formato no soportado por la IA (usa foto RGB/JPEG/PNG).');
        e.status = 400;
        throw e;
      }
      const inputTensor = await buildInputTensor(rgb);
      try {
        const results = await remover.session.run({ [remover.session.inputNames[0]]: inputTensor });
        const output = results[remover.session.outputNames[0]];
        const h = Number(output.dims[2]);
        const w = Number(output.dims[3]);
        if (!Number.isInteger(h) || !Number.isInteger(w) || h <= 0 || w <= 0 || output.data.length < h * w) {
          throw new Error('Salida inesperada del modelo de IA');
        }
        const maskSmall = rawToMask(output.data, h, w);
        const { data: maskResized, info: maskInfo } = await sharp(
          Buffer.from(maskSmall),
          { raw: { width: w, height: h, channels: 1 } }
        )
          .resize(originalWidth, originalHeight, { fit: 'fill', kernel: 'lanczos3' })
          .toColorspace('b-w')
          .raw()
          .toBuffer({ resolveWithObject: true });
        if (!maskInfo || maskInfo.width !== originalWidth || maskInfo.height !== originalHeight || maskResized.length !== originalWidth * originalHeight) {
          throw new Error('La máscara de la IA no coincide con la imagen');
        }
        maskFull = maskResized;
      } finally {
        if (inputTensor && typeof inputTensor.dispose === 'function') inputTensor.dispose();
      }
    } catch (err) {
      if (err.status) throw err;
      const e = new Error(`La IA falló: ${err.message || err}`);
      e.status = 502;
      e.cause = err;
      throw e;
    }

    // ── Rama Sharp: ORIGINAL + máscara ORIGINAL → PNG transparente ──
    const { data: rgbData, info: rgbInfo } = await sharp(inputBuffer)
      .removeAlpha()
      .toColorspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (!rgbInfo || rgbInfo.width !== originalWidth || rgbInfo.height !== originalHeight || rgbInfo.channels < 3) {
      throw new Error('No se pudo preparar la imagen original');
    }
    const rgbaFull = Buffer.alloc(originalWidth * originalHeight * 4);
    for (let i = 0, j = 0; i < maskFull.length; i++, j += 4) {
      rgbaFull[j] = rgbData[i * 3];
      rgbaFull[j + 1] = rgbData[i * 3 + 1];
      rgbaFull[j + 2] = rgbData[i * 3 + 2];
      rgbaFull[j + 3] = maskFull[i];
    }
    const buffer = await sharp(rgbaFull, {
      raw: { width: originalWidth, height: originalHeight, channels: 4 }
    })
      .png()
      .toBuffer();
    if (!buffer.length) {
      const e = new Error('La IA devolvió una imagen vacía');
      e.status = 502;
      throw e;
    }

    // Validar máscara degenerada (todo transparente).
    const thumb = await sharp(buffer).resize({ width: 160, fit: 'inside', withoutEnlargement: true });
    const { data: rgba, info: rgbaInfo } = await thumb.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const ch = rgbaInfo.channels || 4;
    let opaqueN = 0;
    let alphaN = 0;
    for (let i = ch - 1; i < rgba.length; i += ch) {
      alphaN += 1;
      if (rgba[i] >= 128) opaqueN += 1;
    }
    if (opaqueN / Math.max(1, alphaN) < 0.01) {
      const e = new Error('No se detectó un sujeto claro: la IA la dejaría vacía. Prueba con fondo contrastado.');
      e.status = 422;
      throw e;
    }
    return { buffer, width: originalWidth, height: originalHeight };
  });
}

// ── Servidor (listo para AWS/EC2 Ubuntu: escucha en 0.0.0.0) ──
const app = express();
app.set('trust proxy', 1); // detrás de nginx/ELB en AWS
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

app.use(cors());
app.use(express.json({ limit: '25mb' }));
// Compat: el frontend antiguo (cacheado) mandaba el archivo crudo con
// Content-Type: image/... en vez de FormData. Aceptarlo como Buffer.
app.use(express.raw({ type: ['image/*', 'application/octet-stream'], limit: '25mb' }));
// HTML sin caché (para que el navegador siempre tome el último index.html);
// assets estáticos sí cacheados 1h.
app.use(express.static(publicDir, {
  maxAge: '1h',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store');
    }
  }
}));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|png|webp|jpg)$/i.test(file.mimetype)) cb(null, true);
    else cb(new Error('Solo JPG, PNG o WebP (máx 15 MB).'));
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'quitar-fondo', time: new Date().toISOString() });
});

// ── Stats del servidor: RAM y CPU (para el panel de la página) ──
let lastCpuTimes = null;
function systemCpuPercent() {
  let cur;
  try {
    cur = os.cpus().map((c) => ({ ...c.times }));
  } catch {
    return 0;
  }
  if (!lastCpuTimes || lastCpuTimes.length !== cur.length) {
    lastCpuTimes = cur;
    return 0;
  }
  let idleDiff = 0;
  let totalDiff = 0;
  for (let i = 0; i < cur.length; i++) {
    const p = lastCpuTimes[i];
    const c = cur[i];
    if (!p || !c) continue;
    idleDiff += c.idle - p.idle;
    totalDiff += c.user + c.nice + c.sys + c.idle + c.irq - (p.user + p.nice + p.sys + p.idle + p.irq);
  }
  lastCpuTimes = cur;
  if (totalDiff <= 0) return 0;
  return Math.round((1 - idleDiff / totalDiff) * 100);
}
let lastProcCpu = process.cpuUsage();
let lastProcT = Date.now();
function procCpuPercent() {
  const now = Date.now();
  const cur = process.cpuUsage();
  const elapsedMs = now - lastProcT;
  const usedMs = (cur.user + cur.system - (lastProcCpu.user + lastProcCpu.system)) / 1000;
  lastProcCpu = cur;
  lastProcT = now;
  if (elapsedMs <= 0) return 0;
  return Math.round((usedMs / elapsedMs) * 100);
}
const fmtGB = (b) => `${(b / 1024 / 1024 / 1024).toFixed(1)} GB`;

// ── GPU en número. NVIDIA vía nvidia-smi; en Windows fallback a typeperf
// (suma motores 3D, sirve para AMD/Intel/NVIDIA). Muestreo en segundo plano,
// el endpoint devuelve el último valor cacheado sin bloquear.
const gpuCache = { usage: null, name: '', updatedAt: 0 };

function runCmd(file, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(String(stdout || '').trim());
    });
  });
}

async function sampleNvidia() {
  const out = await runCmd('nvidia-smi', [
    '--query-gpu=utilization.gpu,name',
    '--format=csv,noheader,nounits'
  ]);
  if (!out) return false;
  const parts = out.split('\n')[0].split(',').map((s) => s.trim());
  const usage = Number(parts[0]);
  if (!Number.isFinite(usage)) return false;
  gpuCache.usage = Math.max(0, Math.min(100, Math.round(usage)));
  if (parts[1]) gpuCache.name = parts[1];
  gpuCache.updatedAt = Date.now();
  return true;
}

async function sampleWindowsGpu() {
  const out = await runCmd(
    'typeperf',
    ['\\GPU Engine(*engtype_3D*)\\Utilization Percentage', '-sc', '1'],
    12000
  );
  if (!out) return false;
  const lines = out.trim().split('\n');
  if (lines.length < 2) return false;
  const vals = lines[1]
    .split(',')
    .slice(1)
    .map((v) => Number(v.replace(/"/g, '')))
    .filter(Number.isFinite);
  if (!vals.length) return false;
  gpuCache.usage = Math.max(0, Math.min(100, Math.round(vals.reduce((a, b) => a + b, 0))));
  gpuCache.updatedAt = Date.now();
  return true;
}

async function gpuNameWindows() {
  const out = await runCmd(
    'powershell',
    ['-NoProfile', '-Command', '(Get-CimInstance Win32_VideoController | Select-Object -First 1).Name'],
    10000
  );
  if (out && !gpuCache.name) gpuCache.name = out.split('\n')[0].trim();
}

async function sampleGpu() {
  try {
    if (await sampleNvidia()) return;
    if (process.platform === 'win32' && (await sampleWindowsGpu())) return;
    gpuCache.usage = null; // sin datos (p.ej. sin contadores GPU)
  } catch {
    gpuCache.usage = null;
  }
}
sampleGpu();
gpuNameWindows();
setInterval(sampleGpu, 5000);
// Pre-calienta el cálculo de CPU para que la 1ª lectura ya dé un valor real.
systemCpuPercent();
procCpuPercent();

app.get('/api/stats', (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;
    const mem = process.memoryUsage();
    const cpus = os.cpus();
    res.json({
      ok: true,
      ram: { total, free, used, pct: Math.round((used / total) * 100), label: `${fmtGB(used)} / ${fmtGB(total)}` },
      cpu: { count: cpus.length, model: (cpus[0]?.model || '').trim(), usage: systemCpuPercent(), load: os.loadavg().map((n) => +n.toFixed(2)) },
      gpu: { usage: gpuCache.usage, name: gpuCache.name },
      proc: { rss: mem.rss, heap: mem.heapUsed, cpu: procCpuPercent(), label: fmtGB(mem.rss) }
    });
  } catch (err) {
    console.error(`[stats]: ${err.message}`);
    res.status(500).json({ ok: false, error: 'No se pudo leer stats del servidor' });
  }
});

// Acepta multipart (campo "image"), JSON { dataUrl } o bytes crudos
// (Content-Type: image/... del frontend antiguo cacheado).
async function handleBgRemove(req, res) {
  const t0 = Date.now();
  req.setTimeout(60 * 60 * 1000);
  try {
    let input = null;
    if (req.file?.buffer?.length) {
      input = req.file.buffer;
    } else if (Buffer.isBuffer(req.body) && req.body.length) {
      input = req.body;
    } else if (req.body?.dataUrl) {
      const { dataUrl } = req.body;
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
        return res.status(400).json({ ok: false, error: '"dataUrl" inválido.' });
      }
      const b64 = dataUrl.split(',')[1];
      if (!b64) return res.status(400).json({ ok: false, error: '"dataUrl" sin datos.' });
      input = Buffer.from(b64, 'base64');
    } else if (req.body?.image) {
      // por si el cliente manda base64 directo
      input = Buffer.from(req.body.image, 'base64');
    } else {
      return res.status(400).json({ ok: false, error: 'Sube una imagen (campo "image" o "dataUrl").' });
    }
    const { buffer, width, height } = await removeBackgroundFromBuffer(input);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('X-Width', String(width));
    res.setHeader('X-Height', String(height));
    res.setHeader('X-Process-Time-Ms', String(Date.now() - t0));
    return res.status(200).send(buffer);
  } catch (err) {
    const status = err.status || 500;
    console.error(`[bg-remove] ${status}: ${err.message}`);
    // Multer ya pasó: siempre JSON en error
    if (!res.headersSent) return res.status(status).json({ ok: false, error: err.message || 'Error interno' });
    return res.end();
  }
}

// Ruta actual + alias de la URL antigua (por si el navegador tiene el HTML viejo en caché).
app.post('/api/bg-remove', upload.single('image'), handleBgRemove);
app.post('/api/remove-bg', upload.single('image'), handleBgRemove);

// /api/* desconocido → JSON (no HTML) para que el frontend muestre el error real.
app.use('/api/', (_req, res) => {
  res.status(404).json({ ok: false, error: 'Ruta API no encontrada.' });
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  return res.sendFile(path.join(publicDir, 'index.html'));
});

app.use((err, _req, res, _next) => {
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  let message = err.message || 'Error interno del servidor';
  if (err.code === 'LIMIT_FILE_SIZE') message = 'Archivo demasiado grande (máximo 15MB).';
  console.error(`[error] -> ${status}: ${message}`);
  return res.status(status).json({ ok: false, error: message });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`\n  Quitar fondo listo en http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}\n`);
});

// Apagado limpio (systemd/Docker en EC2 mandan SIGTERM).
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`[${sig}] cerrando...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
