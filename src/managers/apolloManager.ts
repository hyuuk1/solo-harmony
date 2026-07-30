import { MediaRecorderAdapter } from "../adapters/MediaRecorderAdapter";
import { AudioContextAdapter } from "../adapters/AudioContextAdapter";

// ================================================================
// 型定義
// ================================================================

type RecordingPhase = "Idle" | "Initializing" | "Recording";

export type RecordingState = {
  phase: RecordingPhase;
  /** 録音対象。Idle時はnull */
  target: { trackId: number; blockIndex: number } | null;
};

// ================================================================
// ApolloManager
//
// メソッドは以下の3層に分類し、この順番でクラス内に並べる。
//
// ① 状態変更層（private）
//    state変更 + notify が常に一体化。直接代入は行わず、必ずこれを使う。
//    → 「stateだけ変更してnotifyしない」メソッドは存在しない。
//
// ② UI操作層（public）
//    UIから直接呼ばれる。内部では①を通じてstateを変更する。
//
// ③ その他ヘルパー層（private）
//    直接state変更せず、①を呼ぶことで間接的にstate変更する。
// ================================================================

export class ApolloManager {
  // --- 依存 ---
  private recorder: MediaRecorderAdapter;
  private audioCtx: AudioContextAdapter;

  // --- 定数 ---
  private readonly BEATS_PER_BLOCK = 8;
  private readonly COUNT_IN_BEATS = 4;
  private readonly BASS_TRACK_ID = 3;

  // --- 公開State ---
  // 直接代入禁止。①（_setRecordingState / _setIsPlaying）経由でのみ変更する。
  recordingState: RecordingState = { phase: "Idle", target: null };
  isPlaying: boolean = false;
  bpm: number = 120;

  // --- 録音用内部State ---
  private blobs = new Map<string, Blob>(); // key: `${trackId}-${blockIndex}`
  private recordingSubscribers = new Set<() => void>();
  private playbackSubscribers = new Set<() => void>();
  private clickBuffer: AudioBuffer | null = null;
  private autoStopTimer: number | null = null;
  /** Recording phaseに入ってからセットされる。Initializing中はnull。 */
  private resolveRecording: ((blob: Blob | null) => void) | null = null;
  private rejectRecording: ((error: Error) => void) | null = null;

  // --- 再生用内部State ---
  private completionTimer: number | null = null;
  private resolvePlayback: (() => void) | null = null;

  constructor(recorder: MediaRecorderAdapter, audioCtx: AudioContextAdapter) {
    this.recorder = recorder;
    this.audioCtx = audioCtx;
  }

  // ================================================================
  // ① 状態変更層
  // ================================================================

  private _setRecordingState(newState: RecordingState): void {
    this.recordingState = newState;
    this._notifyRecording();
  }

  private _setIsPlaying(value: boolean): void {
    this.isPlaying = value;
    this._notifyPlayback();
  }

  // ================================================================
  // ② UI操作層
  // ================================================================

  // --- セットアップ ---

  async loadClickSound(url: string = "/click.mp3"): Promise<void> {
    const response = await fetch(url);
    const blob = await response.blob();
    this.clickBuffer = await this.audioCtx.decode(blob);
  }

  /**
   * BPMを更新する。bpmプロパティはこのメソッド経由でのみ変更される。
   * BPM変更は「これまでの録音データを無効化する」というドメイン判断を含むため、
   * 内部で_clearAllBlobsまで責務を持つ。
   */
  setBpm(bpm: number): void {
    if (this.recordingState.phase !== "Idle") throw new Error("録音中はBPMを変更できません");
    if (this.isPlaying) throw new Error("再生中はBPMを変更できません");
    if (bpm === this.bpm) return;
    this.bpm = bpm;
    this._clearAllBlobs(); // _clearAllBlobs内部で_notifyRecordingされる
  }

  // --- 購読 ---

  /** 戻り値はアンサブスクライブ関数 */
  subscribeRecording(callback: () => void): () => void {
    this.recordingSubscribers.add(callback);
    return () => this.recordingSubscribers.delete(callback);
  }

  /** 戻り値はアンサブスクライブ関数 */
  subscribePlayback(callback: () => void): () => void {
    this.playbackSubscribers.add(callback);
    return () => this.playbackSubscribers.delete(callback);
  }

