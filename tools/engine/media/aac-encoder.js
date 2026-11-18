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

// packages/aac-encoder/src/index.ts
import { Logging } from "./mediabunny.js";

// shared/bitstream.ts
var Bitstream = class _Bitstream {
  constructor(bytes) {
    this.bytes = bytes;
    /** Current offset in bits. */
    this.pos = 0;
  }
  seekToByte(byteOffset) {
    this.pos = 8 * byteOffset;
  }
  readBit() {
    const byteIndex = Math.floor(this.pos / 8);
    const byte = this.bytes[byteIndex] ?? 0;
    const bitIndex = 7 - (this.pos & 7);
    const bit = (byte & 1 << bitIndex) >> bitIndex;
    this.pos++;
    return bit;
  }
  readBits(n) {
    if (n === 1) {
      return this.readBit();
    }
    let result = 0;
    for (let i = 0; i < n; i++) {
      result = 2 * result + this.readBit();
    }
    return result;
  }
  writeBits(n, value) {
    const end = this.pos + n;
    for (let i = this.pos; i < end; i++) {
      const byteIndex = Math.floor(i / 8);
      let byte = this.bytes[byteIndex];
      const bitIndex = 7 - (i & 7);
      const bit = Math.floor(value / 2 ** (end - i - 1)) & 1;
      byte &= ~(1 << bitIndex);
      byte |= bit << bitIndex;
      this.bytes[byteIndex] = byte;
    }
    this.pos = end;
  }
  copyBits(n, other) {
    let i = 0;
    for (i; i < n - 7; i += 8) {
      this.writeBits(8, other.readBits(8));
    }
    const leftover = n - i;
    if (leftover > 0) {
      this.writeBits(leftover, other.readBits(leftover));
    }
  }
  readAlignedByte() {
    if (this.pos % 8 !== 0) {
      throw new Error("Bitstream is not byte-aligned.");
    }
    const byteIndex = this.pos / 8;
    const byte = this.bytes[byteIndex] ?? 0;
    this.pos += 8;
    return byte;
  }
  skipBits(n) {
    this.pos += n;
  }
  getBitsLeft() {
    return this.bytes.length * 8 - this.pos;
  }
  clone() {
    const clone = new _Bitstream(this.bytes);
    clone.pos = this.pos;
    return clone;
  }
};

