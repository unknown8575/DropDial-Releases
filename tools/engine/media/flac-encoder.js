/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// packages/flac-encoder/src/index.ts
import { Logging } from "./mediabunny.js";

// packages/flac-encoder/src/encoder.ts
import {
  CustomAudioEncoder,
  EncodedPacket,
  registerEncoder
} from "./mediabunny.js";

// inline-worker:__inline-worker
async function inlineWorker(scriptText, cache2) {
  if (typeof Worker !== "undefined" && typeof Bun === "undefined") {
    if (!cache2.url) {
      const blob = new Blob([scriptText], { type: "text/javascript" });
      cache2.url = URL.createObjectURL(blob);
    }
    const worker = new Worker(cache2.url, {
      type: typeof Deno !== "undefined" ? "module" : void 0
      // module for Deno
    });
    return worker;
  } else {
    let Worker3;
    try {
      Worker3 = (await import("worker_threads")).Worker;
    } catch {
      Worker3 = __require("worker_threads").Worker;
    }
    const worker = new Worker3(scriptText, { eval: true });
    return worker;
  }
}

// packages/flac-encoder/src/encode.worker.ts
var cache = {};
function Worker2() {
  return new Worker(new URL("./flac-worker.js", import.meta.url));
}

// packages/flac-encoder/src/encoder.ts
var FLAC_SAMPLE_RATES = [
  8e3,
  16e3,
  22050,
  24e3,
  32e3,
  44100,
  48e3,
  88200,
  96e3,
  176400,
  192e3
];
var FlacEncoder = class extends CustomAudioEncoder {
  constructor() {
    super(...arguments);
    this.worker = null;
    this.workerError = null;
    this.nextMessageId = 0;
    this.pendingMessages = /* @__PURE__ */ new Map();
    this.ctx = null;
    this.chunkMetadata = {};
    this.description = null;
    this.nextTimestampInSamples = null;
    this.inFlightEncode = null;
  }
  static supports(codec, config) {
    return codec === "flac" && config.numberOfChannels >= 1 && config.numberOfChannels <= 8 && FLAC_SAMPLE_RATES.includes(config.sampleRate);
  }
  async init() {
    this.worker = await Worker2();
    const onMessage = (data) => {
      const pending = this.pendingMessages.get(data.id);
      assert(pending !== void 0);
      this.pendingMessages.delete(data.id);
      if (data.success) {
        pending.resolve(data.data);
      } else {
        pending.reject(data.error);
      }
    };
    const onError = (error) => {
      this.workerError = error;
      for (const pending of this.pendingMessages.values()) {
        pending.reject(error);
      }
      this.pendingMessages.clear();
      this.worker?.terminate();
      this.worker = null;
    };
    if (this.worker.addEventListener) {
      this.worker.addEventListener("message", (event) => onMessage(event.data));
      this.worker.addEventListener("error", (event) => {
        onError(new Error(event.message || "FLAC encoder worker failed to load or crashed."));
      });
    } else {
      const nodeWorker = this.worker;
      nodeWorker.on("message", onMessage);
      nodeWorker.on("error", onError);
    }
  }
  resetInternalState() {
    this.nextTimestampInSamples = null;
    this.chunkMetadata = {
      decoderConfig: {
        codec: "flac",
        numberOfChannels: this.config.numberOfChannels,
        sampleRate: this.config.sampleRate,
        description: this.description
      }
    };
  }
  async encode(audioSample) {
    if (this.ctx === null) {
      let bitsPerSample;
      switch (audioSample.format) {
        case "u8":
        case "u8-planar":
        case "s16":
        case "s16-planar":
          bitsPerSample = 16;
          break;
        case "s32":
        case "s32-planar":
        case "f32":
        case "f32-planar":
          bitsPerSample = 24;
          break;
        default:
          assertNever(audioSample.format);
          assert(false);
      }
      const result = await this.sendCommand({
        type: "init",
        data: {
          numberOfChannels: this.config.numberOfChannels,
          sampleRate: this.config.sampleRate,
          bitsPerSample
        }
      });
      this.ctx = result.ctx;
      this.description = new Uint8Array(result.header);
      this.resetInternalState();
    }
    if (this.nextTimestampInSamples === null) {
      this.nextTimestampInSamples = Math.round(audioSample.timestamp * this.config.sampleRate);
    }
    const totalBytes = audioSample.allocationSize({ format: "s32", planeIndex: 0 });
    const audioData = new ArrayBuffer(totalBytes);
    audioSample.copyTo(audioData, { format: "s32", planeIndex: 0 });
    const encode = this.sendCommand({
      type: "encode",
      data: {
        ctx: this.ctx,
        audioData,
        numSamples: audioSample.numberOfFrames
      }
    }, [audioData]).then((result) => this.emitPackets(result.packets));
    encode.catch(() => {
    });
    const previousEncode = this.inFlightEncode;
    this.inFlightEncode = encode;
    await previousEncode;
  }
  async flush() {
    if (this.ctx === null) {
      return;
    }
    await this.inFlightEncode;
    this.inFlightEncode = null;
    const result = await this.sendCommand({ type: "flush", data: { ctx: this.ctx } });
    this.emitPackets(result.packets);
    this.resetInternalState();
  }
  close() {
    this.worker?.terminate();
  }
  emitPackets(packets) {
    assert(this.nextTimestampInSamples !== null);
    for (const p of packets) {
      const data = new Uint8Array(p.encodedData);
      const packet = new EncodedPacket(
        data,
        "key",
        this.nextTimestampInSamples / this.config.sampleRate,
        p.samples / this.config.sampleRate
      );
      this.nextTimestampInSamples += p.samples;
      this.onPacket(
        packet,
        this.chunkMetadata
      );
      this.chunkMetadata = {};
    }
  }
  sendCommand(command, transferables) {
    return new Promise((resolve, reject) => {
      if (this.workerError) {
        reject(this.workerError);
        return;
      }
      const id = this.nextMessageId++;
      this.pendingMessages.set(id, {
        resolve,
        reject
      });
      assert(this.worker);
      if (transferables) {
        this.worker.postMessage({ id, command }, transferables);
      } else {
        this.worker.postMessage({ id, command });
      }
    });
  }
};
var registered = false;
var registerFlacEncoder = () => {
  if (registered) {
    return;
  }
  registered = true;
  registerEncoder(FlacEncoder);
};
function assert(x) {
  if (!x) {
    throw new Error("Assertion failed.");
  }
}
var assertNever = (x) => {
  throw new Error(`Unexpected value: ${x}`);
};

// packages/flac-encoder/src/index.ts
var FLAC_ENCODER_LOADED_SYMBOL = Symbol.for("@mediabunny/flac-encoder loaded");
if (globalThis[FLAC_ENCODER_LOADED_SYMBOL]) {
  Logging._error(
    "[WARNING]\n@mediabunny/flac-encoder was loaded twice. This will likely cause the encoder not to work correctly. Check if multiple dependencies are importing different versions of @mediabunny/flac-encoder, or if something is being bundled incorrectly."
  );
}
globalThis[FLAC_ENCODER_LOADED_SYMBOL] = true;
export {
  registerFlacEncoder
};
