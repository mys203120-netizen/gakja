import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import path from "node:path";
import { replaceTranscriptAt } from "../protocol";
import { clovaStreamingConfiguration } from './speech-vocabulary';

const definition = protoLoader.loadSync(path.join(process.cwd(), "server", "clova.proto"), { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true });
const loaded = grpc.loadPackageDefinition(definition) as unknown as { com: { nbp: { cdncp: { nest: { grpc: { proto: { v1: { NestService: grpc.ServiceClientConstructor } } } } } } } };
const Service = loaded.com.nbp.cdncp.nest.grpc.proto.v1.NestService;
export interface TranscriptRevision { text: string; rawTranscript: string; position: number; revision: number; isFinal: boolean; confidence: number | null; startTimestamp: number | null; endTimestamp: number | null }
export interface SpeechStreamTransport {
  call: grpc.ClientDuplexStream<unknown, { contents: string }>;
  close: () => void;
}

function createTransport(): SpeechStreamTransport {
  const host = process.env.CLOVA_SPEECH_GRPC_HOST ?? "clovaspeech-gw.ncloud.com";
  const port = Number(process.env.CLOVA_SPEECH_GRPC_PORT ?? 50051);
  if (!/^[a-z0-9.-]+$/i.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("CLOVA Speech gRPC 주소 설정이 올바르지 않습니다.");
  const client = new Service(`${host}:${port}`, grpc.credentials.createSsl(), { "grpc.max_receive_message_length": 2 * 1024 * 1024 });
  const metadata = new grpc.Metadata();
  metadata.set("authorization", `Bearer ${process.env.CLOVA_SPEECH_SECRET_KEY ?? ""}`);
  const call = (client as unknown as grpc.Client & { recognize: (meta: grpc.Metadata) => grpc.ClientDuplexStream<unknown, { contents: string }> }).recognize(metadata);
  return { call, close: () => client.close() };
}

// Transport-only PCM padding, based on the reproduced abrupt-submit finalization
// failure. NAVER documents epFlag/seqId, not a required silence duration:
// https://api.ncloud-docs.com/docs/ai-application-service-clovaspeech-grpc
// Six 100ms frames reproduce the successful trailing-silence experiment without
// delaying submission or adding candidate speech/VAD/answer-time measurements.
const ENDPOINT_PADDING_FRAMES = 6;
const PCM_100_MS_BYTES = 3_200; // 16kHz, mono, signed 16-bit PCM.

/** One gRPC stream per answering period; pause flushes, resume opens a fresh stream. */
export class ClovaSpeechStream {
  private closeTransport: () => void;
  private call: grpc.ClientDuplexStream<unknown, { contents: string }>;
  private ready = false;
  private queue: Buffer[] = [];
  private queuedBytes = 0;
  private rawTranscript = "";
  private revision = 0;
  private finishing = false;
  private ended = false;
  private sequence = 1;
  private endpointSent = false;
  private finishResolve?: (value: string) => void;
  private finishReject?: (error: Error) => void;
  private finishPromise?: Promise<string>;
  private finishTimer?: ReturnType<typeof setTimeout>;
  private configTimer: ReturnType<typeof setTimeout>;
  constructor(private onTranscript: (result: TranscriptRevision) => void, private onError: (error: Error) => void, options: { keywords?: readonly string[] } = {}, transportFactory: () => SpeechStreamTransport = createTransport) {
    const transport = transportFactory();
    this.call = transport.call;
    this.closeTransport = transport.close;
    this.configTimer = setTimeout(() => this.fail(new Error("CLOVA Speech 설정 응답이 지연됩니다. 연결을 다시 시도해 주세요.")), 15_000);
    this.call.on("data", (message: { contents: string }) => {
      try { this.receive(JSON.parse(message.contents)); } catch (error) { this.fail(error instanceof Error ? error : new Error("CLOVA Speech 응답을 해석하지 못했습니다.")); }
    });
    this.call.on("error", (error: grpc.ServiceError) => { if (!this.ended) this.fail(new Error(`CLOVA Speech ${grpc.status[error.code] ?? error.code}: ${error.details || error.message}`)); });
    this.call.on("end", () => {
      if (!this.ended) this.fail(new Error("CLOVA Speech 연결이 최종 전사를 확정하기 전에 종료되었습니다."));
    });
    this.call.write({ type: "CONFIG", config: { config: JSON.stringify(clovaStreamingConfiguration(options.keywords)) } });
  }
  private receive(payload: { config?: { status?: string; keywordBoosting?: { status?: string } }; recognize?: { status?: string }; transcription?: { text?: string; position?: number; epFlag?: boolean; seqId?: number; confidence?: number; startTimestamp?: number; endTimestamp?: number } }) {
    if (this.ended) return;
    if (payload.config) {
      if (payload.config.status !== "Success") throw new Error(`CLOVA Speech 설정 오류: ${payload.config.status ?? "알 수 없는 응답"}`);
      if (payload.config.keywordBoosting?.status && payload.config.keywordBoosting.status !== 'Success') throw new Error('CLOVA Speech 교과 용어 설정을 적용하지 못했습니다.');
      this.ready = true;
      clearTimeout(this.configTimer);
      for (const bytes of this.queue) this.send(bytes);
      this.queue = []; this.queuedBytes = 0;
      if (this.finishing) this.sendEndpoint();
    }
    if (payload.recognize?.status && payload.recognize.status !== "Success") throw new Error(`CLOVA Speech 인식 오류: ${payload.recognize.status}`);
    const result = payload.transcription;
    if (!result || typeof result.text !== "string") return;
    const position = result.position ?? this.rawTranscript.length;
    this.rawTranscript = replaceTranscriptAt(this.rawTranscript, result.text, position);
    const final = result.epFlag === true && result.seqId === this.sequence;
    this.onTranscript({ text: result.text, rawTranscript: this.rawTranscript, position, revision: ++this.revision, isFinal: final, confidence: result.confidence ?? null, startTimestamp: result.startTimestamp ?? null, endTimestamp: result.endTimestamp ?? null });
    if (final && this.finishing) {
      this.finishResolve?.(this.rawTranscript);
      this.close();
    }
  }
  write(bytes: Buffer) {
    if (this.ended || this.finishing) return;
    if (bytes.length % 2) throw new Error("PCM 오디오는 16bit 샘플이어야 합니다.");
    if (!this.ready) {
      this.queuedBytes += bytes.length;
      if (this.queuedBytes > 32000 * 15) return this.fail(new Error("음성 연결 대기 버퍼가 가득 찼습니다. 다시 연결해 주세요."));
      this.queue.push(Buffer.from(bytes));
    } else this.send(bytes);
  }
  private send(bytes: Buffer) {
    if (!this.call.write({ type: "DATA", data: { chunk: bytes, extra_contents: JSON.stringify({ epFlag: false, seqId: 0 }) } })) {
      // gRPC retains at most this socket's bounded, small real-time audio chunks.
      if (this.call.writableLength > 32000 * 10) this.fail(new Error("음성 업로드가 지연됩니다. 연결을 다시 시도해 주세요."));
    }
  }
  private sendEndpoint() {
    if (this.endpointSent || this.ended) return;
    this.endpointSent = true;
    // Keep padding before epFlag, in the same ordered stream as candidate PCM.
    for (let index = 0; index < ENDPOINT_PADDING_FRAMES; index++) {
      this.send(Buffer.alloc(PCM_100_MS_BYTES));
      if (this.ended) return;
    }
    this.call.write({ type: "DATA", data: { chunk: Buffer.alloc(320), extra_contents: JSON.stringify({ epFlag: true, seqId: this.sequence }) } });
  }
  finish() {
    if (this.finishPromise) return this.finishPromise;
    if (this.ended) return Promise.reject(new Error("음성 연결이 종료되어 전사를 확정할 수 없습니다."));
    this.finishing = true;
    this.finishPromise = new Promise<string>((resolve, reject) => { this.finishResolve = resolve; this.finishReject = reject; });
    this.finishTimer = setTimeout(() => this.fail(new Error("최종 전사 응답이 지연됩니다. 마지막 전사를 보존했습니다. 다시 시도해 주세요.")), 15_000);
    if (this.ready) this.sendEndpoint();
    return this.finishPromise;
  }
  private fail(error: Error) {
    if (this.ended) return;
    this.finishReject?.(error);
    this.onError(error);
    this.close();
  }
  close() {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.configTimer); clearTimeout(this.finishTimer);
    this.queue = [];
    this.call.cancel(); this.closeTransport();
  }
}
