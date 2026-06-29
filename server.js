import express from "express";
import { WebSocketServer } from "ws";

const app = express();
const port = process.env.PORT || 3000;

app.use(express.static("public"));

const server = app.listen(port, () => {
  console.log("Yarchat Fast V2 running on " + port);
});

const wss = new WebSocketServer({ server });

let clients = {};
let messages = [];

wss.on("connection", (ws) => {
  let user = "anon";

  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());

    // login
    if (msg.type === "login") {
      user = msg.name;
      clients[user] = ws;

      broadcast({
        type: "system",
        text: `${user} joined chat`
      });
    }

    // chat message
    if (msg.type === "message") {
      const message = {
        user,
        text: msg.text,
        time: Date.now()
      };

      messages.push(message);

      broadcast({
        type: "message",
        data: message
      });
    }

    // typing
    if (msg.type === "typing") {
      broadcast({
        type: "typing",
        user
      });
    }
  });

  ws.send(JSON.stringify({
    type: "history",
    data: messages
  }));
});

function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(JSON.stringify(data));
    }
  });
}
