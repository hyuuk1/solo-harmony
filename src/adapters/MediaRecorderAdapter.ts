export class MediaRecorderAdapter {
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private stream: MediaStream | null = null;

  async openStream(): Promise<void> {
    // 既に開いている場合は何もしない（安全対策）
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  }

  start(): void {
    if (!this.stream) {
      throw new Error("マイクが開かれていません。先に openStream() を呼んでください。");
    }

    this.mediaRecorder = new MediaRecorder(this.stream);
    this.audioChunks = [];

    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        this.audioChunks.push(e.data);
      }
    };

    this.mediaRecorder.start();
  }

  /**
   *Blobを一塊にして返すと同時にストリームを閉じます
   */
  stopAndCloseStream(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      if (!this.mediaRecorder || this.mediaRecorder.state === "inactive") {
        reject(new Error("録音が開始されていません。"));
        return;
      }

      this.mediaRecorder.onstop = () => {
        const blob = new Blob(this.audioChunks, { type: "audio/webm" });

        this.closeStream();
        this.mediaRecorder = null;

        resolve(blob);
      };

      this.mediaRecorder.stop();
    });
  }

  /**
   * キャンセル時やエラー時に手動でマイクを解放するための安全装置
   */
  closeStream(): void {
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
  }
}
