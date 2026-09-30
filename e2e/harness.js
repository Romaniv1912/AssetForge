// Mock of the Figma main thread (src/plugin/code.ts) speaking the same protocol.
const frame = document.getElementById('frame');
const log = (window.__log = []);
window.__applied = [];

const images = {
  'hash-logo': { name: 'Logo', file: 'logo.png', width: 500, height: 500 },
  'hash-chelsea': { name: 'Cat photo', file: 'chelsea.png', width: 451, height: 300 },
  'hash-rocket': { name: 'Rocket', file: 'rocket.jpg', width: 640, height: 427 },
  'hash-missing': { name: 'Broken image', file: null, width: 10, height: 10 },
};

const send = (msg) => frame.contentWindow.postMessage({ pluginMessage: msg }, '*');

const selection = {
  images: Object.entries(images).map(([id, img], i) => ({
    id,
    hash: id,
    crop: null,
    name: img.name,
    width: img.width,
    height: img.height,
    fullWidth: img.width,
    fullHeight: img.height,
    targets: [{ nodeId: `1:${i + 1}`, nodeName: img.name, nodeType: 'RECTANGLE', fillIndex: 0, nodeWidth: img.width, nodeHeight: img.height }],
  })),
  unsupported: [{ nodeId: '9:1', nodeName: 'Heading', nodeType: 'TEXT', reason: 'Text without an image fill' }],
  truncated: false,
  scannedNodes: 6,
};

window.addEventListener('message', async (event) => {
  if (event.source !== frame.contentWindow) return;
  const msg = event.data?.pluginMessage;
  if (!msg) return;
  log.push(msg.type);
  switch (msg.type) {
    case 'UI_READY':
      send({ type: 'INIT', options: window.__initialOptions ?? null, editorType: 'figma' });
      send({ type: 'SELECTION_CHANGED', selection });
      break;
    case 'REQUEST_IMAGE_BYTES': {
      const img = images[msg.imageId];
      if (!img?.file) {
        send({ type: 'IMAGE_BYTES_ERROR', requestId: msg.requestId, imageId: msg.imageId, error: 'Image not found in this file' });
        break;
      }
      const bytes = new Uint8Array(await (await fetch(`/fixtures/${img.file}`)).arrayBuffer());
      send({ type: 'IMAGE_BYTES', requestId: msg.requestId, imageId: msg.imageId, bytes });
      break;
    }
    case 'APPLY_RESULTS':
      window.__applied.push(...msg.items.map((i) => ({ imageId: i.imageId, bytes: i.bytes.length, magic: Array.from(i.bytes.slice(0, 4)), width: i.width, height: i.height, mode: msg.mode })));
      send({
        type: 'APPLY_DONE',
        requestId: msg.requestId,
        outcomes: msg.items.map((i) => ({ imageId: i.imageId, ok: true, updatedNodes: i.targets.length, warnings: [] })),
      });
      break;
    case 'RESIZE_UI':
      frame.style.width = `${msg.width}px`;
      frame.style.height = `${msg.height}px`;
      break;
    default:
      break;
  }
});

fetch('/ui.html')
  .then((r) => r.text())
  .then((html) => {
    frame.srcdoc = html;
  });
