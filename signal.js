"5.1.3";

const fs = require("fs");
const child_process = require("child_process");
const { Server } = require("ws");
const path = require("path");
const nets = require("os").networkInterfaces();
const jwt = require("jsonwebtoken");
require("dotenv").config(); // .envの読み込み
const JWT_SECRET = process.env.JWT_SECRET || "default-secret";

Object.assign(global, require("./signal.json"));

if (global.env) {
	const signal = {
		PORT: +process.env.PORT,
		auth: process.env.auth,
		one2one: process.env.one2one,
		preload: +process.env.preload,
		exeUeCoolTime: +process.env.exeUeCoolTime,
		UEVersion: +process.env.UEVersion,
		UE5: Object.entries(process.env)
			.filter(([key]) => key.startsWith("UE5_"))
			.map(([key, value]) => value),
	};
	fs.promises.writeFile("./signal.json", JSON.stringify(signal));
	Object.assign(global, signal);
}

G_StartUe5Pool = [];
global.InitUe5Pool = function () {
	G_StartUe5Pool = [];
	for (const key in global.UE5 || []) {
		const value = UE5[key];
		const args = value.split(" ");
		const match = value.match(/-PixelStreamingURL=([^ ]+)/);
		if (!match) continue;
		const url = require("url");
		const pixelStreamingURL = match[1];
		const paseUrl = url.parse(pixelStreamingURL);
		paseUrl.pathname = key;
		const newPixelStreamingURL = url.format(paseUrl);
		const modifiedArgs = args.map((arg) =>
			arg.replace(/-PixelStreamingURL=.*/, `-PixelStreamingURL=${newPixelStreamingURL}`)
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

function getIPv4(ip) {
	const net = require("net");
	if (net.isIPv6(ip)) {
		const match = ip.match(/::ffff:(\d+\.\d+\.\d+\.\d+)/);
		if (match) return match[1];
	}
	return ip;
}

function GetFreeUe5() {
	onLineExecIp = [];
	onLineClient = [];
	for (exeWs of EXECUE.clients) {
		onLineExecIp.push(getIPv4(exeWs.req.socket.remoteAddress));
		onLineClient.push(exeWs);
	}
	for (exeUeItem of G_StartUe5Pool) {
		const [localCmd, ipAddress, key, startCmd, lastDate] = exeUeItem;
		let hasStartUp = false;
		for (ueClient of ENGINE.clients) {
			if ("/" + key == ueClient.req.url) {
				hasStartUp = true;
				break;
			}
		}
		const now = new Date();
		const difSecond = (now - lastDate) / 1000;
		let coolTime = 60;
		if (global.exeUeCoolTime) coolTime = global.exeUeCoolTime;
		if (difSecond < coolTime) continue;
		if (!hasStartUp) {
			if (localCmd) {
				exeUeItem[4] = now;
				return exeUeItem;
			}
			const index = onLineExecIp.indexOf(ipAddress);
			if (index != -1) {
				exeUeItem[4] = now;
				return [...exeUeItem, onLineClient[index]];
			}
		}
	}
	return;
}

function StartExecUe() {
	const execUe5 = GetFreeUe5();
	if (execUe5) {
		const [localCmd, ipAddress, key, startCmd, lastDate, exeWs] = execUe5;
		if (localCmd) {
			child_process.exec(startCmd, { cwd: __dirname }, (error) => {
				if (error) console.error(`exec error: ${error}`);
			});
		} else {
			exeWs.send(startCmd);
		}
	}
}

InitUe5Pool();

function InitExecUe() {
	global.EXECUE = new Server({ noServer: true, clientTracking: true });
	EXECUE.on("connection", (socket, req) => {
		socket.req = req;
		socket.isAlive = true;
		socket.on("pong", heartbeat);
		print();
	});
}
InitExecUe();

global.ENGINE = new Server({ noServer: true, clientTracking: true });
ENGINE.on("connection", (ue, req) => {
	ue.req = req;
	ue.isAlive = true;
	ue.on("pong", heartbeat);
	ue.fe = new Set();
	ue.send(
		JSON.stringify({
			type: "config",
			peerConnectionOptions: { iceServers: global.iceServers },
		})
	);
	for (const fe of PLAYER.clients) {
		if (!fe.killPlayer && !fe.ue) {
			PLAYER.emit("connection", fe, fe.req);
		}
	}
	print();
	ue.onmessage = (msg) => {
		msg = JSON.parse(msg.data);
		if (msg.type === "ping") {
			ue.send(JSON.stringify({ type: "pong", time: msg.time }));
			return;
		}
		const fe = [...ue.fe].find((f) => f.req.socket.remotePort === +msg.playerId);
		if (!fe) return;
		delete msg.playerId;
		if (["offer", "answer", "iceCandidate"].includes(msg.type)) {
			fe.send(JSON.stringify(msg));
		} else if (msg.type === "disconnectPlayer") {
			fe.close(1011, msg.reason);
		}
	};
	ue.onclose = () => {
		ue.fe.forEach((fe) => {
			fe.ue = null;
		});
		print();
	};
	ue.onerror;
});

async function POST(request, response, HTTP) {
	switch (request.url) {
		case "/signal": {
			return Signal(request, response, HTTP);
		}
		case "/eval": {
			return eval(decodeURIComponent(request.headers["eval"]));
		}
		case "/exec": {
			return new Promise((res, rej) => {
				child_process.exec(decodeURIComponent(request.headers["exec"]), (err, stdout, stderr) => {
					if (err) rej(stderr);
					else res(stdout);
				});
			});
		}
		case "/write": {
			return Write(request, response, HTTP);
		}
	}
}

async function Signal(request, response, HTTP) {
	let newSignal = JSON.parse(decodeURIComponent(request.headers["signal"]));
	if (newSignal.PORT) await global.serve(newSignal.PORT);
	delete require.cache[require.resolve("./signal.json")];
	let signal = require("./signal.json");
	Object.assign(signal, newSignal);
	Object.assign(global, newSignal);
	if (newSignal.UE5) await global.InitUe5Pool();
	if (newSignal.boot !== undefined) await global.Boot();
	await fs.promises.writeFile(__dirname + "/signal.json", JSON.stringify(signal, null, "\t"));
	await new Promise((res) => {
		response.end(JSON.stringify(newSignal), res);
	});
	if (newSignal.PORT) {
		HTTP.closeAllConnections();
		HTTP.close(() => {});
	}
}

async function Write(req, res, HTTP) {
	const chunks = [];
	req.on("data", (chunk) => chunks.push(chunk));
	const body = await new Promise((resolve) => {
		req.on("end", () => resolve(Buffer.concat(chunks)));
	});
	await fs.promises.writeFile(__dirname + decodeURIComponent(req.headers["write"]), body);
	return "updated";
}

global.serve = async (PORT) => {
	const HTTP = require("http").createServer();
	HTTP.on("request", (req, res) => {
		if (global.auth) {
			let auth = req.headers.authorization?.replace("Basic ", "");
			auth = Buffer.from(auth || "", "base64").toString("utf-8");
			if (global.auth !== auth) {
				res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Auth required"' });
				res.end("Auth failed !");
				return;
			}
		}
		if (req.method === "POST") {
			POST(req, res, HTTP)
				.then((result) => {
					if (!res.writableEnded) res.end(result);
				})
				.catch((err) => {
					res.setHeader("error", encodeURIComponent(err));
					res.writeHead(400);
					res.end("", () => {});
				});
			return;
		}
		if (req.url === "/") req.url = "/signal.html";
		const read = fs.createReadStream(path.join(__dirname, path.normalize(req.url)));
		const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };
		const type = types[path.extname(req.url)];
		if (type) res.setHeader("Content-Type", type);
		read
			.on("error", () => {
				res.end("");
			})
			.on("ready", () => {
				read.pipe(res);
			});
	});

	HTTP.on("upgrade", (req, socket, head) => {
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
		HTTP.once("error", (err) => rej(err));
	});
};

global.PLAYER = new Server({ clientTracking: true, noServer: true });

PLAYER.on("connection", (fe, req) => {
	fe.req = req;
	fe.isAlive = true;

	// jwt-authがtrueならJWT認証する
	if (global["jwt-auth"] === true) {
		try {
			const url = new URL(req.url, "http://" + req.headers.host);
			const token = url.searchParams.get("token");
			if (!token) {
				fe.close(4401, "Unauthorized: No token provided");
				return;
			}
			jwt.verify(token, JWT_SECRET);
		} catch (err) {
			fe.close(4401, "Unauthorized: Invalid token");
			return;
		}
	}

	if (global.one2one) {
		fe.ue = [...ENGINE.clients].find((ue) => ue.fe.size === 0);
	} else {
		fe.ue = [...ENGINE.clients].sort((a, b) => a.fe.size - b.fe.size)[0];
	}
	fe.send(JSON.stringify({ type: "seticeServers", iceServers: global.iceServers }));

	if (fe.ue) {
		fe.ue.fe.add(fe);
		if (global.UEVersion && global.UEVersion === 4.27) {
			fe.send(JSON.stringify({
				type: "playerConnected",
				playerId: req.socket.remotePort,
				dataChannel: true,
				sfu: false
			}));
		} else {
			fe.ue.send(JSON.stringify({
				type: "playerConnected",
				playerId: req.socket.remotePort,
				dataChannel: true,
				sfu: false
			}));
		}
	} else {
		StartExecUe();
	}

	print();

	fe.onmessage = (msg) => {
		msg = JSON.parse(msg.data);
		if (msg.type === "pong") {
			fe.isAlive = true;
			return;
		}
		if (!fe.ue) {
			fe.send("! Engine not ready");
			return;
		}
		msg.playerId = req.socket.remotePort;
		if (["offer", "answer", "iceCandidate"].includes(msg.type)) {
			fe.ue.send(JSON.stringify(msg));
		} else {
			fe.send("? " + msg.type);
		}
	};

	fe.onclose = () => {
		if (fe.ue) {
			fe.ue.send(JSON.stringify({
				type: "playerDisconnected",
				playerId: req.socket.remotePort
			}));
			fe.ue.fe.delete(fe);
		}
		for (const fe2 of PLAYER.clients) {
			if (!fe2.killPlayer && !fe2.ue) {
				PLAYER.emit("connection", fe2, fe2.req);
			}
		}
		print();
	};

	fe.onerror;
});

function heartbeat() {
	this.isAlive = true;
}

setInterval(() => {
	PLAYER.clients.forEach((fe) => {
		if (!fe.isAlive) return fe.close();
		fe.send(JSON.stringify({ type: "ping" }));
		fe.isAlive = false;
	});
	ENGINE.clients.forEach((ue) => {
		if (!ue.isAlive) return ue.close();
		ue.isAlive = false;
		ue.ping("", false);
	});
	EXECUE.clients.forEach((ws) => {
		if (!ws.isAlive) return ws.close();
		ws.isAlive = false;
		ws.ping("", false);
	});
}, 30000);

global.address = Object.values(nets).flat().find(a => a.family === "IPv4" && !a.internal)?.address;
child_process.exec(`start http://${address}:${PORT}/#signal.json`);

function print() {
	const logs = [{ type: "signal.js", address, PORT, path: __dirname }];
	const feList = [...PLAYER.clients].filter((fe) => !fe.ue).concat(...EXECUE.clients);
	feList.forEach((fe) => {
		logs.push({
			type: fe.req.headers["sec-websocket-protocol"],
			address: fe.req.socket.remoteAddress,
			PORT: fe.req.socket.remotePort,
			path: fe.req.url
		});
	});
	ENGINE.clients.forEach((ue) => {
		logs.push({
			type: "Unreal Engine",
			address: ue.req.socket.remoteAddress,
			PORT: ue.req.socket.remotePort,
			path: ue.req.url
		});
		ue.fe.forEach((fe) => {
			logs.push({
				type: fe.req.headers["sec-websocket-protocol"],
				address: fe.req.socket.remoteAddress,
				PORT: fe.req.socket.remotePort,
				path: fe.req.url
			});
		});
	});
	EXECUE.clients.forEach((a) => {
		if (a.req.url.endsWith("admin")) a.send(JSON.stringify(logs));
	});
	console.clear();
	console.table(logs);
}

print();

let lastPreStart = new Date(0);
function Preload() {
	if (!global.one2one) return;
	if (!global.preload) return;
	const ueNumber = ENGINE.clients.size;
	const playerNumber = PLAYER.clients.size;
	if (ueNumber < playerNumber + global.preload) {
		const now = new Date();
		const difSecond = (now - lastPreStart) / 1000;
		let coolTime = 60;
		if (global.exeUeCoolTime) coolTime = global.exeUeCoolTime;
		if (difSecond < coolTime) return;
		lastPreStart = now;
		StartExecUe();
	}
}

function PreloadKeepAlive() {
	setInterval(Preload, 5000);
}
PreloadKeepAlive();

function PlayerQueue() {
	const fe = [...PLAYER.clients].filter((f) => !f.ue);
	if (!fe.length) return;
	let seq = 1;
	const msg = { type: "playerqueue" };
	fe.forEach((x) => {
		msg.seq = seq;
		seq++;
		if (!x.PlayerQueueSeq) {
			x.PlayerQueueSeq = msg.seq;
			x.send(JSON.stringify(msg));
			return;
		}
		if (x.PlayerQueueSeq != msg.seq) {
			x.PlayerQueueSeq = msg.seq;
			x.send(JSON.stringify(msg));
			return;
		}
	});
}

function PlayerQueueKeepAlive() {
	if (!global.one2one) return;
	setInterval(PlayerQueue, 5000);
}
PlayerQueueKeepAlive();

require("readline")
	.createInterface({ input: process.stdin, output: process.stdout })
	.on("line", (line) => {
		child_process.exec(line || " ", (error, stdout, stderr) => {
			if (error) console.error(stderr);
			else console.log(stdout);
		});
	});

const signal_bat = process.env.APPDATA + "\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\signal.bat";
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
				await fs.promises.chmod(signal_sh, 0o777);
			}
		}
	} else {
		switch (process.platform) {
			case "win32":
				return fs.promises.rm(signal_bat, { force: true });
			case "linux":
				return fs.promises.rm(signal_sh, { force: true });
		}
	}
};

Boot().catch(() => {});

global.killPlayer = async function (playerId) {
	const fe = [...PLAYER.clients].find((a) => a.req.socket.remotePort === playerId);
	if (!fe) throw "peer-stream not found!";
	fe.ue.send(JSON.stringify({ type: "playerDisconnected", playerId }));
	fe.ue.fe.delete(fe);
	fe.ue = null;
	fe.killPlayer = true;
	for (const x of PLAYER.clients) {
		if (x.killPlayer) continue;
		if (!x.ue) PLAYER.emit("connection", x, x.req);
	}
	print();
};

global.killUE = async function (port) {
	let command = `netstat -ano | findstr "${port}.*:${PORT}"`;
	const PID = await new Promise((res, rej) => {
		child_process.exec(command, (err, stdout) => {
			if (err) return rej(stdout);
			const p = stdout.trim().split("\n")[0].trim().split(/\s+/).pop();
			res(p);
		});
	});
	if (!PID) throw "process ID not found";
	command = `taskkill /PID ${PID} /F`;
	await new Promise((res, rej) => {
		child_process.exec(command, (err, stdout) => {
			if (err) rej(stdout);
			else res(stdout.trim());
		});
	});
};
