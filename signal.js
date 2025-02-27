"5.1.3";

const fs = require("fs");
const child_process = require("child_process");
const { Server } = require("ws");
const path = require("path");
const nets = require("os").networkInterfaces();
const jwt = require("jsonwebtoken");
require("dotenv").config(); // .envの読み込み
const JWT_SECRET = process.env.JWT_SECRET || "default-secret";

console.log("===== Starting signal.js =====");
console.log("JWT_SECRET:", JWT_SECRET);

Object.assign(global, require("./signal.json"));
console.log("Loaded signal.json, global config:", global);

if (global.env) {
	console.log("env mode: rewriting signal.json from environment variables");
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
	console.log("env config merged to signal.json =>", signal);
}

G_StartUe5Pool = [];
global.InitUe5Pool = function () {
	console.log("InitUe5Pool called");
	G_StartUe5Pool = [];
	for (const key in global.UE5 || []) {
		const value = UE5[key];
		const args = value.split(" ");
		const match = value.match(/-PixelStreamingURL=([^ ]+)/);
		if (!match) {
			console.error(`PixelStreamingURL not found in: ${value}`);
			continue;
		}
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
	console.log("G_StartUe5Pool:", G_StartUe5Pool);
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
		let now = new Date();
		let difSecond = (now - lastDate) / 1000;
		let coolTime = 60;
		if (global.exeUeCoolTime) coolTime = global.exeUeCoolTime;
		if (difSecond < coolTime) continue;
		if (!hasStartUp) {
			if (localCmd) {
				exeUeItem[4] = now;
				console.log(`Found free local UE slot: [${startCmd}]`);
				return exeUeItem;
			}
			const index = onLineExecIp.indexOf(ipAddress);
			if (index != -1) {
				exeUeItem[4] = now;
				console.log(`Found free remote UE slot for IP ${ipAddress}: [${startCmd}]`);
				return [...exeUeItem, onLineClient[index]];
			}
		}
	}
}

function StartExecUe() {
	const execUe5 = GetFreeUe5();
	if (execUe5) {
		console.log("StartExecUe => execUe5:", execUe5);
		const [localCmd, ipAddress, key, startCmd, lastDate, exeWs] = execUe5;
		if (localCmd) {
			console.log(`Starting local UE with command: ${startCmd}`);
			child_process.exec(startCmd, { cwd: __dirname }, (error) => {
				if (error) console.error(`exec error: ${error}`);
			});
		} else {
			console.log(`Sending remote startCmd to exec-ue: ${startCmd}`);
			exeWs.send(startCmd);
		}
	} else {
		console.log("StartExecUe => no free UE found");
	}
}

console.log("Initializing InitUe5Pool...");
InitUe5Pool();

function InitExecUe() {
	console.log("InitExecUe called");
	global.EXECUE = new Server({ noServer: true, clientTracking: true });
	EXECUE.on("connection", (socket, req) => {
		console.log("EXECUE on connection");
		socket.req = req;
		socket.isAlive = true;
		socket.on("pong", heartbeat);
		print();
	});
}
InitExecUe();

global.ENGINE = new Server({ noServer: true, clientTracking: true });
ENGINE.on("connection", (ue, req) => {
	console.log("ENGINE on connection");
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
		console.log("ENGINE socket onclose");
		ue.fe.forEach((fe) => {
			fe.ue = null;
		});
		print();
	};

	ue.onerror = (err) => {
		console.error("ENGINE socket onerror:", err);
	};
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
	console.log("POST /signal called");
	let newSignal = JSON.parse(decodeURIComponent(request.headers["signal"]));
	if (newSignal.PORT) {
		console.log("Restarting serve with new PORT:", newSignal.PORT);
		await global.serve(newSignal.PORT);
	}
	delete require.cache[require.resolve("./signal.json")];
	let signal = require("./signal.json");
	Object.assign(signal, newSignal);
	Object.assign(global, newSignal);

	if (newSignal.UE5) {
		console.log("Re-init Ue5Pool");
		await global.InitUe5Pool();
	}

	if (newSignal.boot !== undefined) {
		console.log("boot changed => call Boot()");
		await global.Boot();
	}

	await fs.promises.writeFile(__dirname + "/signal.json", JSON.stringify(signal, null, "\t"));
	await new Promise((res) => {
		response.end(JSON.stringify(newSignal), res);
	});

	if (newSignal.PORT) {
		console.log("Closing old HTTP connections...");
		HTTP.closeAllConnections();
		HTTP.close(() => {
			console.log("HTTP closed after re-init");
		});
	}
}

