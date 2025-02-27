"5.1.3";

// JWT認証用に必要なパッケージをインストールしてください
// npm install jsonwebtoken dotenv
const jwt = require('jsonwebtoken');
require('dotenv').config();

Object.assign(global, require("./signal.json"));

const fs = require('fs')
const child_process = require('child_process')

////////////////////////////////// 2024年6月 削除 !!!!
if (global.env) {
	const signal = {
		//  env: false,
		PORT: +process.env.PORT,
		auth: process.env.auth,
		one2one: process.env.one2one,
		preload: +process.env.preload,
		exeUeCoolTime: +process.env.exeUeCoolTime,
		UEVersion: +process.env.UEVersion,
		UE5: Object.entries(process.env).filter(
			(([key]) => key.startsWith("UE5_")).map(([key, value]) => value)
		),
	};
	fs.promises.writeFile("./signal.json", JSON.stringify(signal));
	Object.assign(global, signal);
	// fs.promises.rm('./.signal.js');
}
////////////////////////////////// 2024年6月 削除 !!!!

const { Server } = require("ws");

G_StartUe5Pool = [];
global.InitUe5Pool = function () {
	G_StartUe5Pool = [];
	for (const key in global.UE5 || []) {
		const value = UE5[key];
		// 将命令行字符串转换为数组
		const args = value.split(" ");

		// 使用正则表达式提取 -PixelStreamingURL 参数的值
		const match = value.match(/-PixelStreamingURL=([^ ]+)/);

		// 如果匹配成功，则输出 PixelStreamingURL 的值
		if (!match) {
			console.error(`PixelStreamingURL not found. ${value}`);
			continue;
		}
		const url = require("url");
		const pixelStreamingURL = match[1];
		const paseUrl = url.parse(pixelStreamingURL);
		paseUrl.pathname = key;
		const newPixelStreamingURL = url.format(paseUrl);

		// 使用正则表达式或字符串替换修改 PixelStreamingURL 值
		const modifiedArgs = args.map((arg) =>
			arg.replace(
				/-PixelStreamingURL=.*/,
				`-PixelStreamingURL=${newPixelStreamingURL}`
			)
		);

		let localCmd = true;
		let startCmd;

		const ipAddress = args[0];
		const isIpAddress = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.test(args[0]);
		if (isIpAddress) {
			localCmd = false;
			modifiedArgs.shift();
			startCmd = modifiedArgs.join(" ");
			G_StartUe5Pool.push([localCmd, ipAddress, key, startCmd, new Date(0)]);
			continue;
		}
		startCmd = modifiedArgs.join(" ");
		G_StartUe5Pool.push([localCmd, "", key, startCmd, new Date(0)]);
	}
};
function GetFreeUe5() {
	onLineExecIp = [];
	onLineClient = [];

	for (exeWs of EXECUE.clients) {
		onLineExecIp.push(getIPv4(exeWs.req.socket.remoteAddress));
		onLineClient.push(exeWs);
	}
	for (exeUeItem of G_StartUe5Pool) {
		const [localCmd, ipAddress, key, startCmd, lastDate] = exeUeItem;
		hasStartUp = false;
		for (ueClient of ENGINE.clients) {
			//websocket 获取的url前面会加上一个'/'
			if ("/" + key == ueClient.req.url) {
				hasStartUp = true;
				break;
			}
		}
		let now = new Date();
		let difSecond = (now - lastDate) / 1000;
		let coolTime = 60;
		if (global.exeUeCoolTime) {
			coolTime = global.exeUeCoolTime;
		}
		if (difSecond < coolTime) {
			continue;
		}
		if (false == hasStartUp) {
			if (true == localCmd) {
				exeUeItem[4] = now;
				return exeUeItem;
			}
			index = onLineExecIp.indexOf(ipAddress);
			if (-1 != index) {
				exeUeItem[4] = now;
				return [...exeUeItem, onLineClient[index]];
			}
		}
	}
	return;
}
function getIPv4(ip) {
	const net = require("net");
	if (net.isIPv6(ip)) {
		const match = ip.match(/::ffff:(\d+\.\d+\.\d+\.\d+)/);
		if (match) {
			return match[1];
		}
	}
	return ip;
}
function StartExecUe() {
	execUe5 = GetFreeUe5();
	if (execUe5) {
		const [localCmd, ipAddress, key, startCmd, lastDate, exeWs] = execUe5;
		//启动本地的UE
		if (localCmd) {
			child_process.exec(
				startCmd,
				{ cwd: __dirname },
				(error, stdout, stderr) => {
					if (error) {
						console.error(`exec error: ${error}`);
						return;
					}
				}
			);
		} else {
			//启动远端的UE
			exeWs.send(startCmd);
		}
	}
}

