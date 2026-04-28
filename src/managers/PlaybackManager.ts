import { AudioContextAdapter } from "../adapters/AudioContextAdapter";

export interface PlaybackTrack {
  id: number;
  blob: Blob;
  delayBeats: number;
  volume?: number;
  isLoop?: boolean;
}

export class PlaybackManager {
  private audioCtx: AudioContextAdapter;
  public isPlaying: boolean = false;
  private completionTimer: number | null = null;
  private bufferCache: Map<Blob, AudioBuffer> = new Map();

  private resolvePlayback: ((completed: boolean) => void) | null = null;

  constructor(audioContextAdapter: AudioContextAdapter) {
    this.audioCtx = audioContextAdapter;
  }

  /**
   * @returns 最後まで再生されたら true、途中で停止されたら false
   */
  async play(tracks: PlaybackTrack[], bpm: number): Promise<boolean> {
    if (this.isPlaying) throw new Error("既に再生中です");
    this.isPlaying = true;

    try {
      await this.audioCtx.resumeIfNeeded();

      const decodedBuffers = await Promise.all(
        tracks.map(async (track) => {
          if (this.bufferCache.has(track.blob)) return this.bufferCache.get(track.blob)!;
          const buffer = await this.audioCtx.decode(track.blob);
          this.bufferCache.set(track.blob, buffer);
          return buffer;
        }),
      );

      if (!this.isPlaying) {
        return false;
      }

      const secondsPerBeat = 60 / bpm;
      const baseStartTime = this.audioCtx.getCurrentTime() + 0.05;
      let maxEndTime = 0;

      tracks.forEach((track, index) => {
        const buffer = decodedBuffers[index];
        const delaySeconds = track.delayBeats * secondsPerBeat;
        const trackStartTime = baseStartTime + delaySeconds;

        if (track.volume !== undefined) {
          this.audioCtx.setTrackVolume(track.id, track.volume);
        }

        this.audioCtx.play(buffer, trackStartTime, track.id, track.isLoop || false);

        // 曲の終了時刻を計算（ループ曲であっても「1周目が終わる時間」として計算させておく）
        const trackEndTime = trackStartTime + buffer.duration;
        if (trackEndTime > maxEndTime) {
          maxEndTime = trackEndTime;
        }
      });

      // ここで処理を一時停止し、Promiseを返す
      // 呼び出し元がawaitしていた場合、resolveされるまで処理が止まる
      return new Promise<boolean>((resolve) => {
        this.resolvePlayback = resolve;
        const waitTimeSeconds = maxEndTime - this.audioCtx.getCurrentTime();

        this.completionTimer = window.setTimeout(() => {
          if (this.isPlaying) {
            this.isPlaying = false;

            this.audioCtx.stopAndClearSources();

            if (this.resolvePlayback) {
              this.resolvePlayback(true);
              this.resolvePlayback = null;
            }
          }
        }, waitTimeSeconds * 1000);
      });
    } catch (error) {
      this.isPlaying = false;
      this.audioCtx.stopAndClearSources();
      throw error;
    }
  }

  /**
   * 手動で再生を停止する
   */
  stop(): void {
    if (!this.isPlaying) return;

    if (this.completionTimer) {
      clearTimeout(this.completionTimer);
      this.completionTimer = null;
    }

    this.audioCtx.stopAndClearSources();
    this.isPlaying = false;

    if (this.resolvePlayback) {
      this.resolvePlayback(false);
      this.resolvePlayback = null;
    }
  }

  setVolume(trackId: number, volume: number): void {
    this.audioCtx.setTrackVolume(trackId, volume);
  }
}
