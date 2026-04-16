import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
    }
  });

  const PORT = 3000;

  // Signal Generator State
  let generatorSettings = {
    type: 'sine', // sine, square, triangle, sawtooth
    frequency: 10, // Hz (simulated for visual clarity, normally higher)
    amplitude: 2.5, // 0-5V
    offset: 2.5, // Center around 2.5V
  };

  // Oscilloscope Simulated Data Generation
  let time = 0;
  const sampleRate = 500; // samples per second
  const intervalMs = 20; // emit every 20ms
  const samplesPerBatch = (sampleRate * intervalMs) / 1000;

  setInterval(() => {
    const dataBatch: { t: number; v: number }[] = [];
    
    for (let i = 0; i < samplesPerBatch; i++) {
        time += 1 / sampleRate;
        let voltage = 0;
        const f = generatorSettings.frequency;
        const A = generatorSettings.amplitude;
        const offset = generatorSettings.offset;

        switch (generatorSettings.type) {
            case 'sine':
                voltage = offset + A * Math.sin(2 * Math.PI * f * time);
                break;
            case 'square':
                voltage = offset + A * (Math.sin(2 * Math.PI * f * time) >= 0 ? 1 : -1);
                break;
            case 'triangle':
                voltage = offset + (2 * A / Math.PI) * Math.asin(Math.sin(2 * Math.PI * f * time));
                break;
            case 'sawtooth':
                voltage = offset + A * (2 * (time * f - Math.floor(0.5 + time * f)));
                break;
        }
        
        // Add some random noise
        voltage += (Math.random() - 0.5) * 0.1;

        dataBatch.push({
            t: Number(time.toFixed(4)),
            v: Number(voltage.toFixed(4))
        });
    }

    io.emit('signal-batch', dataBatch);
  }, intervalMs);

  io.on('connection', (socket) => {
    console.log('Client connected');
    socket.emit('settings-sync', generatorSettings);

    socket.on('update-settings', (newSettings) => {
      generatorSettings = { ...generatorSettings, ...newSettings };
      io.emit('settings-sync', generatorSettings); // Broadcast to all
    });

    socket.on('disconnect', () => {
      console.log('Client disconnected');
    });
  });

  // API Routes
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Vite middleware setup
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
