import { useEffect, useReducer, useRef } from "react";
import { ApolloManager } from "../managers/apolloManager";
import { MediaRecorderAdapter } from "../adapters/MediaRecorderAdapter";
import { AudioContextAdapter } from "../adapters/AudioContextAdapter";

/**
 * ApolloManagerをReactから使うためのカスタムフック。
 *
 * 役割はManagerの生成・購読配線・クリック音ロードという
 * 「UIと無関係な配線作業」をApp.tsxから追い出すことだけ。
 * 詳細は docs/useApollo.md を参照。
 */
export function useApollo(): ApolloManager {
  // Managerのstate変化をReactの再レンダリングに繋ぐためのダミーstate。
  const [, rerender] = useReducer((x: number) => x + 1, 0);

  const managerRef = useRef<ApolloManager | null>(null);
  if (!managerRef.current) {
    const recorder = new MediaRecorderAdapter();
    const audioCtx = new AudioContextAdapter();
    managerRef.current = new ApolloManager(recorder, audioCtx);
  }

  // 購読の配線。
  useEffect(() => {
    const manager = managerRef.current!;
    const unsubRecording = manager.subscribeRecording(rerender);
    const unsubPlayback = manager.subscribePlayback(rerender);

    // クリーンアップ: コンポーネントが画面から消えた時に購読を解除する。
    // 解除しないとManagerがrerenderへの参照を持ち続けメモリリークになる。
    return () => {
      unsubRecording();
      unsubPlayback();
    };
  }, []);

  useEffect(() => {
    managerRef.current!.loadClickSound("/click.mp3");
  }, []);

  // ManagerのインスタンスをそのままApp.tsxに渡す。
  // ラップや変換はしない。UIが必要なものは全てManagerの公開APIから取得できる。
  return managerRef.current;
}
