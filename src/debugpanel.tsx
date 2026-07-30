import { useApollo } from "./hooks/useApollo";

/**
 * useApolloの動作確認用デバッグUI。
 * ApolloManagerの全公開プロパティ・メソッドを最小限で表示・操作する。
 * 本番UIに移行したら削除してよい。
 */
export function DebugPanel() {
  const apollo = useApollo();

  // メソッド呼び出しのエラーをUIに表示するためのラッパー
  const call = (fn: () => unknown) => {
    try {
      const result = fn();
      if (result instanceof Promise) {
        result.catch((e: Error) => alert(`Error: ${e.message}`));
      }
    } catch (e) {
      alert(`Error: ${(e as Error).message}`);
    }
  };

  return (
    <div style={{ fontFamily: "monospace", padding: 24, display: "flex", flexDirection: "column", gap: 24 }}>
      {/* ── 公開State ── */}
      <section>
        <h2>Public State</h2>
        <pre>
          {JSON.stringify(
            {
              bpm: apollo.bpm,
              isPlaying: apollo.isPlaying,
              recordingState: apollo.recordingState,
            },
            null,
            2,
          )}
        </pre>
      </section>

      {/* ── BPM ── */}
      <section>
        <h2>BPM</h2>
        <input
          type="number"
          defaultValue={apollo.bpm}
          onBlur={(e) => call(() => apollo.setBpm(Number(e.target.value)))}
        />
      </section>

      {/* ── 録音操作 ── */}
      <section>
        <h2>録音（trackId=0, blockIndex=0 固定）</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => call(() => apollo.startRecording(0, 0))}>startRecording</button>
          <button onClick={() => call(() => apollo.stopRecording())}>stopRecording</button>
          <button onClick={() => call(() => apollo.cancelRecording())}>cancelRecording</button>
        </div>
      </section>

      {/* ── 再生操作 ── */}
      <section>
        <h2>再生</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => call(() => apollo.playCanon())}>playCanon</button>
          <button onClick={() => call(() => apollo.stopCanon())}>stopCanon</button>
        </div>
      </section>

      {/* ── Blob確認 ── */}
      <section>
        <h2>Blob（trackId=0, blockIndex=0）</h2>
        <pre>
          {JSON.stringify(
            {
              hasBlob: !!apollo.getBlob(0, 0),
              size: apollo.getBlob(0, 0)?.size ?? null,
            },
            null,
            2,
          )}
        </pre>
      </section>
    </div>
  );
}
