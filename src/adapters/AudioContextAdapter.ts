export class AudioContextAdapter {
  private ctx: AudioContext;
  private activeSources: Set<AudioBufferSourceNode> = new Set();
  private trackGains: Map<number, GainNode> = new Map();

  constructor() {
    // ※注意: ブラウザのスパム対策（Autoplay Policy）により、ユーザーが
    // 画面をクリック等の操作をするまでは 'suspended'（一時停止）状態のまま生成されます。
    this.ctx = new AudioContext();
  }

  /**
   * ブラウザのAutoplay Policyによりsuspended状態になっているものを、resumeする
   * ユーザーが「録音」や「再生」ボタンをクリックした直後など、
   * 実際に音を鳴らしたりデコードしたりする直前に必ず呼び出します。
   */
  async resumeIfNeeded(): Promise<void> {
    if (this.ctx.state === "suspended") {
      await this.ctx.resume();
    }
  }

  getCurrentTime(): number {
    return this.ctx.currentTime;
  }

  async decode(blob: Blob): Promise<AudioBuffer> {
    const arrayBuffer = await blob.arrayBuffer();
    return await this.ctx.decodeAudioData(arrayBuffer);
  }

  /**
   * 指定したトラックの音量を設定します。
   * @param trackId 音量を変更したいトラックのID
   * @param volume 音量の倍率（0.0: 無音/ミュート, 1.0: 原音そのまま, 0.5: 半分の音量, 2.0: 2倍の音量※音割れ注意）
   */
  setTrackVolume(trackId: number, volume: number): void {
    const gainNode = this.getOrCreateGainNode(trackId);
    gainNode.gain.setValueAtTime(volume, this.getCurrentTime());
  }

  play(buffer: AudioBuffer, startTime: number, trackId: number, isLoop: boolean = false): void {
    const source = this.ctx.createBufferSource();
    const gainNode = this.getOrCreateGainNode(trackId);

    source.buffer = buffer;
    source.loop = isLoop;
    source.connect(gainNode);

    this.activeSources.add(source);

    source.onended = () => {
      this.activeSources.delete(source);
    };

    source.start(startTime);
  }

  stopAndClearSources(): void {
    this.activeSources.forEach((source) => {
      try {
        source.stop();
      } catch (e) {
        // すでに止まっているノードに対するエラーを安全に無視
      }
    });

    this.activeSources.clear();
  }

  private getOrCreateGainNode(trackId: number): GainNode {
    let gainNode = this.trackGains.get(trackId);

    if (!gainNode) {
      gainNode = this.ctx.createGain();
      gainNode.connect(this.ctx.destination);
      this.trackGains.set(trackId, gainNode);
    }
    return gainNode;
  }
}
