#!/usr/bin/env node

/**
 * @type {any}
 */

import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { Server } from "socket.io";
import { Http3Server } from "@fails-components/webtransport";
import { setupSocketConnection } from './utils.js'

const host = process.env.HOST || '0.0.0.0'
const port = process.env.PORT || 3000

const key = readFileSync("./bin/private.key");
const cert = readFileSync("./bin/certificate.crt");

const server = createServer({key, cert}, (request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/plain' })
  response.end('okay')
})

server.listen(port, host, () => {
  console.log(`running at '${host}' on port ${port}`)
})

const io = new Server(server, {
  transports: ["polling", "websocket", "webtransport"],
  upgradeTimeout: 30000
});


io.on('connection', (socket) => {
  console.log('A user connected');
  socket.conn.on("upgrade", (transport) => {
    console.log(`${Date.now()} transport upgraded to ${transport.name} ${socket.id}`);
    if (transport.name === 'webtransport'){
      setupSocketConnection(socket, true)
    }
  });
});

const h3Server = new Http3Server({
  port,
  host: "0.0.0.0",
  secret: "changeit",
  cert,
  privKey: key,
});

h3Server.startServer();

(async () => {
  const stream = await h3Server.sessionStream("/socket.io/");
  const sessionReader = stream.getReader();

  while (true) {
    const { done, value } = await sessionReader.read();
    if (done) {
      break;
    }
    io.engine.onWebTransportSession(value);
  }
})();