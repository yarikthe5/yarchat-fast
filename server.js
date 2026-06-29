import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

const port = process.env.PORT || 3000;

app.use(express.static("public"));

let messages = [];

io.on("connection", (socket) => {
  console.log("user connected");

  // send history
  socket.emit("history", messages);

  // message receive
  socket.on("message", (data) => {
    const msg = {
      user: data.user,
      text: data.text,
      time: Date.now()
    };

    messages.push(msg);

    io.emit("message", msg);
  });

  // typing
  socket.on("typing", (user) => {
    socket.broadcast.emit("typing", user);
  });
});

server.listen(port, () => {
  console.log("Yarchat Fast v3 running on " + port);
});
