// Audio thread: collects 16 kHz mono samples into 20 ms chunks for the page.
// On a 'flush' message it sends whatever is left, tagged so the page knows capture ended.
const CHUNK = 320 // 20 ms: the smaller the last chunk, the sooner the final text after release

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = new Float32Array(CHUNK)
    this.n = 0
    this.port.onmessage = () => {
      this.port.postMessage({ flush: true, pcm: this.buf.slice(0, this.n) })
      this.n = 0
    }
  }

  process(inputs) {
    const ch = inputs[0][0]
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i]
        if (this.n === CHUNK) {
          this.port.postMessage({ pcm: this.buf })
          this.buf = new Float32Array(CHUNK)
          this.n = 0
        }
      }
    }
    return true
  }
}

registerProcessor('pcm-capture', PcmCapture)
