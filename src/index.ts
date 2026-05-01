/**
 * Copyright 2026 Reto Meier
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import dotenv from 'dotenv';
const dotenvResult = dotenv.config({ override: true });
console.log('dotenv loaded:', !dotenvResult.error, '| NVIDIA_API_KEY ends in:', process.env.NVIDIA_API_KEY?.slice(-6) ?? 'NOT SET');
import express, { Application } from 'express';
import http from 'http';
import path from 'node:path';
import process from 'process';
import { fileURLToPath } from 'node:url';
import { initializeWebSocketServer } from './websocket_server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const guiPath = path.join(__dirname, 'assets', 'gui');

// --- Server Setup ---
const app: Application = express();
const port: number = process.env.PORT ? parseInt(process.env.PORT, 10) : 3007;

app.use('/gui', express.static(guiPath));
app.get('/', (_req, res) => {
  res.redirect('/gui');
});

// --- Server Initialization ---
const server: http.Server = http.createServer(app);

// Initialize the WebSocket server and attach it to the HTTP server
initializeWebSocketServer(port, server);

server.listen(port, () => {
  console.log(`🚀 Server with WebSocket support is listening at http://localhost:${port}`);
});