# ApolloManager 仕様書

## 状態定義

```typescript
type RecordingPhase = "Idle" | "Initializing" | "Recording";

type RecordingState = {
  phase: RecordingPhase;
  target: { trackId: number; blockIndex: number } | null; // Idle時はnull
};
```

---

## 定数（クラス内に保持）

| 定数              | 値  | 説明                             |
| ----------------- | --- | -------------------------------- |
| `BEATS_PER_BLOCK` | `8` | 1ブロックあたりの拍数（= 2小節） |
| `COUNT_IN_BEATS`  | `4` | カウントインの拍数               |

---

## 内部プロパティ

| プロパティ             | 型                                       | 説明                                                                          |
| ---------------------- | ---------------------------------------- | ----------------------------------------------------------------------------- |
| `recorder`             | `MediaRecorderAdapter`                   | マイク録音の操作                                                              |
| `audioCtx`             | `AudioContextAdapter`                    | AudioContext操作・再生                                                        |
| `blobs`                | `Map<string, Blob>`                      | 録音済みBlobの保管場所。キー: `` `${trackId}-${blockIndex}` ``                |
| `recordingSubscribers` | `Set<() => void>`                        | 録音state変化の購読者                                                         |
| `playbackSubscribers`  | `Set<() => void>`                        | 再生state変化の購読者                                                         |
| `clickBuffer`          | `AudioBuffer \| null`                    | カウントイン音のバッファ                                                      |
| `autoStopTimer`        | `number \| null`                         | 8拍後の自動停止タイマー                                                       |
| `resolveRecording`     | `((blob: Blob \| null) => void) \| null` | Recording phaseに入ってからセットされるPromiseのresolve。Initializing中はnull |
| `rejectRecording`      | `((error: Error) => void) \| null`       | 同上のreject                                                                  |
| `activeNodes`          | `AudioBufferSourceNode[]`                | 再生中のAudioNodeリスト。stopCanon()で一括停止するために保持                  |

---

## 公開State

| プロパティ       | 型               | 説明                                    |
| ---------------- | ---------------- | --------------------------------------- |
| `recordingState` | `RecordingState` | 録音の現在状態                          |
| `isPlaying`      | `boolean`        | カノン再生中かどうか                    |
| `bpm`            | `number`         | 現在のBPM。`setBpm`経由でのみ変更される |

---

## クラス全体の構成方針

メソッドは以下の3層に分類し、クラス内にこの順番で並べる。
実装時はコメントでセクションを区切ること（例: `// ==== ① 状態変更層 ====`）。

```
① 状態変更層（state変更 + notifyが常に一体化。これ単体ではpublicに公開しない）
   _setRecordingState(newState)
   _setIsPlaying(value)
   → 「stateだけ変更してnotifyしない」というメソッドは作らない。
     状態を変える唯一の入口として、変更とnotifyを必ずセットで提供する。

② UI操作層（①を呼び出す。public、UIから直接呼ばれる）
   setBpm
   startRecording / stopRecording / cancelRecording
   playCanon / stopCanon
   getBlob
   subscribeRecording / subscribePlayback
   loadClickSound
   ※ setBpmは「状態変更を伴うがstart○○系のライフサイクルには属さない」例外として
     この層に置く。

③ その他ヘルパー層（private。状態変更を伴わない、または①を内部から呼ぶだけ）
   _ashesToAshes       （直接state変更せず、①を呼ぶことで間接的にstate変更する）
   _clearAllBlobs       （setBpmからのみ呼ばれる）
   _notifyRecording / _notifyPlayback （①の内部からのみ呼ばれる。直接呼び出し禁止）
```

---

## ① 状態変更層

### `_setRecordingState(newState: RecordingState): void` ［private］

`recordingState`を更新し`_notifyRecording()`を呼ぶ。
`recordingState`への直接代入はクラス内のどこからも行わない。状態を変える唯一の入口。

### `_setIsPlaying(value: boolean): void` ［private］

`isPlaying`を更新し`_notifyPlayback()`を呼ぶ。
`isPlaying`への直接代入はクラス内のどこからも行わない。状態を変える唯一の入口。

---

## ② UI操作層

### `loadClickSound(url?: string): Promise<void>`

カウントイン音をデコードして`clickBuffer`に保存する。
デフォルトURLは`"/click.mp3"`。
`startRecording`より前に呼ぶ想定。

### `setBpm(bpm: number): void`

BPMを更新する。`bpm`プロパティはこのメソッド経由でのみ変更される。

