import { Server } from "socket.io";

let io;

export const initSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST", "PATCH", "PUT", "DELETE"]
    }
  });

  io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);
    
    socket.on("join_admin", () => {
      socket.join("admin_room");
      console.log("Client joined admin room:", socket.id);
    });

    socket.on("disconnect", () => {
      console.log("Client disconnected:", socket.id);
    });
  });

  return io;
};

export const getIO = () => {
  if (!io) {
    throw new Error("Socket.io not initialized!");
  }
  return io;
};

export const notifyAdmin = (event, data) => {
  if (io) {
    io.to("admin_room").emit(event, data);
  }
};