  // --- 録音ライフサイクル ---
  // startRecording / stopRecording / cancelRecording は _ashesToAshes とセットで理解する。
  //
  // startRecording() ─→ Initializing（カウントイン）─→ Recording（録音中）
  // stopRecording()  ─→ Blob保存 → Idle
  // cancelRecording() ─→ Blob破棄 → Idle

  async startRecording(trackId: number, blockIndex: number): Promise<void> {
    if (this.recordingState.phase !== "Idle") throw new Error("既に録音処理中です");
    if (this.isPlaying) throw new Error("再生中は録音できません");

    this._setRecordingState({ phase: "Initializing", target: { trackId, blockIndex } });

    try {
      await this.recorder.openStream();

      // awaitをまたいでphaseが外部から変更されうるため、型アサーションでナローイングを防ぐ
      if ((this.recordingState.phase as RecordingPhase) !== "Initializing") {
        this.recorder.closeStream();
        return;
      }

      await this.audioCtx.resumeIfNeeded();
      const secondsPerBeat = 60 / this.bpm;

      // カウントイン（COUNT_IN_BEATS拍）
      if (this.clickBuffer) {
        const now = this.audioCtx.getCurrentTime();
        for (let i = 0; i < this.COUNT_IN_BEATS; i++) {
          this.audioCtx.play(this.clickBuffer, now + i * secondsPerBeat, -1);
        }
      }

      await new Promise<void>((resolve) => setTimeout(resolve, secondsPerBeat * this.COUNT_IN_BEATS * 1000));

      // awaitをまたいでphaseが外部から変更されうるため、型アサーションでナローイングを防ぐ
      if ((this.recordingState.phase as RecordingPhase) !== "Initializing") {
        this.recorder.closeStream();
        return;
      }

      this.recorder.start();
      this._setRecordingState({ phase: "Recording", target: { trackId, blockIndex } });

      // resolveRecordingはここで初めてセットされる。Initializing中はnull。
      const blob = await new Promise<Blob | null>((resolve, reject) => {
        this.resolveRecording = resolve;
        this.rejectRecording = reject;

        // BEATS_PER_BLOCK拍後に自動停止
        this.autoStopTimer = window.setTimeout(
          () => {
            this.stopRecording();
          },
          secondsPerBeat * this.BEATS_PER_BLOCK * 1000,
        );
      });

      /*blobの中身はcancelRecordingなら_ashesToAshesがshouldSave==falseで実行されresolve(null),
      stopRecordingならshouldSave==trueでresolve(blob)が実行され,
      _ashesToAshes側でrecorderからblobを受け取りresolve経由でこちらに渡される。
      */
      if (blob) {
        this.blobs.set(`${trackId}-${blockIndex}`, blob);
      }

      this._setRecordingState({ phase: "Idle", target: null });
    } catch (error) {
      this._setRecordingState({ phase: "Idle", target: null });
      this.recorder.closeStream();
      throw error;
    }
  }

  stopRecording(): Promise<void> {
    if (this.recordingState.phase === "Idle") throw new Error("録音中ではありません");
    return this._ashesToAshes(true);
  }

  cancelRecording(): Promise<void> {
    if (this.recordingState.phase === "Idle") throw new Error("録音中ではありません");
    return this._ashesToAshes(false);
  }

  // --- 再生ライフサイクル ---
  // playCanon / stopCanon はセットで理解する。
  //
  // playCanon() ─→ Blobをデコード → カノンスケジューリング → isPlaying=true
  // stopCanon() ─→ 全AudioNode停止 → isPlaying=false

