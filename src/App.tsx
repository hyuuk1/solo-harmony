import { useState, useRef } from "react";

const BEATS_PER_BLOCK = 8;
const TOTAL_BLOCKS = 4;

interface AudioBlock {
  blob: Blob | null;
}

interface Track {
  id: number;
  name: string;
  blocks: AudioBlock[];
}

function App() {
  // --- ステート管理 ---
  const [bpm, setBpm] = useState(39); // ★ デフォルトを39に設定
  const [tracks, setTracks] = useState<Track[]>(() =>
    [0, 1, 2, 3].map((id) => ({
      id,
      name: id === 3 ? "ベース" : `メロディ ${id + 1}`,
      blocks: Array.from({ length: TOTAL_BLOCKS }, () => ({ blob: null })),
    })),
  );

  const [recordingTarget, setRecordingTarget] = useState<{ trackId: number; blockIndex: number } | null>(null);
  const [isCountingIn, setIsCountingIn] = useState(false);

  // --- 計算値（BPMに依存） ---
  const secondsPerBeat = 60 / bpm;
  const secondsPerBlock = BEATS_PER_BLOCK * secondsPerBeat;

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const autoStopTimerRef = useRef<number | null>(null);

  const loadClickSound = async (ctx: AudioContext) => {
    const response = await fetch("/click.mp3");
    const arrayBuffer = await response.arrayBuffer();
    return await ctx.decodeAudioData(arrayBuffer);
  };

  const startRecording = async (trackId: number, blockIndex: number) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!audioContextRef.current) audioContextRef.current = new AudioContext();
      const ctx = audioContextRef.current;
      if (ctx.state === "suspended") await ctx.resume();

      const clickBuffer = await loadClickSound(ctx);

      setIsCountingIn(true);
      const now = ctx.currentTime;
      // カウントイン（BPMに基づいたタイミング）
      for (let i = 0; i < 4; i++) {
        const source = ctx.createBufferSource();
        source.buffer = clickBuffer;
        source.connect(ctx.destination);
        source.start(now + i * secondsPerBeat);
      }

      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => audioChunksRef.current.push(e.data);
      mediaRecorder.onstop = () => {
        const blob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        setTracks((prev) =>
          prev.map((t) => {
            if (t.id !== trackId) return t;
            const newBlocks = [...t.blocks];
            newBlocks[blockIndex] = { blob };
            return { ...t, blocks: newBlocks };
          }),
        );
        stream.getTracks().forEach((track) => track.stop());
      };

      setTimeout(
        () => {
          mediaRecorder.start();
          setRecordingTarget({ trackId, blockIndex });
          setIsCountingIn(false);

          // 現在のBPMに基づいた時間で自動停止
          autoStopTimerRef.current = window.setTimeout(() => stopRecording(), secondsPerBlock * 1000);
        },
        4 * secondsPerBeat * 1000,
      );
    } catch (error) {
      console.error(error);
      setIsCountingIn(false);
    }
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    setRecordingTarget(null);
    if (autoStopTimerRef.current) {
      clearTimeout(autoStopTimerRef.current);
      autoStopTimerRef.current = null;
    }
  };

  const playAll = async (isCanon: boolean = false) => {
    if (!audioContextRef.current) audioContextRef.current = new AudioContext();
    const ctx = audioContextRef.current;
    const startTime = ctx.currentTime + 0.1;

    tracks.forEach((track) => {
      track.blocks.forEach(async (block, blockIndex) => {
        if (!block.blob) return;

        const arrayBuffer = await block.blob.arrayBuffer();
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(ctx.destination);

        const canonDelay = isCanon && track.id < 3 ? track.id * secondsPerBlock : 0;
        const blockOffset = blockIndex * secondsPerBlock;

        if (track.id === 3 && blockIndex === 0) {
          source.loop = true;
          source.start(startTime);
        } else {
          source.start(startTime + canonDelay + blockOffset);
        }
      });
    });
  };

  return (
    <div style={{ padding: "2rem", fontFamily: "sans-serif", maxWidth: "800px", margin: "0 auto" }}>
      <h2>Canon Recorder</h2>

      {/* ★ BPMコントロールUI */}
      <div
        style={{
          marginBottom: "20px",
          padding: "15px",
          background: "#f8f9fa",
          borderRadius: "10px",
          display: "flex",
          alignItems: "center",
          gap: "15px",
        }}
      >
        <label style={{ fontWeight: "bold" }}>BPM:</label>
        <input
          type="number"
          value={bpm}
          onChange={(e) => setBpm(Number(e.target.value))}
          style={{ width: "60px", padding: "5px", fontSize: "16px" }}
        />
        <input
          type="range"
          min="30"
          max="180"
          value={bpm}
          onChange={(e) => setBpm(Number(e.target.value))}
          style={{ flex: 1 }}
        />
        <span style={{ fontSize: "14px", color: "#666" }}>
          (1拍: {secondsPerBeat.toFixed(2)}s / 1ブロック: {secondsPerBlock.toFixed(2)}s)
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {tracks.map((track) => (
          <div key={track.id} style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <div style={{ width: "120px", fontWeight: "bold" }}>{track.name}</div>
            {track.blocks.map((block, index) => {
              const isTarget = recordingTarget?.trackId === track.id && recordingTarget?.blockIndex === index;
              const hasData = block.blob !== null;
              if (track.id === 3 && index > 0) return <div key={index} style={{ width: "80px" }} />;

              return (
                <div
                  key={index}
                  style={{
                    width: "80px",
                    height: "60px",
                    border: hasData ? "2px solid #4caf50" : "1px dashed #ccc",
                    backgroundColor: isTarget ? "#ffeaa7" : hasData ? "#e8f5e9" : "#fafafa",
                    borderRadius: "8px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    position: "relative",
                  }}
                >
                  <span style={{ fontSize: "10px", color: "#888", position: "absolute", top: "2px", left: "4px" }}>
                    B{index + 1}
                  </span>
                  {isCountingIn && isTarget ? (
                    <span style={{ fontSize: "12px", color: "#f39c12", fontWeight: "bold" }}>Wait...</span>
                  ) : isTarget ? (
                    <button
                      onClick={stopRecording}
                      style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: "20px" }}
                    >
                      ⏹
                    </button>
                  ) : (
                    <button
                      onClick={() => startRecording(track.id, index)}
                      disabled={recordingTarget !== null}
                      style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: "18px" }}
                    >
                      {hasData ? "🔄" : "⏺"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div style={{ marginTop: "30px", display: "flex", gap: "10px" }}>
        <button
          onClick={() => playAll(false)}
          style={{ flex: 1, padding: "12px", borderRadius: "8px", cursor: "pointer" }}
        >
          一斉再生
        </button>
        <button
          onClick={() => playAll(true)}
          style={{
            flex: 1,
            padding: "12px",
            borderRadius: "8px",
            background: "#2ecc71",
            color: "#fff",
            border: "none",
            cursor: "pointer",
          }}
        >
          カノン再生
        </button>
      </div>

      <footer style={{ marginTop: "40px", fontSize: "11px", color: "#aaa", textAlign: "right" }}>
        Sound:{" "}
        <a
          href="https://www.springin.org/sound-stock/"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "#aaa" }}
        >
          Springin’ Sound Stock
        </a>
      </footer>
    </div>
  );
}

export default App;