| 現在のstate                                  | 挙動                                                                                                        |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `recordingState.phase !== "Idle"`            | `throw new Error("録音中はBPMを変更できません")`                                                            |
| `isPlaying === true`                         | `throw new Error("再生中はBPMを変更できません")`                                                            |
| 上記以外 かつ `bpm === this.bpm`（変化なし） | 何もしない                                                                                                  |
| 上記以外 かつ `bpm !== this.bpm`             | `this.bpm = bpm` → `_clearAllBlobs()`を呼びBlobを全破棄（`_clearAllBlobs`内部で`_notifyRecording()`される） |

BPM変更は「これまでの録音データを無効化する」というドメイン判断を含むため、`setBpm`内で`_clearAllBlobs`まで責務を持つ。

---

### 購読

#### `subscribeRecording(callback) / subscribePlayback(callback)`

stateが変化した際に呼ばれるコールバックを登録する。
戻り値はアンサブスクライブ関数。

```
subscribeRecording → recordingStateが変化した時に通知（_setRecordingState経由）
subscribePlayback  → isPlayingが変化した時に通知（_setIsPlaying経由）
```

---

### 録音ライフサイクル

`startRecording` / `stopRecording` / `cancelRecording` / `_ashesToAshes`はセットで理解する。

```
[呼び出し元]          [ApolloManager内部]
startRecording() ─→ Initializing（カウントイン）
                           ↓
                     Recording（録音中）
                           ↓
stopRecording()  ─→ Blob保存 → Idle
cancelRecording() ─→ Blob破棄 → Idle
```

#### `startRecording(trackId, blockIndex): Promise<void>`

| 現在のstate                                                  | 挙動                                                                        |
| ------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `recordingState.phase === "Idle"` かつ `isPlaying === false` | 正常処理。Initializing → Recording → Idle と遷移し、完了BlobをMapに保存する |
| `recordingState.phase !== "Idle"`                            | `throw new Error("既に録音処理中です")`                                     |
| `isPlaying === true`                                         | `throw new Error("再生中は録音できません")`                                 |

正常処理の内部フロー（BPMは内部の`this.bpm`を参照する。state変更は全て`_setRecordingState`経由）:

```
1. _setRecordingState({ phase: "Initializing", target: { trackId, blockIndex } })
2. マイクストリームを開く（openStream）
3. カウントイン4拍（clickBufferを4回スケジュール再生 + 4拍分wait）
4. ※ await中にcancelRecording()が来た場合: _ashesToAshes経由でphaseがIdleになっているため
   「phase !== "Initializing"」チェックで脱出 → closeStream → return
5. recorder.start()
6. _setRecordingState({ phase: "Recording", target: { trackId, blockIndex } })
7. Promiseを生成しresolveRecording/rejectRecordingをセット
8. autoStopTimerを仕掛ける（8拍後にstopRecording()を呼ぶ）
9. Promiseのresolveを待つ（stopRecording or cancelRecording or タイマーが解決する）
10. blob != null → Map.set(`${trackId}-${blockIndex}`, blob)
11. _setRecordingState({ phase: "Idle", target: null })
```

#### `stopRecording()` / `cancelRecording()`

| 現在のstate                | 挙動                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| `phase === "Idle"`         | `throw new Error("録音中ではありません")`                                                             |
| `phase === "Initializing"` | `_ashesToAshes`に委譲。カウントインを中断しIdleへ。Blobは生成されないため保存なし                     |
| `phase === "Recording"`    | `_ashesToAshes`に委譲。録音停止。`stopRecording`はBlobを保存、`cancelRecording`はBlobを破棄してIdleへ |

2つの違いは`_ashesToAshes`に渡す`shouldSave`フラグのみ。

---

### 再生ライフサイクル

`playCanon` / `stopCanon`はセットで理解する。

```
[呼び出し元]       [ApolloManager内部]
playCanon()    ─→ Blobをデコード → カノンスケジューリング → isPlaying=true
stopCanon()    ─→ 全AudioNode停止 → isPlaying=false
```

#### `playCanon(): Promise<void>`

| 現在のstate                                                  | 挙動                                        |
| ------------------------------------------------------------ | ------------------------------------------- |
| `recordingState.phase !== "Idle"`                            | `throw new Error("録音中は再生できません")` |
| `isPlaying === true`                                         | `throw new Error("既に再生中です")`         |
| `recordingState.phase === "Idle"` かつ `isPlaying === false` | 正常処理                                    |

