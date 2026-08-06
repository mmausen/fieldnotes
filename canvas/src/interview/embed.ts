/** Local sentence embeddings via transformers.js (all-MiniLM-L6-v2, ONNX/WASM).
 *
 * Fully offline: the model lives under public/models and the ONNX-runtime WASM
 * under public/ort, so nothing is fetched from a CDN at runtime -- the whole app
 * keeps its "no data leaves the machine" property.
 */
import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers'

env.allowRemoteModels = false
env.allowLocalModels = true
env.localModelPath = '/models/'
const wasm = env.backends?.onnx?.wasm
if (wasm) {
  wasm.wasmPaths = '/ort/'
  // single-threaded so we don't need SharedArrayBuffer (which would need COOP/COEP)
  wasm.numThreads = 1
}

let pipe: Promise<FeatureExtractionPipeline> | null = null
function extractor() {
  if (!pipe) {
    pipe = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      dtype: 'q8', // the bundled onnx/model_quantized.onnx
    })
  }
  return pipe
}

/** Warm the model so the first real embed isn't slow. Safe to call repeatedly. */
export async function warmup(): Promise<void> {
  await extractor()
}

/** Embed texts into L2-normalized vectors (so dot product == cosine). */
export async function embed(texts: string[]): Promise<Float32Array[]> {
  if (!texts.length) return []
  const ext = await extractor()
  const out = await ext(texts, { pooling: 'mean', normalize: true })
  const dim = out.dims[out.dims.length - 1]
  const data = out.data as Float32Array
  const rows: Float32Array[] = []
  for (let i = 0; i < texts.length; i++) rows.push(data.slice(i * dim, (i + 1) * dim))
  return rows
}

/** Cosine similarity of two normalized vectors. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}
