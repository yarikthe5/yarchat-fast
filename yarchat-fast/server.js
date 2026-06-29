import express from "express";
import { WebSocketServer } from "ws";

const app = express();
const port = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("Yarchat Fast is running 🚀");
});

const server = app.listen(port, () => {
  console.log("Server started on port " + port);
});

const wss = new WebSocketServer({ server });

// просте сховище повідомлень (для 2 людей достатньо)
let messages = [];

wss.on("connection", (ws) => {
  console.log("Client connected");

  // відправляємо історію
  ws.send(JSON.stringify({
    type: "history",
    data: messages
  }));

  ws.on("message", (data) => {
    const msg = data.toString();

    const message = {
      text: msg,
      time: Date.now()
    };

    messages.push(message);

    // розсилаємо всім
    wss.clients.forEach(client => {
      if (client.readyState === 1) {
        client.send(JSON.stringify({
          type: "message",
          data: message
        }));
      }
    });
  });
});