InitUe5Pool();

function InitExecUe() {
	//exec-ue的websocket连接管理
	global.EXECUE = new Server(
		{ noServer: true, clientTracking: true },
		() => { }
	);
	EXECUE.on("connection", (socket, req) => {
		socket.req = req;

		socket.isAlive = true;
		socket.on("pong", heartbeat);
		print();
	});

}

InitExecUe();

global.ENGINE = new Server({ noServer: true, clientTracking: true }, () => { });

ENGINE.on("connection", (ue, req) => {
	ue.req = req;

	ue.isAlive = true;
	ue.on("pong", heartbeat);

	ue.fe = new Set();
	// sent to UE5 as initial signal
	ue.send(
		JSON.stringify({
			type: "config",
			peerConnectionOptions: {
				iceServers: global.iceServers,
			},
		})
	);

	// 认领空闲的前端们
	for (const fe of PLAYER.clients) {
		if (fe.killPlayer) {
			continue
		}
		if (!fe.ue) {
			PLAYER.emit("connection", fe, fe.req);
		}
	}
	print();

	ue.onmessage = (msg) => {
		msg = JSON.parse(msg.data);

		// Convert incoming playerId to a string if it is an integer, if needed. (We support receiving it as an int or string).

		if (msg.type === "ping") {
			ue.send(JSON.stringify({ type: "pong", time: msg.time }));
			return;
		}

		// player's port as playerID
		const fe = [...ue.fe].find(
			(fe) => fe.req.socket.remotePort === +msg.playerId
		);

		if (!fe) return;

		delete msg.playerId; // no need to send it to the player
		if (["offer", "answer", "iceCandidate"].includes(msg.type)) {
			fe.send(JSON.stringify(msg));
		} else if (msg.type === "disconnectPlayer") {
			fe.close(1011, msg.reason);
		} else {
		}
	};

	ue.onclose = (e) => {
		ue.fe.forEach((fe) => {
			fe.ue = null;
		});
		print();
	};

	ue.onerror;
});

const path = require("path");

// JWT認証機能
function verifyJWT(req, res) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
        res.writeHead(401);
        res.end('JWT token required');
        return false;
    }
    
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        return true;
    } catch (error) {
        res.writeHead(401);
        res.end('Invalid JWT token');
        return false;
    }
}

async function POST(request, response, HTTP) {

	switch (request.url) {
		case "/signal": {
			return Signal(request, response, HTTP);

			break;
		}

		case "/eval": {
			return eval(decodeURIComponent(request.headers['eval']))

			break;
		}

		case "/exec": {
			return new Promise((res, rej) => {

				child_process.exec(
					decodeURIComponent(request.headers['exec']),
					(error, stdout, stderr) => {
						if (error) {
							rej(stderr)
						} else {
							res(stdout)
						}
					});
			})
			break;
		}

		case "/write": {
			return Write(request, response, HTTP);

			break;
		}
	}
};

// 修改整体配置
async function Signal(request, response, HTTP) {

	let newSignal = JSON.parse(decodeURIComponent(request.headers['signal']))


	//修改了端口，执行下列方法使其生效
	if (newSignal.PORT) {
		await global.serve(newSignal.PORT);

	}

	delete require.cache[require.resolve('./signal.json')]
	let signal = require('./signal.json');

	Object.assign(signal, newSignal);

	Object.assign(global, newSignal);



	if (newSignal.UE5) {
		await global.InitUe5Pool();
	}

	if (newSignal.boot !== undefined) {
		await global.Boot()
	}

	await fs.promises.writeFile(__dirname + '/signal.json', JSON.stringify(signal, null, '\t'));

	await new Promise(res => {
		response.end(JSON.stringify(newSignal), res);
	})


	if (newSignal.PORT) {
		HTTP.closeAllConnections()
		HTTP.close(() => { });
	}



}



