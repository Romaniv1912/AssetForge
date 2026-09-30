/**
 * WebGPU availability with a human-readable reason, so "cannot run" messages
 * can say *why* (Figma's plugin window may not expose WebGPU at all).
 */
export interface WebGpuStatus {
  available: boolean;
  /** fp16 shaders (`shader-f16`) — needed by the fp16 models. */
  fp16: boolean;
  detail: string;
}

type GpuAdapterLike = {
  features?: { has(name: string): boolean };
  info?: { vendor?: string; architecture?: string; description?: string };
};

let cached: Promise<WebGpuStatus> | undefined;

export function detectWebGpu(): Promise<WebGpuStatus> {
  cached ??= (async (): Promise<WebGpuStatus> => {
    const secure = typeof isSecureContext === 'undefined' || isSecureContext;
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(o?: object): Promise<GpuAdapterLike | null> } }).gpu;
    if (!gpu) {
      return {
        available: false,
        fp16: false,
        detail: secure
          ? 'WebGPU is not exposed in this Figma window (navigator.gpu is missing).'
          : 'WebGPU is not exposed: the Figma plugin window is not a secure context.',
      };
    }
    try {
      const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) return { available: false, fp16: false, detail: 'WebGPU is present but no GPU adapter is available (GPU blocked or driver unsupported).' };
      const fp16 = adapter.features?.has('shader-f16') ?? false;
      const name = [adapter.info?.vendor, adapter.info?.architecture || adapter.info?.description].filter(Boolean).join(' ');
      return {
        available: true,
        fp16,
        detail: `WebGPU available${name ? ` (${name})` : ''}${fp16 ? '' : ', but without fp16 shader support'}.`,
      };
    } catch (error) {
      return { available: false, fp16: false, detail: `WebGPU adapter request failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  })();
  return cached;
}
