import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import { getAiRuntimeSummary, registerAiRoutes } from "./src/server/ai";
import { registerAppApiRoutes } from "./src/server/app-api";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  const PORT = Number(process.env.PORT || 3000);

  app.use(express.json({ limit: "25mb" }));

  // Basic API routes
  app.get("/api/health", (req, res) => {
    res.json({
      status: "ok",
      version: "4.2.0-LUMINA",
      ai: getAiRuntimeSummary(),
    });
  });

  registerAiRoutes(app);
  registerAppApiRoutes(app);

  // Socket.IO Logic
  io.on("connection", (socket) => {
    console.log("A user connected:", socket.id);

    socket.on("typing", (data) => {
      socket.broadcast.emit("typing", data);
    });

    socket.on("message", (data) => {
      // Real-time message relay if needed
      socket.broadcast.emit("message", data);
    });

    socket.on("disconnect", () => {
      console.log("User disconnected:", socket.id);
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
