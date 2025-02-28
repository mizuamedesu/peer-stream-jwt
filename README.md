# UE5 Pixel Streaming wit JWT

https://github.com/inveta/peer-stream/tree/main

このリポジトリはpeer-streamをフォークし、JWT Authの機能を付け加えたものです。
以下のものが変更、もしくは追加されています。

- signal.html: 最低限のプレビュー機能を残し、JWTのテストを行えるように。
- signal.js: JWTの機能を追加
- peer-stream.js: JWT送信機能を追加
- jwt-generator.html: JWTを生成する簡易ジェネレーター
- signal.json: JWTの有効を切り替えられるフラグを追加
- その他Nodeモジュールの削除、packeage.jsonの追加



## 実行方法

```
# jsonwebtoken dotenv wsが必要です
npm install i

# Signaling Serverの開始
node signal.js

# UE5の通信のみ同IPからバイパスするようになっています
start path/to/UE5.exe -PixelStreamingURL="ws://localhost:88"

```

## 環境変数のセットアップ

.envを作成し、JWT_SECRETを渡してください。

```.env
JWT_SECRET=1234
```



## signal.json

| options       | type     | default | usage                                                               |
| ------------- | -------- | ------- | ------------------------------------------------------------------- |
| PORT          | number   | 88      | WebSocket/HTTP port for player & UE5                                |
| UE5           | string[] | []      | run command when player connected (UE5 auto start)                  |
| one2one       | bool     | false   | one-to-one mapping for player & UE5                                 |
| auth          | string   | ''      | HTTP Basic Auth username:password                                   |
| boot          | bool     | false   | node signal.js on system boot                                       |
| exeUeCoolTime | number   | 60      | Time interval between starting the same UE instance again next time |
| preload       | int      | 1       | Number of pre started UE instances                                  |
|jwt-auth | bool | false | 追加したもの|


## peer-stream.js

HTML:

```html
<script src="//localhost:88/peer-stream.js"></script>
<video is="peer-stream" id="ws://localhost:88" data-token="YOUR_JWT_TOKEN"></video>
```

data-tokenというパラメーターを使用し、JWTを渡します。

## signal.js

```
	HTTP.on("upgrade", (req, socket, head) => {
		// リモートIPを取得
		let remoteIp = getIPv4(req.socket.remoteAddress);
		console.log(`[DEBUG] global.address: ${global.address}`);
		console.log(`[DEBUG] remoteIp: ${remoteIp}`);
		console.log(`[DEBUG] Protocol: ${req.headers["sec-websocket-protocol"]}`);
	
		// バイパス対象のIPを配列で指定
		const bypassIPs = [global.address, "127.0.0.1", "::1"];
		
		// プロトコルの確認
		const protocol = req.headers["sec-websocket-protocol"];
		const isUnrealConnection = protocol !== "peer-stream" && protocol !== "exec-ue";
		
		// バイパス条件: Unrealの接続（プロトコルなし）かつバイパス対象IPからの接続の場合のみ
		const shouldBypass = isUnrealConnection && bypassIPs.includes(remoteIp);
```

WebSocketのアップグレードイベントの時に認証しています。自分と同じIPかつサブプロトコルが未定義(Unrealとの通信用に使用)の場合のみデフォルトでバイパスしています。
```
const bypassIPs = [global.address, "127.0.0.1", "::1"];
```
変えたかったらここに加筆修正するとよいと思います。

## MIT License

Copyright (c) 2020-2024 Inveta
Copyright (c) 2025 mizuame

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the “Software”), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