// shared/aac-misc.ts
var aacFrequencyTable = [
  96e3,
  88200,
  64e3,
  48e3,
  44100,
  32e3,
  24e3,
  22050,
  16e3,
  12e3,
  11025,
  8e3,
  7350
];
var aacChannelMap = [-1, 1, 2, 3, 4, 5, 6, 8];
var generalAudioObjectTypes = [1, 2, 3, 4, 6, 7, 17, 19, 20, 21, 22];
var parseAacAudioSpecificConfig = (bytes) => {
  if (!bytes || bytes.byteLength < 2) {
    throw new TypeError("AAC description must be at least 2 bytes long.");
  }
  const bitstream = new Bitstream(bytes);
  const objectType = readAacObjectType(bitstream);
  const { frequencyIndex, sampleRate } = readAacSamplingFrequency(bitstream);
  const channelConfiguration = bitstream.readBits(4);
  let numberOfChannels = null;
  if (channelConfiguration >= 1 && channelConfiguration <= 7) {
    numberOfChannels = aacChannelMap[channelConfiguration];
  }
  let coreObjectType = objectType;
  let psPresent = false;
  let outputSampleRate = sampleRate;
  if (objectType === 5 || objectType === 29) {
    psPresent = objectType === 29;
    outputSampleRate = readAacSamplingFrequency(bitstream).sampleRate;
    coreObjectType = readAacObjectType(bitstream);
    if (coreObjectType === 22) {
      bitstream.skipBits(4);
    }
  }
  let frameLength = 1024;
  let programConfigElement = null;
  if (generalAudioObjectTypes.includes(coreObjectType)) {
    frameLength = bitstream.readBits(1) ? 960 : 1024;
    if (channelConfiguration === 0) {
      if (bitstream.readBits(1)) {
        bitstream.skipBits(14);
      }
      bitstream.skipBits(1);
      programConfigElement = readAacProgramConfigElement(bitstream);
      numberOfChannels = getAacProgramConfigElementChannelCount(programConfigElement);
    }
  }
  if (objectType !== 5 && objectType !== 29) {
    while (bitstream.getBitsLeft() > 15) {
      const searchStart = bitstream.pos;
      if (bitstream.readBits(11) !== 695) {
        bitstream.pos = searchStart + 1;
        continue;
      }
      if (readAacObjectType(bitstream) === 5 && bitstream.readBits(1)) {
        outputSampleRate = readAacSamplingFrequency(bitstream).sampleRate;
        if (bitstream.getBitsLeft() > 11 && bitstream.readBits(11) === 1352) {
          psPresent = !!bitstream.readBits(1);
        }
      }
      break;
    }
  }
  if (numberOfChannels !== null && numberOfChannels > 1) {
    psPresent = false;
  }
  return {
    objectType,
    coreObjectType,
    frequencyIndex,
    channelConfiguration,
    coreSampleRate: sampleRate,
    outputSampleRate,
    outputNumberOfChannels: psPresent && numberOfChannels === 1 ? 2 : numberOfChannels,
    frameLength,
    programConfigElement
  };
};
var readAacObjectType = (bitstream) => {
  const objectType = bitstream.readBits(5);
  return objectType === 31 ? 32 + bitstream.readBits(6) : objectType;
};
var readAacSamplingFrequency = (bitstream) => {
  const frequencyIndex = bitstream.readBits(4);
  if (frequencyIndex === 15) {
    return {
      frequencyIndex,
      sampleRate: bitstream.readBits(24)
    };
  }
  return {
    frequencyIndex,
    sampleRate: frequencyIndex < aacFrequencyTable.length ? aacFrequencyTable[frequencyIndex] : null
  };
};
var buildAdtsHeaderTemplate = (config) => {
  const { coreObjectType, frequencyIndex, frameLength } = config;
  let { channelConfiguration, programConfigElement } = config;
  if (coreObjectType < 1 || coreObjectType > 4) {
    throw new Error(`AAC object type ${coreObjectType} can't be stored in ADTS.`);
  }
  if (frequencyIndex >= aacFrequencyTable.length) {
    throw new Error(`AAC sampling frequency index ${frequencyIndex} can't be stored in ADTS.`);
  }
  if (channelConfiguration === 11 || channelConfiguration === 12) {
    const surroundPair = {
      isCpe: true,
      tagSelect: 1
    };
    programConfigElement = {
      elementInstanceTag: 0,
      objectType: coreObjectType - 1,
      samplingFrequencyIndex: frequencyIndex,
      frontElements: [
        {
          isCpe: false,
          tagSelect: 0
        },
        {
          isCpe: true,
          tagSelect: 0
        }
      ],
      sideElements: channelConfiguration === 12 ? [surroundPair] : [],
      backElements: channelConfiguration === 11 ? [
        surroundPair,
        {
          isCpe: false,
          tagSelect: 1
        }
      ] : [{
        isCpe: true,
        tagSelect: 2
      }],
      lfeElementTags: [0],
      assocDataElementTags: [],
      ccElements: [],
      monoMixdownElementNumber: null,
      stereoMixdownElementNumber: null,
      matrixMixdown: null,
      comment: new Uint8Array(0)
    };
    channelConfiguration = 0;
  }
  if (channelConfiguration > 7) {
    throw new Error(`AAC channel configuration ${channelConfiguration} can't be stored in ADTS.`);
  }
  if (frameLength !== 1024) {
    throw new Error(`AAC frame length ${frameLength} can't be stored in ADTS.`);
  }
  let header = new Uint8Array(7 + (programConfigElement ? getMaxPceByteLength(programConfigElement) : 0));
  const bitstream = new Bitstream(header);
  const profile = coreObjectType - 1;
  bitstream.writeBits(12, 4095);
  bitstream.writeBits(1, 0);
  bitstream.writeBits(2, 0);
  bitstream.writeBits(1, 1);
  bitstream.writeBits(2, profile);
  bitstream.writeBits(4, frequencyIndex);
  bitstream.writeBits(1, 0);
  bitstream.writeBits(3, channelConfiguration);
  bitstream.writeBits(1, 0);
  bitstream.writeBits(1, 0);
  bitstream.writeBits(1, 0);
  bitstream.writeBits(1, 0);
  bitstream.skipBits(13);
  bitstream.writeBits(11, 2047);
  bitstream.writeBits(2, 0);
  if (programConfigElement) {
    bitstream.pos = 8 * 7;
    bitstream.writeBits(3, 5);
    writeAacProgramConfigElement(bitstream, programConfigElement);
    header = header.subarray(0, bitstream.pos / 8);
  }
  return { header, bitstream };
};
var getMaxPceByteLength = (programConfigElement) => {
  return 64 + programConfigElement.comment.byteLength;
};
var writeAacProgramConfigElement = (bitstream, pce) => {
  bitstream.writeBits(4, pce.elementInstanceTag);
  bitstream.writeBits(2, pce.objectType);
  bitstream.writeBits(4, pce.samplingFrequencyIndex);
  bitstream.writeBits(4, pce.frontElements.length);
  bitstream.writeBits(4, pce.sideElements.length);
  bitstream.writeBits(4, pce.backElements.length);
  bitstream.writeBits(2, pce.lfeElementTags.length);
  bitstream.writeBits(3, pce.assocDataElementTags.length);
  bitstream.writeBits(4, pce.ccElements.length);
  bitstream.writeBits(1, +(pce.monoMixdownElementNumber !== null));
  if (pce.monoMixdownElementNumber !== null) {
    bitstream.writeBits(4, pce.monoMixdownElementNumber);
  }
  bitstream.writeBits(1, +(pce.stereoMixdownElementNumber !== null));
  if (pce.stereoMixdownElementNumber !== null) {
    bitstream.writeBits(4, pce.stereoMixdownElementNumber);
  }
  bitstream.writeBits(1, +(pce.matrixMixdown !== null));
  if (pce.matrixMixdown) {
    bitstream.writeBits(2, pce.matrixMixdown.index);
    bitstream.writeBits(1, +pce.matrixMixdown.pseudoSurroundEnabled);
  }
  for (const element of [...pce.frontElements, ...pce.sideElements, ...pce.backElements]) {
    bitstream.writeBits(1, +element.isCpe);
    bitstream.writeBits(4, element.tagSelect);
  }
  for (const tag of [...pce.lfeElementTags, ...pce.assocDataElementTags]) {
    bitstream.writeBits(4, tag);
  }
  for (const element of pce.ccElements) {
    bitstream.writeBits(1, +element.isIndependentlySwitched);
    bitstream.writeBits(4, element.tagSelect);
  }
  bitstream.pos = 8 * Math.ceil(bitstream.pos / 8);
  bitstream.writeBits(8, pce.comment.byteLength);
  bitstream.bytes.set(pce.comment, bitstream.pos / 8);
  bitstream.pos += 8 * pce.comment.byteLength;
};
var writeAdtsFrameLength = (bitstream, frameLength) => {
  if (frameLength >= 2 ** 13) {
    throw new Error(`AAC frame too large for ADTS (${frameLength} bytes, at most ${2 ** 13 - 1} allowed).`);
  }
  bitstream.pos = 30;
  bitstream.writeBits(13, frameLength);
};
var readAacProgramConfigElement = (bitstream) => {
  const elementInstanceTag = bitstream.readBits(4);
  const objectType = bitstream.readBits(2);
  const samplingFrequencyIndex = bitstream.readBits(4);
  const frontElementCount = bitstream.readBits(4);
  const sideElementCount = bitstream.readBits(4);
  const backElementCount = bitstream.readBits(4);
  const lfeElementCount = bitstream.readBits(2);
  const assocDataElementCount = bitstream.readBits(3);
  const ccElementCount = bitstream.readBits(4);
  const monoMixdownElementNumber = bitstream.readBits(1) ? bitstream.readBits(4) : null;
  const stereoMixdownElementNumber = bitstream.readBits(1) ? bitstream.readBits(4) : null;
  const matrixMixdown = bitstream.readBits(1) ? {
    index: bitstream.readBits(2),
    pseudoSurroundEnabled: !!bitstream.readBits(1)
  } : null;
  const readChannelElements = (count) => Array.from({ length: count }, () => ({
    isCpe: !!bitstream.readBits(1),
    tagSelect: bitstream.readBits(4)
  }));
  const frontElements = readChannelElements(frontElementCount);
  const sideElements = readChannelElements(sideElementCount);
  const backElements = readChannelElements(backElementCount);
  const lfeElementTags = Array.from({ length: lfeElementCount }, () => bitstream.readBits(4));
  const assocDataElementTags = Array.from({ length: assocDataElementCount }, () => bitstream.readBits(4));
  const ccElements = Array.from({ length: ccElementCount }, () => ({
    isIndependentlySwitched: !!bitstream.readBits(1),
    tagSelect: bitstream.readBits(4)
  }));
  bitstream.pos = 8 * Math.ceil(bitstream.pos / 8);
  const commentLength = bitstream.readBits(8);
  const comment = bitstream.bytes.slice(bitstream.pos / 8, bitstream.pos / 8 + commentLength);
  bitstream.pos += 8 * commentLength;
  return {
    elementInstanceTag,
    objectType,
    samplingFrequencyIndex,
    frontElements,
    sideElements,
    backElements,
    lfeElementTags,
    assocDataElementTags,
    ccElements,
    monoMixdownElementNumber,
    stereoMixdownElementNumber,
    matrixMixdown,
    comment
  };
};
var getAacProgramConfigElementChannelCount = (pce) => {
  const elements = [...pce.frontElements, ...pce.sideElements, ...pce.backElements];
  return elements.reduce((count, element) => count + (element.isCpe ? 2 : 1), pce.lfeElementTags.length);
};

