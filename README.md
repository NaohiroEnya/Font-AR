# Font AR

Webブラウザ上で、タップした地面に文字を配置すると、その文字が現実空間に固定表示されるプロトタイプです。
8th Wallの6DoF SLAM(`XR8.XrController`)による実カメラ位置トラッキングを使っているため、iOS Safari(WebXR未対応)でもネイティブアプリなしで、奥行きを含めた空間固定ができます。

## 使い方

1. `npm install`
2. `npm run serve`
3. スマホ実機で確認する場合は[こちらの手順](https://8th.io/test-on-mobile)に従ってHTTPS経由で接続してください
4. 画面下部のテキスト欄に表示したい文字を入力し、カメラに映る地面をタップすると、その位置に文字が固定されます
5. トラッキングがずれてきたら「リセンター」ボタンで基準位置をリセットできます

## デプロイ

`main`ブランチにpushすると、GitHub Actions経由でGitHub Pagesに自動デプロイされます(`.github/workflows/deploy.yml`)。
手動でビルドする場合は `npm run build` を実行し、`dist`フォルダを任意のホスティング先に配置してください。

## 技術構成

- [three.js](https://threejs.org/) — 3Dシーンの描画
- [8th Wall Engine (Distributed Binary)](https://github.com/8thwall/engine) — SLAMによる実空間トラッキング。コンパイル済みバイナリとして`index.html`内でCDN読み込みしており、ソースは非公開
- [XRExtras](https://www.npmjs.com/package/@8thwall/xrextras) / [Landing Page](https://www.npmjs.com/package/@8thwall/landing-page) — 8th Wallのフレームワーク部分。こちらはMITライセンスでOSS化されている

## 既知の制約

- SLAM部分はコンパイル済みバイナリとして配布されており、ソースは非公開。将来のOS/ブラウザ更新で不具合が出た場合、自前での修正はできない
- 現状は無料・非収益のコンテンツとしての利用を前提としている(利用ライセンスの詳細は配布元の [LICENSE](https://github.com/8thwall/engine/blob/main/LICENSE) を参照)
