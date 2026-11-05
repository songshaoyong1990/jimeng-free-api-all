import net from "node:net";

const listenPort = Number(process.env.LAN_PORT || 8002);
const targetHost = process.env.TARGET_HOST || "127.0.0.1";
const targetPort = Number(process.env.TARGET_PORT || 8001);

const server = net.createServer((client) => {
  const remote = net.connect(targetPort, targetHost);
  client.pipe(remote);
  remote.pipe(client);
  const close = () => {
    client.destroy();
    remote.destroy();
  };
  client.on("error", close);
  remote.on("error", close);
});

server.listen(listenPort, "0.0.0.0", () => {
  console.log(`LAN relay listening 0.0.0.0:${listenPort} -> ${targetHost}:${targetPort}`);
});