// packages/aac-encoder/src/encoder.ts
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

// packages/aac-encoder/src/encode.worker.ts
var cache = {};
function Worker2() {
  return new Worker(new URL("./aac-worker.js", import.meta.url));
}

// packages/aac-encoder/src/encoder.ts
var AAC_SAMPLE_RATES = [
  96e3,
  88200,
  64e3,
  48e3,
  44100,
  32e3,
  24e3,
  22050,
  16e3,
  12e3,
  11025,
  8e3,
  7350
];
var AacEncoder = class extends CustomAudioEncoder {
  constructor() {
    super(...arguments);
    this.worker = null;
    this.workerError = null;
    this.nextMessageId = 0;
    this.pendingMessages = /* @__PURE__ */ new Map();
    this.ctx = 0;
    this.encoderFrameSize = 0;
    this.sampleRate = 0;
    this.numberOfChannels = 0;
    this.chunkMetadata = {};
    this.useAdts = false;
    this.adtsHeaderTemplate = null;
    this.description = null;
    // Accumulate interleaved f32 samples until we have a full frame
    this.pendingBuffer = new Float32Array(2 ** 16);
    this.pendingFrames = 0;
    this.nextSampleTimestampInSamples = null;
    this.inFlightEncode = null;
  }
  static supports(codec, config) {
    return codec === "aac" && config.numberOfChannels >= 1 && config.numberOfChannels <= 8 && AAC_SAMPLE_RATES.includes(config.sampleRate) && config.bitrate !== void 0;
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
        onError(new Error(event.message || "AAC encoder worker failed to load or crashed."));
      });
    } else {
      const nodeWorker = this.worker;
      nodeWorker.on("message", onMessage);
      nodeWorker.on("error", onError);
    }
    assert(this.config.bitrate !== void 0);
    this.sampleRate = this.config.sampleRate;
    this.numberOfChannels = this.config.numberOfChannels;
    const result = await this.sendCommand({
      type: "init",
      data: {
        numberOfChannels: this.config.numberOfChannels,
        sampleRate: this.config.sampleRate,
        bitrate: this.config.bitrate
      }
    });
    this.ctx = result.ctx;
    this.encoderFrameSize = result.frameSize;
    const description = new Uint8Array(result.extradata);
    const aacConfig = this.config.aac;
    this.useAdts = aacConfig?.format === "adts";
    if (this.useAdts) {
      const audioSpecificConfig = parseAacAudioSpecificConfig(description);
      this.adtsHeaderTemplate = buildAdtsHeaderTemplate(audioSpecificConfig);
    }
    this.description = this.useAdts ? null : description;
    this.resetInternalState();
  }
  resetInternalState() {
    this.pendingFrames = 0;
    this.nextSampleTimestampInSamples = null;
    this.chunkMetadata = {
      decoderConfig: {
        codec: "mp4a.40.2",
        numberOfChannels: this.config.numberOfChannels,
        sampleRate: this.config.sampleRate,
        ...this.description ? { description: this.description } : {}
      }
    };
  }
  async encode(audioSample) {
    if (this.nextSampleTimestampInSamples === null) {
      this.nextSampleTimestampInSamples = Math.round(audioSample.timestamp * this.sampleRate);
    }
    const channels = this.numberOfChannels;
    const incomingFrames = audioSample.numberOfFrames;
    const totalBytes = audioSample.allocationSize({ format: "f32", planeIndex: 0 });
    const audioBytes = new Uint8Array(totalBytes);
    audioSample.copyTo(audioBytes, { format: "f32", planeIndex: 0 });
    const incomingData = new Float32Array(audioBytes.buffer);
    const requiredSamples = (this.pendingFrames + incomingFrames) * channels;
    if (requiredSamples > this.pendingBuffer.length) {
      let newSize = this.pendingBuffer.length;
      while (newSize < requiredSamples) {
        newSize *= 2;
      }
      const newBuffer = new Float32Array(newSize);
      newBuffer.set(this.pendingBuffer.subarray(0, this.pendingFrames * channels));
      this.pendingBuffer = newBuffer;
    }
    this.pendingBuffer.set(incomingData, this.pendingFrames * channels);
    this.pendingFrames += incomingFrames;
    let encodedFrames = 0;
    while (this.pendingFrames - encodedFrames >= this.encoderFrameSize) {
      await this.encodeOneFrame(encodedFrames);
      encodedFrames += this.encoderFrameSize;
    }
    this.pendingBuffer.copyWithin(0, encodedFrames * channels, this.pendingFrames * channels);
    this.pendingFrames -= encodedFrames;
  }
  async flush() {
    if (this.pendingFrames > 0) {
      const channels = this.numberOfChannels;
      const frameSize = this.encoderFrameSize;
      const usedSamples = this.pendingFrames * channels;
      const frameSamples = frameSize * channels;
      this.pendingBuffer.fill(0, usedSamples, frameSamples);
      this.pendingFrames = 0;
      await this.encodeOneFrame(0);
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
  async encodeOneFrame(startFrame) {
    assert(this.nextSampleTimestampInSamples !== null);
    const channels = this.numberOfChannels;
    const frameData = this.pendingBuffer.slice(
      startFrame * channels,
      (startFrame + this.encoderFrameSize) * channels
    );
    const audioData = frameData.buffer;
    const encode = this.sendCommand({
      type: "encode",
      data: {
        ctx: this.ctx,
        audioData,
        timestamp: this.nextSampleTimestampInSamples
      }
    }, [audioData]).then((result) => this.emitPackets(result.packets));
    encode.catch(() => {
    });
    this.nextSampleTimestampInSamples += this.encoderFrameSize;
    const previousEncode = this.inFlightEncode;
    this.inFlightEncode = encode;
    await previousEncode;
  }
  emitPackets(packets) {
    for (const p of packets) {
      let data = new Uint8Array(p.encodedData);
      if (this.useAdts) {
        assert(this.adtsHeaderTemplate !== null);
        const { header, bitstream } = this.adtsHeaderTemplate;
        const frameLength = header.byteLength + data.byteLength;
        writeAdtsFrameLength(bitstream, frameLength);
        const adtsFrame = new Uint8Array(frameLength);
        adtsFrame.set(header, 0);
        adtsFrame.set(data, header.byteLength);
        data = adtsFrame;
      }
      const packet = new EncodedPacket(
        data,
        "key",
        p.pts / this.sampleRate,
        p.duration / this.sampleRate
      );
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
var registerAacEncoder = () => {
  if (registered) {
    return;
  }
  registered = true;
  registerEncoder(AacEncoder);
};
function assert(x) {
  if (!x) {
    throw new Error("Assertion failed.");
  }
}

// packages/aac-encoder/src/index.ts
var AAC_ENCODER_LOADED_SYMBOL = Symbol.for("@mediabunny/aac-encoder loaded");
if (globalThis[AAC_ENCODER_LOADED_SYMBOL]) {
  Logging._error(
    "[WARNING]\n@mediabunny/aac-encoder was loaded twice. This will likely cause the encoder not to work correctly. Check if multiple dependencies are importing different versions of @mediabunny/aac-encoder, or if something is being bundled incorrectly."
  );
}
globalThis[AAC_ENCODER_LOADED_SYMBOL] = true;
export {
  registerAacEncoder
};
