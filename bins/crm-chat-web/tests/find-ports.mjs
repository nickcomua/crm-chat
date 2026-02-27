import net from "node:net";

const count = parseInt(process.argv[2] || "6", 10);
const servers = await Promise.all(
  Array.from({ length: count }, () =>
    new Promise((resolve, reject) => {
      const server = net.createServer();
      server.listen(0, "127.0.0.1", () => resolve(server));
      server.on("error", reject);
    })
  )
);
const ports = servers.map((s) => s.address().port);
await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
process.stdout.write(JSON.stringify(ports));