async function Write(req, res, HTTP) {

	const chunks = [];

	// Receive chunks of data
	req.on('data', chunk => {
		chunks.push(chunk);
	});

	const body = await new Promise(res => {
		req.on('end', () => {
			res(Buffer.concat(chunks));
		})
	})

	await fs.promises.writeFile(__dirname + decodeURIComponent(req.headers['write']), body)

	return ('updated');



}







global.serve = async (PORT) => {
	const HTTP = require("http").createServer();

	HTTP.on("request", (req, res) => {
		// websocket请求时不触发

		// 認証処理
		if (global["jwt-auth"]) {
            // JWT認証
            if (!verifyJWT(req, res)) {
                return;
            }
        } else if (global.auth) {
            // Basic認証
            let auth = req.headers.authorization?.replace("Basic ", "");
            auth = Buffer.from(auth || "", "base64").toString("utf-8");
            if (global.auth !== auth) {
                res.writeHead(401, {
                    "WWW-Authenticate": 'Basic realm="Auth required"',
                });
                res.end("Auth failed !");
                return;
            }
        }

		if (req.method === 'POST') {
			POST(req, res, HTTP)
				.then((result) => {
					if (!res.writableEnded) res.end(result);
				})
				.catch((err) => {
					// A string to be encoded as a URI component (a path, query string, fragment, etc.). Other values are converted to strings.
					res.setHeader('error', encodeURIComponent(err))
					res.writeHead(400);
					res.end('', () => { });
				});
			return
		}

		if (req.url === '/') req.url = '/signal.html'
		// serve static files
		const read = fs.createReadStream(
			path.join(__dirname, path.normalize(req.url))
		);
		const types = {
			".html": "text/html",
			".css": "text/css",
			".js": "text/javascript",
		};
		const type = types[path.extname(req.url)];
		if (type) res.setHeader("Content-Type", type);

		read
			.on("error", async (error) => {
				res.end('')
			})
			.on("ready", () => {
				read.pipe(res);
			});
	});

	HTTP.on("upgrade", (req, socket, head) => {
		// JWT認証チェック
		if (global["jwt-auth"]) {
			// URLクエリパラメータからトークンを取得
			const url = new URL(req.url, `http://${req.headers.host}`);
			const tokenFromQuery = url.searchParams.get('token');
			
			// ヘッダーからトークンを取得
			const authHeader = req.headers.authorization;
			const tokenFromHeader = authHeader ? authHeader.replace('Bearer ', '') : null;
			
			// いずれかの方法でトークンを取得
			const token = tokenFromHeader || tokenFromQuery;
			
			if (!token) {
				// 認証トークンがない場合は接続を拒否
				socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
				socket.destroy();
				return;
			}
			
			try {
				// トークンを検証
				const decoded = jwt.verify(token, process.env.JWT_SECRET);
				req.user = decoded;
			} catch (error) {
				// トークンが無効な場合は接続を拒否
				socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
				socket.destroy();
				return;
			}
		} else if (global.auth) {
			// 既存のBasic認証処理（WebSocketには実装されていなかったので追加）
			let auth = req.headers.authorization?.replace("Basic ", "");
			auth = Buffer.from(auth || "", "base64").toString("utf-8");
			if (global.auth !== auth) {
				socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
				socket.destroy();
				return;
			}
		}
		
		// WS子协议
		if (req.headers["sec-websocket-protocol"] === "peer-stream") {
			PLAYER.handleUpgrade(req, socket, head, (fe) => {
				PLAYER.emit("connection", fe, req);
			});
		} else if (req.headers["sec-websocket-protocol"] === "exec-ue") {
			EXECUE.handleUpgrade(req, socket, head, (fe) => {
				EXECUE.emit("connection", fe, req);
			});
		} else {
			ENGINE.handleUpgrade(req, socket, head, (fe) => {
				ENGINE.emit("connection", fe, req);
			});
		}
	});

	return new Promise((res, rej) => {
		HTTP.listen(PORT ?? 88, res);
		HTTP.once("error", (err) => {
			rej(err);
		});
	});
};

serve(PORT);

