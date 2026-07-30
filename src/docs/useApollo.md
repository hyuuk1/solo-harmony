# useApollo

## 役割

`ApolloManager`をReactコンポーネントから使えるようにするためだけのフック。

UIの処理とは無関係な「配線作業」をまとめて隠す場所。

---

## 配線とは

ApolloManagerはただのTypeScriptクラスであり、Reactのことを知らない。
そのため、Managerのstateが変化しても**Reactは自動的に画面を更新しない**。

「Managerのstateが変わったらReactに再レンダリングを起こさせる」という接続作業が必要で、
これを配線と呼んでいる。

---

## useApolloがやること

1. **Managerを一度だけ生成して保持する**（`useRef`）
   再レンダリングのたびにManagerが作り直されないよう、`useRef`の箱に入れておく。

2. **購読を配線する**（`useEffect` + `subscribe`）
   `subscribeRecording` / `subscribePlayback` にダミーの再レンダリング関数を渡す。
   Managerがstateを変更して`notify`を呼ぶ → rerenderが発火 → Reactが画面を更新する。

3. **購読のクリーンアップ**（`useEffect`の戻り値）
   コンポーネントが画面から消えた時に購読を解除する。
   解除しないとメモリリークになる。

4. **クリック音を初期ロードする**（`useEffect`）
   マウント時に一度だけ`loadClickSound`を呼ぶ。

---

## App.tsxから見た姿

```tsx
function App() {
  const apollo = useApollo();
  // 以降は apollo.bpm / apollo.startRecording() などを呼ぶだけ
}
```

`useApollo`を呼んだ時点で、Managerの生成・配線・クリック音ロードは全て完了している。
App.tsxはUIの記述だけに集中できる。

---

## useApolloが返すもの

`ApolloManager`のインスタンスをそのまま返す。
ラップや変換はしない。

```typescript
return manager; // ApolloManagerのインスタンス
```

UIが必要なものは全てManagerの公開APIから取得できる。
フック自体がAPIを増やしたり隠したりしない。