async function Write(req, res, HTTP) {
	console.log("POST /write called");
	const chunks = [];
	req.on("data", (chunk) => chunks.push(chunk));
	const body = await new Promise((resolve) => {
		req.on("end", () => resolve(Buffer.concat(chunks)));
	});
	await fs.promises.writeFile(__dirname + decodeURIComponent(req.headers["write"]), body);
	return "updated";
}

global.serve = async (PORT) => {
	console.log("global.serve called => Trying to listen on:", PORT);
	const HTTP = require("http").createServer();

	HTTP.on("error", (err) => {
		console.error("HTTP server onerror:", err);
	});

	HTTP.on("request", (req, res) => {
		// Basic Auth
		if (global.auth) {
			let auth = req.headers.authorization?.replace("Basic ", "");
			auth = Buffer.from(auth || "", "base64").toString("utf-8");
			if (global.auth !== auth) {
				console.log("BasicAuth failed for user input:", auth);
				res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Auth required"' });
				res.end("Auth failed !");
				return;
			}
		}

		if (req.method === "POST") {
			console.log("HTTP POST => ", req.url);
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
			.on("error", (e) => {
				console.log(`File not found or error reading: ${req.url}`, e.message);
				res.end("");
			})
			.on("ready", () => {
				read.pipe(res);
			});
	});

	HTTP.on("upgrade", (req, socket, head) => {
		console.log("upgrade request =>", req.url);
		if (req.headers["sec-websocket-protocol"] === "peer-stream") {
			PLAYER.handleUpgrade(req, socket, head, (fe) => {
				console.log("PLAYER.handleUpgrade -> connection");
				PLAYER.emit("connection", fe, req);
			});
		} else if (req.headers["sec-websocket-protocol"] === "exec-ue") {
			console.log("EXECUE handleUpgrade");
			EXECUE.handleUpgrade(req, socket, head, (fe) => {
				EXECUE.emit("connection", fe, req);
			});
		} else {
			console.log("ENGINE handleUpgrade");
			ENGINE.handleUpgrade(req, socket, head, (fe) => {
				ENGINE.emit("connection", fe, req);
			});
		}
	});

	return new Promise((res, rej) => {
		HTTP.listen(PORT ?? 88, () => {
			console.log(`HTTP server listening on port ${PORT ?? 88}`);
			res();
		});
		HTTP.once("error", (err) => {
			console.error("Error listening on port:", err);
			rej(err);
		});
	});
};

global.PLAYER = new Server({ clientTracking: true, noServer: true });

PLAYER.on("connection", (fe, req) => {
	console.log("PLAYER on connection => req.url:", req.url);
	fe.req = req;
	fe.isAlive = true;

	if (global["jwt-auth"] === true) {
		console.log("jwt-auth is true => checking token");
		try {
			const url = new URL(req.url, "http://" + req.headers.host);
			const token = url.searchParams.get("token");
			if (!token) {
				console.log("No token => closing 4401");
				fe.close(4401, "Unauthorized: No token provided");
				return;
			}
			jwt.verify(token, JWT_SECRET);
			console.log("JWT verify success");
		} catch (err) {
			console.log("JWT verify failed =>", err);
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
		console.log("Assigned UE to player =>", fe.req.socket.remotePort);
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
		console.log("No UE found => StartExecUe");
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
		console.log("PLAYER socket onclose =>", fe.req.socket.remotePort);
		if (fe.ue) {
			fe.ue.send(
				JSON.stringify({
					type: "playerDisconnected",
					playerId: req.socket.remotePort,
				})
			);
			fe.ue.fe.delete(fe);
		}
		for (const fe2 of PLAYER.clients) {
			if (!fe2.killPlayer && !fe2.ue) {
				PLAYER.emit("connection", fe2, fe2.req);
			}
		}
		print();
	};

	fe.onerror = (err) => {
		console.error("PLAYER socket onerror:", err);
	};
});

function heartbeat() {
	this.isAlive = true;
}

setInterval(() => {
	PLAYER.clients.forEach((fe) => {
		if (!fe.isAlive) {
			console.log("PLAYER fe not alive => close");
			return fe.close();
		}
		fe.send(JSON.stringify({ type: "ping" }));
		fe.isAlive = false;
	});
	ENGINE.clients.forEach((ue) => {
		if (!ue.isAlive) {
			console.log("ENGINE ue not alive => close");
			return ue.close();
		}
		ue.isAlive = false;
		ue.ping("", false);
	});
	EXECUE.clients.forEach((ws) => {
		if (!ws.isAlive) {
			console.log("EXECUE not alive => close");
			return ws.close();
		}
		ws.isAlive = false;
		ws.ping("", false);
	});
}, 30000);

global.address = Object.values(nets).flat().find((a) => a.family === "IPv4" && !a.internal)?.address;
child_process.exec(`start http://${address}:${PORT}/#signal.json`, (err) => {
	if (err) {
		console.log("Cannot open URL automatically:", err);
	}
});

function print() {
	const logs = [{ type: "signal.js", address, PORT, path: __dirname }];
	const feList = [...PLAYER.clients].filter((fe) => !fe.ue).concat(...EXECUE.clients);
	feList.forEach((fe) => {
		logs.push({
			type: fe.req.headers["sec-websocket-protocol"],
			address: fe.req.socket.remoteAddress,
			PORT: fe.req.socket.remotePort,
			path: fe.req.url,
		});
	});
	ENGINE.clients.forEach((ue) => {
		logs.push({
			type: "Unreal Engine",
			address: ue.req.socket.remoteAddress,
			PORT: ue.req.socket.remotePort,
			path: ue.req.url,
		});
		ue.fe.forEach((fe) => {
			logs.push({
				type: fe.req.headers["sec-websocket-protocol"],
				address: fe.req.socket.remoteAddress,
				PORT: fe.req.socket.remotePort,
				path: fe.req.url,
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
	console.log("global.Boot called, boot:", global.boot);
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

Boot().catch((err) => {
	console.error("Boot error:", err);
});

global.killPlayer = async function (playerId) {
	console.log("killPlayer called:", playerId);
	const fe = [...PLAYER.clients].find((a) => a.req.socket.remotePort === playerId);
	if (!fe) {
		console.log("peer-stream not found for", playerId);
		throw "peer-stream not found!";
	}
	if (fe.ue) {
		fe.ue.send(JSON.stringify({ type: "playerDisconnected", playerId }));
		fe.ue.fe.delete(fe);
		fe.ue = null;
	}
	fe.killPlayer = true;
	for (const x of PLAYER.clients) {
		if (x.killPlayer) continue;
		if (!x.ue) PLAYER.emit("connection", x, x.req);
	}
	print();
};

global.killUE = async function (port) {
	console.log("killUE called:", port);
	let command = `netstat -ano | findstr "${port}.*:${PORT}"`;
	const PID = await new Promise((res, rej) => {
		child_process.exec(command, (err, stdout) => {
			if (err) return rej(stdout);
			const lines = stdout.trim().split("\n");
			if (!lines.length || !lines[0]) return rej("process ID not found");
			const p = lines[0].trim().split(/\s+/).pop();
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