// front end
global.PLAYER = new Server({
	clientTracking: true,
	noServer: true,
});
// every player
PLAYER.on("connection", (fe, req) => {
	fe.req = req;

	fe.isAlive = true;

	if (global.one2one) {
		// 选择空闲的ue
		fe.ue = [...ENGINE.clients].find((ue) => ue.fe.size === 0);
	} else {
		// 选择人最少的ue
		fe.ue = [...ENGINE.clients].sort((a, b) => a.fe.size - b.fe.size)[0];
	}

	fe.send(
		JSON.stringify({
			type: "seticeServers",
			iceServers: global.iceServers,
		})
	);

	if (fe.ue) {
		fe.ue.fe.add(fe);
		if (global.UEVersion && global.UEVersion === 4.27) {
			fe.send(
				JSON.stringify({
					type: "playerConnected",
					playerId: req.socket.remotePort,
					dataChannel: true,
					sfu: false,
				})
			);
		} else {
			fe.ue.send(
				JSON.stringify({
					type: "playerConnected",
					playerId: req.socket.remotePort,
					dataChannel: true,
					sfu: false,
				})
			);
		}
	} else {
		// 没找到现成的UE进程
		StartExecUe();
	}

	print();

	fe.onmessage = (msg) => {
		msg = JSON.parse(msg.data);
		if (msg.type === "pong") {
			fe.isAlive = true;
			return
		}

		if (!fe.ue) {
			fe.send(`! Engine not ready`);
			return;
		}

		msg.playerId = req.socket.remotePort;
		if (["offer", "answer", "iceCandidate"].includes(msg.type)) {
			fe.ue.send(JSON.stringify(msg));
		} else {
			fe.send("? " + msg.type);
		}
	};

	fe.onclose = (e) => {
		if (fe.ue) {
			fe.ue.send(
				JSON.stringify({
					type: "playerDisconnected",
					playerId: req.socket.remotePort,
				})
			);
			fe.ue.fe.delete(fe);
		}
		// 当用户连接数大于ue实例的时候，有用户退出意味着可以，认领空闲的前端们
		for (const fe of PLAYER.clients) {
			if (fe.killPlayer) {
				continue
			}
			if (!fe.ue) {
				PLAYER.emit("connection", fe, fe.req);
			}
		}

		print();
	};

	fe.onerror;
});

function heartbeat() {
	this.isAlive = true;
}

// keep alive
setInterval(() => {
	PLAYER.clients.forEach(function each(fe) {
		if (fe.isAlive === false) return fe.close();

		fe.send(
			JSON.stringify({
				type: "ping",
			})
		);
		fe.isAlive = false;
	});

	ENGINE.clients.forEach(function each(ue) {
		if (ue.isAlive === false) return ue.close();

		ue.isAlive = false;
		ue.ping("", false);
	});

	EXECUE.clients.forEach(function each(ws) {
		if (ws.isAlive === false) return ws.close();

		ws.isAlive = false;
		ws.ping("", false);
	});
}, 30 * 1000);



// 内网IP地址
const nets = require('os').networkInterfaces();
global.address = Object.values(nets).flat()
	.find(a => a.family === 'IPv4' && !a.internal)?.address

child_process.exec(
	`start http://${address}:${PORT}/#signal.json`
);

// 打印映射关系
function print() {
	const logs = [{ type: 'signal.js', address, PORT, path: __dirname }];

	const feList = [...PLAYER.clients].filter((fe) => !fe.ue).concat(...EXECUE.clients);
	feList.forEach((fe) => {
		logs.push({
			type: fe.req.headers["sec-websocket-protocol"],
			address: fe.req.socket.remoteAddress,
			PORT: fe.req.socket.remotePort,
			path: fe.req.url
		})
	});

	ENGINE.clients.forEach((ue) => {
		logs.push({
			type: "Unreal Engine",
			address: ue.req.socket.remoteAddress,
			PORT: ue.req.socket.remotePort,
			path: ue.req.url
		})
		ue.fe.forEach((fe) => {
			logs.push({
				type: fe.req.headers["sec-websocket-protocol"],
				address: fe.req.socket.remoteAddress,
				PORT: fe.req.socket.remotePort,
				path: fe.req.url
			})
		});
	});

	EXECUE.clients.forEach(a => {
		if(a.req.url.endsWith('admin'))
			a.send(JSON.stringify(logs))
	})
	console.clear();
	console.table(logs)

}

print();