正常処理の内部フロー（BPMは内部の`this.bpm`を参照する。state変更は全て`_setIsPlaying`経由）:

```
1. _setIsPlaying(true)
2. 全BlobをAudioBufferにデコード
3. カノン遅延（trackId × BEATS_PER_BLOCK拍）でそれぞれをスケジュール再生
4. ベーストラック（trackId === 3）はblock 0のみをループ再生
5. 再生ノードをactiveNodesに保持
6. 全再生終了時: _setIsPlaying(false)
```

#### `stopCanon(): void`

| 現在のstate           | 挙動                                                             |
| --------------------- | ---------------------------------------------------------------- |
| `isPlaying === false` | `throw new Error("再生中ではありません")`                        |
| `isPlaying === true`  | `activeNodes`の全ノードを即時停止・破棄 → `_setIsPlaying(false)` |

---

### Blob取得

#### `getBlob(trackId, blockIndex): Blob | null`

Mapから該当Blobを返す。未録音の場合は`null`。

---

## ③ その他ヘルパー層

### `_ashesToAshes(shouldSave: boolean): Promise<void>` ［private］

`stopRecording` / `cancelRecording` / `autoStopTimer`（`stopRecording`経由）の共通処理。
state変更が必要な箇所では`_setRecordingState`を呼ぶ（直接代入はしない）。

| 現在のphase      | 処理                                                                                                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `"Idle"`         | 即return（throwしない。内部呼び出しのため）                                                                                                                                                                                                            |
| `"Initializing"` | `_setRecordingState({ phase: "Idle", target: null })`。Promiseがまだ生成されていないため`resolveRecording`は操作しない。`startRecording`側の各awaitポイント後のチェックが脱出を検知する                                                                |
| `"Recording"`    | autoStopTimerをclear → `recorder.stopAndCloseStream()`でBlobを取得 → `shouldSave=true`なら`resolveRecording(blob)`、falseなら`resolveRecording(null)`。`startRecording`側でblobの有無に応じてMap保存と`_setRecordingState`によるIdleへの遷移が行われる |

### `_clearAllBlobs(): void` ［private］

MapをクリアしBlobを全削除する。`setBpm`内部からのみ呼ばれる。
`_notifyRecording()`を呼んでUIに変化を通知する。

> 将来「全部やり直す」ボタンなどUIから直接Blobを破棄させたい機能を作るなら、
> このメソッドを`public`にするだけで対応できる。

### `_notifyRecording() / _notifyPlayback()` ［private］

それぞれの購読者Setに登録された全cbを呼ぶ。
`_setRecordingState` / `_setIsPlaying`の内部からのみ呼ばれる。クラス内の他の場所から直接呼び出さない。

---

## 参考: AudioContextAdapterの関連仕様

ApolloManagerが依存するAudioContextAdapterの挙動のうち、コードを読む際に前提知識として必要なものを記載する。

### GainNodeによるトラック別音量管理

`AudioContextAdapter`はトラックごとに`GainNode`を内部の`Map<number, GainNode>`で管理する。
`play(buffer, startTime, trackId, isLoop)`を呼ぶと、`trackId`をキーに`GainNode`が取得または生成され、
AudioNodeはそのGainNodeを経由して`AudioContext.destination`に接続される。

```
AudioBufferSourceNode → GainNode(trackId) → AudioContext.destination
```

`setTrackVolume(trackId, volume)`はこのGainNodeのgainを変更することで音量を制御する。

### クリック音のtrackId

クリック音は音量個別制御が不要なため、メロディ・ベースとは衝突しない`-1`を`trackId`として渡している。
コード上では定数として定義しており、名前と付随するコメントで意図を確認できる。

### activeSources管理とstopAndClearSources

`AudioContextAdapter`は再生中の全`AudioBufferSourceNode`を内部の`Set<AudioBufferSourceNode>`で保持する。
`stopAndClearSources()`を呼ぶと全ノードを即時停止してSetをクリアする。

ApolloManagerはこの機構に乗っかっており、`stopCanon()`や`playCanon()`のエラー時には
`audioCtx.stopAndClearSources()`を呼ぶだけで全再生が止まる。
ApolloManager自身がノードのリストを持つ必要はない。

### ブラウザのAutoplay Policy対応

`AudioContext`はブラウザのAutoplay Policyにより、ユーザー操作前は`suspended`状態で生成される。
`resumeIfNeeded()`はこの状態を解除するもので、実際に音を鳴らす直前（`startRecording`・`playCanon`の冒頭）に呼んでいる。