  async playCanon(): Promise<void> {
    if (this.recordingState.phase !== "Idle") throw new Error("録音中は再生できません");
    if (this.isPlaying) throw new Error("既に再生中です");

    await this.audioCtx.resumeIfNeeded();
    this._setIsPlaying(true);

    try {
      const secondsPerBeat = 60 / this.bpm;
      const blockDuration = this.BEATS_PER_BLOCK * secondsPerBeat;
      const baseStartTime = this.audioCtx.getCurrentTime() + 0.05;
      let maxEndTime = baseStartTime;

      // 全BlobをエントリとBufferのペアにデコード
      const entries = [...this.blobs.entries()].map(([key, blob]) => {
        const [trackIdStr, blockIndexStr] = key.split("-");
        return { trackId: Number(trackIdStr), blockIndex: Number(blockIndexStr), blob };
      });

      const decoded = await Promise.all(
        entries.map(async (entry) => ({
          ...entry,
          buffer: await this.audioCtx.decode(entry.blob),
        })),
      );

      // デコード中にstopCanon()が呼ばれた場合は何もせず終了
      if (!this.isPlaying) return;

      decoded.forEach(({ trackId, blockIndex, buffer }) => {
        if (trackId === this.BASS_TRACK_ID) {
          // ベーストラック: block 0のみループ再生
          if (blockIndex === 0) {
            this.audioCtx.play(buffer, baseStartTime, trackId, true);
          }
        } else {
          // メロディトラック: カノン遅延（trackId × BEATS_PER_BLOCK拍）+ ブロック順再生
          const delaySeconds = trackId * this.BEATS_PER_BLOCK * secondsPerBeat;
          const startTime = baseStartTime + delaySeconds + blockIndex * blockDuration;
          this.audioCtx.play(buffer, startTime, trackId, false);

          const endTime = startTime + buffer.duration;
          if (endTime > maxEndTime) maxEndTime = endTime;
        }
      });

      // 全非ループトラックの再生完了を待つ
      await new Promise<void>((resolve) => {
        this.resolvePlayback = resolve;
        const waitTime = maxEndTime - this.audioCtx.getCurrentTime();

        this.completionTimer = window.setTimeout(() => {
          this.audioCtx.stopAndClearSources();
          this._setIsPlaying(false);
          this.resolvePlayback?.();
          this.resolvePlayback = null;
          this.completionTimer = null;
        }, waitTime * 1000);
      });
    } catch (error) {
      this.audioCtx.stopAndClearSources();
      this._setIsPlaying(false);
      throw error;
    }
  }

  stopCanon(): void {
    if (!this.isPlaying) throw new Error("再生中ではありません");

    if (this.completionTimer !== null) {
      clearTimeout(this.completionTimer);
      this.completionTimer = null;
    }

    this.audioCtx.stopAndClearSources();
    this._setIsPlaying(false);

    this.resolvePlayback?.();
    this.resolvePlayback = null;
  }

  // --- Blob取得 ---

  getBlob(trackId: number, blockIndex: number): Blob | null {
    return this.blobs.get(`${trackId}-${blockIndex}`) ?? null;
  }

  // ================================================================
  // ③ その他ヘルパー層
  // ================================================================

  // stopRecording / cancelRecording / autoStopTimer（stopRecording経由）の共通処理。
  // shouldSave=true → Blobを保存して正常終了
  // shouldSave=false → Blobを破棄してキャンセル
  private async _ashesToAshes(shouldSave: boolean): Promise<void> {
    if (this.recordingState.phase === "Idle") return;

    if (this.recordingState.phase === "Initializing") {
      // Initializing中: Promiseがまだ生成されていないためresolveRecordingは操作しない。
      // _setRecordingStateでphaseをIdleにすることで、startRecording側の
      // 各awaitポイント後のチェック（if phase !== "Initializing"）が脱出条件を満たす。
      this._setRecordingState({ phase: "Idle", target: null });
      return;
    }

    // Recording中: タイマーをキャンセルしてMediaRecorderを停止する
    if (this.autoStopTimer !== null) {
      clearTimeout(this.autoStopTimer);
      this.autoStopTimer = null;
    }

    try {
      const blob = await this.recorder.stopAndCloseStream();
      this.resolveRecording?.(shouldSave ? blob : null);
    } catch (error) {
      this.rejectRecording?.(error as Error);
    } finally {
      this.resolveRecording = null;
      this.rejectRecording = null;
    }
  }

  // BlobをMapごとクリアしUIに通知する。setBpm内部からのみ呼ばれる。
  //
  // 将来「全部やり直す」ボタンなどUIから直接Blobを破棄させたい場合は
  // このメソッドをpublicにするだけで対応できる。
  private _clearAllBlobs(): void {
    this.blobs.clear();
    this._notifyRecording();
  }

  // 以下2つは①（_setRecordingState / _setIsPlaying）の内部からのみ呼ぶ。
  // クラス内の他の場所から直接呼び出さないこと。

  private _notifyRecording(): void {
    this.recordingSubscribers.forEach((cb) => cb());
  }

  private _notifyPlayback(): void {
    this.playbackSubscribers.forEach((cb) => cb());
  }
}