let lastPreStart = new Date(0);
function Preload() {
	//只在one2one模型下载进行预加载，共享模式，加载不太频繁，不考虑
	if (!global.one2one) {
		return;
	}
	if (!global.preload) {
		return;
	}
	let ueNumber = ENGINE.clients.size;
	let playerNumber = PLAYER.clients.size;
	if (ueNumber < playerNumber + global.preload) {
		//预加载的时间间隔需要和实例的冷却时间匹配
		//https://github.com/inveta/peer-stream/issues/80
		let now = new Date();
		let difSecond = (now - lastPreStart) / 1000;
		let coolTime = 60;
		if (global.exeUeCoolTime) {
			coolTime = global.exeUeCoolTime;
		}
		if (difSecond < coolTime) {
			return;
		}
		lastPreStart = now;
		StartExecUe();
	}
}

function PreloadKeepAlive() {
	setInterval(() => {
		Preload();
	}, 5 * 1000);
}
PreloadKeepAlive();

//在one模式下，当gpu资源实例不足时，用户进行排队，并定期通知给用户当前排队进展
function PlayerQueue() {
	const fe = [...PLAYER.clients].filter((fe) => !fe.ue);
	if (!fe.length) {
		return;
	}
	let seq = 1;
	let msg = {};
	msg.type = "playerqueue";
	fe.forEach((fe) => {
		msg.seq = seq;
		seq = seq + 1;
		if (!fe.PlayerQueueSeq) {
			fe.PlayerQueueSeq = msg.seq;
			fe.send(JSON.stringify(msg));
			return;
		}
		if (fe.PlayerQueueSeq != msg.seq) {
			fe.PlayerQueueSeq = msg.seq;
			fe.send(JSON.stringify(msg));
			return;
		}
	});
}

function PlayerQueueKeepAlive() {
	if (!global.one2one) {
		return;
	}
	setInterval(() => {
		PlayerQueue();
	}, 5 * 1000);
}

PlayerQueueKeepAlive();

// command line
require("readline")
	.createInterface({
		input: process.stdin,
		output: process.stdout,
	})
	.on("line", (line) => {
		child_process.exec(
			line || ' ',
			(error, stdout, stderr) => {
				if (error) {
					console.error(stderr)
				} else {
					console.log(stdout)
				}
			});
	});

// process.title = __filename;

const signal_bat = process.env.APPDATA +
	'\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\signal.bat';

const signal_sh = "/etc/profile.d/signal.sh";

global.Boot = async function () {
	if (global.boot) {
		switch (process.platform) {
			case "win32": {
				const bat = `"${process.argv[0]}" "${__filename}"`;
				return fs.promises.writeFile(signal_bat, bat);
			}
			case "linux": {
				const sh = `nohup "${process.argv[0]}" "${__filename}" > "${__dirname}/signal.log" &`;
				await fs.promises.writeFile(signal_sh, sh);
				await fs.promises.chmod(signal_sh, 0o777)
			}
		}
	} else {
		switch (process.platform) {
			case "win32": {
				return fs.promises.rm(signal_bat, { force: true })
			}
			case "linux": {
				return fs.promises.rm(signal_sh, { force: true });
			}
		}
	}
}

Boot().catch(err => { });



global.killPlayer = async function (playerId) {
	const fe = [...PLAYER.clients].find(a => a.req.socket.remotePort === playerId)
	if (!fe) throw 'peer-stream not found!'
	fe.ue.send(
		JSON.stringify({
			type: "playerDisconnected",
			playerId,
		})
	)
	fe.ue.fe.delete(fe);
	fe.ue = null;
	fe.killPlayer = true
	// 当用户连接数大于ue实例的时候，有用户退出意味着可以，认领空闲的前端们
	for (const fe of PLAYER.clients) {
		if (fe.killPlayer) {
			continue
		}
		if (!fe.ue) {
			PLAYER.emit("connection", fe, fe.req);
		}
	}
	print();
}


global.killUE = async function (port) {
	let command = `netstat -ano | findstr "${port}.*:${PORT}"`
	const PID = await new Promise((res, rej) => {
		child_process.exec(command, (err, stdout, stderr) => {
			if (err) return rej(stderr)
			const PID = stdout.trim().split('\n')[0].trim().split(/\s+/).pop();
			res(PID)
		})
	})
	if (!PID) throw 'process ID not found'
	command = `taskkill /PID ${PID} /F`;
	await new Promise((res, rej) => {
		child_process.exec(command, (err, stdout, stderr) => {
			if (err)
				return rej(stderr);
			res(stdout.trim());
		});
	})
}