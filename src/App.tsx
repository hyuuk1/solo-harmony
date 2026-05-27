import { useState, useEffect, useMemo } from "react";
import { MediaRecorderAdapter } from "./adapters/MediaRecorderAdapter";
import { AudioContextAdapter } from "./adapters/AudioContextAdapter";
import { RecordingManager } from "./managers/RecordingManager";
import { PlaybackManager, type PlaybackTrack } from "./managers/PlaybackManager";

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

/**
 * カスタムフック: UIからオーディオロジックを完全に分離するための接着剤
 */
function useCanonEngine() {
  // 1. AdapterとManagerのインスタンスを生成し、維持する（再レンダリングで消えないようにする）
  const adapters = useMemo(() => {
    const audioCtx = new AudioContextAdapter();
    const mediaRec = new MediaRecorderAdapter();
    return { audioCtx, mediaRec };
  }, []);

  const managers = useMemo(() => {
    return {
      recorder: new RecordingManager(adapters.mediaRec, adapters.audioCtx),
      playback: new PlaybackManager(adapters.audioCtx),
    };
  }, [adapters]);

  // マウント時にクリック音を読み込んでおく
  useEffect(() => {
    managers.recorder.loadClickSound("/click.mp3");
  }, [managers.recorder]);

  return managers;
}

function App() {
  // --- カスタムフックからManagerを呼び出す ---
  const { recorder, playback } = useCanonEngine();

  // --- ステート管理 ---
  const [bpm, setBpm] = useState(39);
  const [tracks, setTracks] = useState<Track[]>(() =>
    [0, 1, 2, 3].map((id) => ({
      id,
      name: id === 3 ? "ベース" : `メロディ ${id + 1}`,
      blocks: Array.from({ length: TOTAL_BLOCKS }, () => ({ blob: null })),
    })),
  );

  const [recordingTarget, setRecordingTarget] = useState<{ trackId: number; blockIndex: number } | null>(null);
  const [isCountingIn, setIsCountingIn] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false); // 再生中のUI制御用

  // --- 計算値 ---
  const secondsPerBeat = 60 / bpm;
  const secondsPerBlock = BEATS_PER_BLOCK * secondsPerBeat;

  /**
   * 録音開始フロー（非同期のPromiseで超シンプルに！）
   */
  const handleStartRecording = async (trackId: number, blockIndex: number) => {
    setRecordingTarget({ trackId, blockIndex });
    setIsCountingIn(true);

    // カウントイン（4拍）が終わるタイミングでUIの「Wait...」を消すためのタイマー
    const countInMs = secondsPerBeat * 4 * 1000;
    const uiTimer = setTimeout(() => setIsCountingIn(false), countInMs);

    try {
      // Managerにすべてを丸投げし、Blobが返ってくるまでここで待機！
      const blob = await recorder.startRecording(bpm);

      if (blob) {
        // キャンセルされず、正常にBlobが返ってきたらStateを更新
        setTracks((prev) =>
          prev.map((t) => {
            if (t.id !== trackId) return t;
            const newBlocks = [...t.blocks];
            newBlocks[blockIndex] = { blob };
            return { ...t, blocks: newBlocks };
          }),
        );
      }
    } catch (error) {
      console.error("録音エラー:", error);
    } finally {
      // 成功・キャンセル・エラー問わず、UIを初期状態に戻す
      clearTimeout(uiTimer);
      setRecordingTarget(null);
      setIsCountingIn(false);
    }
  };

  /**
   * 録音停止
   */
  const handleStopRecording = () => {
    // isCancel = false （そこまでのデータを保存して返す）として呼び出す
    recorder.stopRecording(false);
  };

  /**
   * 再生フロー（配列を作って投げるだけ！）
   */
  const handlePlayAll = async (isCanon: boolean = false) => {
    if (isPlaying) {
      playback.stop();
      setIsPlaying(false);
      return;
    }

    // 1. ReactのState (tracks) から、PlaybackManagerが求める発注書 (PlaybackTrack[]) を作成
    const playbackTracks: PlaybackTrack[] = [];

    tracks.forEach((track) => {
      track.blocks.forEach((block, index) => {
        if (!block.blob) return;

        // ブロックの位置による遅延（8拍、16拍...）
        const blockOffsetBeats = index * BEATS_PER_BLOCK;
        // カノンによるトラックごとの遅延
        const canonDelayBeats = isCanon && track.id < 3 ? track.id * BEATS_PER_BLOCK : 0;

        playbackTracks.push({
          id: track.id,
          blob: block.blob,
          delayBeats: blockOffsetBeats + canonDelayBeats,
          isLoop: track.id === 3 && index === 0, // ベースの1ブロック目だけループ
        });
      });
    });

    if (playbackTracks.length === 0) return;

    setIsPlaying(true);
    try {
      // 2. Managerに発注書を渡して、終わるまで待つ！
      const completed = await playback.play(playbackTracks, bpm);

      if (completed) {
        setIsPlaying(false); // 自然に最後まで鳴り終わった
      }
    } catch (error) {
      console.error("再生エラー:", error);
      setIsPlaying(false);
    }
  };

  // ==========================================
  // 以下、UIの描画（JSX）はロジックが消えて驚くほどクリーンに！
  // ==========================================
  return (
    <div style={{ padding: "2rem", fontFamily: "sans-serif", maxWidth: "800px", margin: "0 auto" }}>
      <h2>Canon Recorder</h2>

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
                      onClick={handleStopRecording}
                      style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: "20px" }}
                    >
                      ⏹
                    </button>
                  ) : (
                    <button
                      onClick={() => handleStartRecording(track.id, index)}
                      disabled={recordingTarget !== null || isPlaying}
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
          onClick={() => handlePlayAll(false)}
          disabled={recordingTarget !== null}
          style={{ flex: 1, padding: "12px", borderRadius: "8px", cursor: "pointer" }}
        >
          {isPlaying ? "⏹ 停止" : "一斉再生"}
        </button>
        <button
          onClick={() => handlePlayAll(true)}
          disabled={recordingTarget !== null}
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
          {isPlaying ? "⏹ 停止" : "カノン再生"}
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
