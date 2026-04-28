import { MediaRecorderAdapter } from "../adapters/MediaRecorderAdapter";
import { AudioContextAdapter } from "../adapters/AudioContextAdapter";

type RecordingState = "Idle" | "Initializing" | "Recording";

export class RecordingManager {
  private recorder: MediaRecorderAdapter;
  private audioCtx: AudioContextAdapter;

  public state: RecordingState = "Idle";
  private clickBuffer: AudioBuffer | null = null;
  private autoStopTimer: number | null = null;

  private resolveRecording: ((blob: Blob | null) => void) | null = null;
  private rejectRecording: ((error: Error) => void) | null = null;

  constructor(recorderAdapter: MediaRecorderAdapter, audioContextAdapter: AudioContextAdapter) {
    this.recorder = recorderAdapter;
    this.audioCtx = audioContextAdapter;
  }

  async loadClickSound(url: string = "/click.mp3"): Promise<void> {
    const response = await fetch(url);
    const blob = await response.blob();
    this.clickBuffer = await this.audioCtx.decode(blob);
  }

  /**
   * @returns 成功時はBlob、キャンセル時はnull、エラー時はthrow
   */
  async startRecording(bpm: number): Promise<Blob | null> {
    if (this.state !== "Idle") throw new Error("既に処理中です");
    this.state = "Initializing";

    try {
      await this.recorder.openStream();

      if (this.state !== "Initializing") {
        this.recorder.closeStream();
        return null;
      }

      await this.audioCtx.resumeIfNeeded();
      const secondsPerBeat = 60 / bpm;

      if (this.clickBuffer) {
        const now = this.audioCtx.getCurrentTime();
        for (let i = 0; i < 4; i++) {
          this.audioCtx.play(this.clickBuffer, now + i * secondsPerBeat, -1);
        }
      }

      await new Promise((resolve) => setTimeout(resolve, secondsPerBeat * 4 * 1000));

      if (this.state !== "Initializing") {
        this.recorder.closeStream();
        return null;
      }

      this.recorder.start();
      this.state = "Recording";

      return new Promise<Blob | null>((resolve, reject) => {
        this.resolveRecording = resolve;
        this.rejectRecording = reject;

        this.autoStopTimer = window.setTimeout(
          () => {
            this.stopRecording();
          },
          secondsPerBeat * 8 * 1000,
        );
      });
    } catch (error) {
      this.state = "Idle";
      this.recorder.closeStream();
      throw error;
    }
  }

  /**
   * 録音停止
   * @param isCancel true の場合、録音されたデータを破棄して null を返します（やり直し用）
   */
  async stopRecording(isCancel: boolean = false): Promise<void> {
    if (this.state === "Idle") return;

    if (this.state === "Initializing") {
      this.state = "Idle";
      if (this.resolveRecording) {
        this.resolveRecording(null);
        this.resolveRecording = null;
        this.rejectRecording = null;
      }
      return;
    }

    // 【録音中の正常停止処理】
    if (this.autoStopTimer) {
      clearTimeout(this.autoStopTimer);
      this.autoStopTimer = null;
    }

    try {
      const blob = await this.recorder.stopAndCloseStream();
      this.state = "Idle";

      if (this.resolveRecording) {
        this.resolveRecording(isCancel ? null : blob);
        this.resolveRecording = null;
        this.rejectRecording = null;
      }
    } catch (error) {
      this.state = "Idle";
      if (this.rejectRecording) {
        this.rejectRecording(error as Error);
      }
    }
  }
}
