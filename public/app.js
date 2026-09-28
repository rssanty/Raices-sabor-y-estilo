// Único JS del frontend: elige imagen → POST /api/bg-remove → muestra PNG.
// + barra de progreso (subida real + procesado simulado) + monitor RAM/CPU.
const $ = (id) => document.getElementById(id);
const drop = $('drop');
const fileInput = $('file');
const goBtn = $('go');
const dlBtn = $('download');
const statusEl = $('status');
const origImg = $('orig');
const outImg = $('out');
const origMeta = $('origMeta');
const outMeta = $('outMeta');
const progressBox = $('progress');
const bar = $('bar');
const pct = $('pct');

let currentFile = null;
let resultBlobUrl = null;
let simTimer = null;

function setStatus(msg, kind = '') {
  statusEl.textContent = msg;
  statusEl.className = kind;
}

function setProgress(n, label = '') {
  progressBox.classList.add('show');
  bar.style.width = `${Math.max(0, Math.min(100, n))}%`;
  pct.textContent = label || (n > 0 ? `${Math.round(n)}%` : '');
}

function resetProgress() {
  clearInterval(simTimer);
  simTimer = null;
  bar.style.width = '0%';
  progressBox.classList.remove('show');
  pct.textContent = '';
}

function setFile(file) {
  if (!file) return;
  if (!/^image\/(jpeg|png|webp|jpg)$/i.test(file.type)) {
    setStatus('Solo JPG, PNG o WebP.', 'error');
    return;
  }
  if (file.size > 15 * 1024 * 1024) {
    setStatus('Archivo demasiado grande (máx 15 MB).', 'error');
    return;
  }
  currentFile = file;
  origImg.src = URL.createObjectURL(file);
  origMeta.textContent = `${(file.size / 1024).toFixed(0)} KB`;
  outImg.removeAttribute('src');
  outMeta.textContent = '';
  dlBtn.disabled = true;
  if (resultBlobUrl) URL.revokeObjectURL(resultBlobUrl);
  resultBlobUrl = null;
  goBtn.disabled = false;
  resetProgress();
  setStatus(`Lista: ${file.name}. Pulsa «Quitar fondo».`);
}

fileInput.addEventListener('change', (e) => setFile(e.target.files[0]));
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  setFile(e.dataTransfer.files[0]);
});

// Subida con XHR para progreso real (0→90%), luego simulado 90→99% en IA.
function uploadWithProgress(file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/bg-remove');
    xhr.responseType = 'blob';
    let uploadDone = false;

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const n = (e.loaded / e.total) * 90;
        setProgress(n, `Subiendo imagen… ${Math.round(n)}%`);
      }
    };
    xhr.upload.onload = () => {
      uploadDone = true;
      // Fase IA: avanza lento hasta 99% mientras el servidor procesa.
      let n = 90;
      setProgress(n, 'Quitando fondo a la imagen… 90%');
      clearInterval(simTimer);
      simTimer = setInterval(() => {
        n = Math.min(99, n + 0.4);
        setProgress(n, `Quitando fondo a la imagen… ${Math.round(n)}%`);
      }, 300);
    };
    xhr.onload = () => {
      clearInterval(simTimer);
      simTimer = null;
      if (xhr.status >= 200 && xhr.status < 300) {
        const w = xhr.getResponseHeader('X-Width');
        const h = xhr.getResponseHeader('X-Height');
        setProgress(100, 'Listo 100%');
        resolve({ blob: xhr.response, w, h });
      } else {
        // Error: intentar leer JSON.
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const j = JSON.parse(reader.result);
            reject(new Error(j.error || `Error ${xhr.status}`));
          } catch {
            reject(new Error(`Error ${xhr.status}`));
          }
        };
        reader.onerror = () => reject(new Error(`Error ${xhr.status}`));
        try { reader.readAsText(xhr.response); } catch { reject(new Error(`Error ${xhr.status}`)); }
      }
      if (!uploadDone && xhr.status >= 200 && xhr.status < 300) {
        // Archivo pequeño: el upload fue instantáneo.
      }
    };
    xhr.onerror = () => { clearInterval(simTimer); reject(new Error('Fallo de red.')); };
    xhr.ontimeout = () => { clearInterval(simTimer); reject(new Error('Tiempo agotado.')); };
    xhr.timeout = 60 * 60 * 1000;
    const form = new FormData();
    form.append('image', file);
    xhr.send(form);
  });
}

goBtn.addEventListener('click', async () => {
  if (!currentFile) return;
  goBtn.disabled = true;
  dlBtn.disabled = true;
  setProgress(2, 'Iniciando… 2%');
  setStatus('Procesando con RMBG-2.0… (la 1ª vez puede tardar minutos)');
  try {
    const { blob, w, h } = await uploadWithProgress(currentFile);
    if (resultBlobUrl) URL.revokeObjectURL(resultBlobUrl);
    resultBlobUrl = URL.createObjectURL(blob);
    outImg.src = resultBlobUrl;
    outMeta.textContent = w && h ? `${w}×${h}` : `${(blob.size / 1024).toFixed(0)} KB`;
    dlBtn.disabled = false;
    setStatus('Fondo eliminado. Píxeles originales intactos + máscara IA.', 'ok');
    setTimeout(resetProgress, 2500);
  } catch (err) {
    resetProgress();
    setStatus(err.message || 'Falló el proceso.', 'error');
  } finally {
    goBtn.disabled = false;
  }
});

dlBtn.addEventListener('click', () => {
  if (!resultBlobUrl) return;
  const a = document.createElement('a');
  a.href = resultBlobUrl;
  a.download = (currentFile?.name || 'imagen').replace(/\.[a-z0-9]+$/i, '') + '-sin-fondo.png';
  a.click();
});

// ── Monitor RAM/CPU/GPU del servidor en números (polling /api/stats cada 2 s) ──
const ramNum = $('ramNum');
const cpuNum = $('cpuNum');
const gpuNum = $('gpuNum');
const procNum = $('procNum');
const ramSub = $('ramSub');
const cpuSub = $('cpuSub');
const gpuSub = $('gpuSub');
const procSub = $('procSub');

let statsFails = 0;

async function refreshStats() {
  try {
    const res = await fetch('/api/stats', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const s = await res.json();
    if (!s.ok) throw new Error('stats no ok');
    statsFails = 0;
    ramNum.textContent = `${s.ram.pct}%`;
    ramSub.textContent = s.ram.label;
    cpuNum.textContent = `${s.cpu.usage}%`;
    cpuSub.textContent = `${s.cpu.count} núcleos`;
    if (s.gpu && s.gpu.usage !== null && s.gpu.usage !== undefined) {
      gpuNum.textContent = `${s.gpu.usage}%`;
      gpuSub.textContent = (s.gpu.name || 'GPU').slice(0, 26);
    } else {
      gpuNum.textContent = 'N/D';
      gpuSub.textContent = (s.gpu && s.gpu.name) ? s.gpu.name.slice(0, 26) : 'sin datos';
    }
    procNum.textContent = `${s.proc.cpu}%`;
    procSub.textContent = `RSS ${s.proc.label}`;
  } catch {
    // Si el backend no es accesible (p.ej. abriste el HTML con Live Server
    // o doble clic en vez de http://localhost:3000) avisa en vez de dejar "—".
    statsFails += 1;
    if (statsFails >= 2) {
      ramSub.textContent = 'sin servidor';
      cpuSub.textContent = 'npm start + :3000';
      gpuSub.textContent = 'sin servidor';
      procSub.textContent = 'sin servidor';
    }
  }
}
refreshStats();
setInterval(refreshStats, 2000);
