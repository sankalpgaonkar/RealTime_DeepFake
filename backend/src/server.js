/**
 * Server Entry Point
 * Starts the Express server and connects to database
 */

import app from './app.js';
import { connectDB } from './config/db.js';
import config from './config/env.js';
import logger from './utils/logger.js';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { initializeSocket, setupSocketHandlers } from './scans/scan.socket.js';
import { createScanQueue } from './utils/queue.js';
import { setupScanProcessor } from './scans/scan.processor.js';
import { startHealthChecks } from './ml/ml-client.js';
import { initializeEmailService } from './notifications/email.service.js';

const PORT = config.server.port;

/**
 * Check if a port is available
 */
const isPortAvailable = (port) => {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve(false);
      } else {
        resolve(false);
      }
    });
    server.listen(port, () => {
      server.once('close', () => resolve(true));
      server.close();
    });
  });
};

/**
 * Start the server
 */
const startServer = async () => {
  try {
    // Check if port is available
    const portAvailable = await isPortAvailable(PORT);
    if (!portAvailable) {
      logger.error(`Port ${PORT} is already in use!`);
      logger.error(`Please stop the process using port ${PORT} or run: .\\kill-ports.ps1`);
      logger.error(`On Windows, you can also run: Get-NetTCPConnection -LocalPort ${PORT} | Select-Object OwningProcess | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`);
      process.exit(1);
    }

    // Create HTTP server
    const httpServer = createServer(app);

    // Initialize Socket.IO
    const defaultAllowedOrigins = [
      'http://localhost:3000',
      'http://localhost:3001',
      'http://localhost:3002',
      'http://localhost:3003',
      'http://localhost:3004',
      'http://localhost:3005',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:3001',
      'http://127.0.0.1:3002',
      'http://127.0.0.1:3003',
      'http://127.0.0.1:3004',
      'http://127.0.0.1:3005',
    ];

    const allowedOrigins = new Set([
      ...(config.frontend.url ? [config.frontend.url] : []),
      ...defaultAllowedOrigins,
    ]);

    const io = new Server(httpServer, {
      cors: {
        origin: (origin, callback) => {
          if (!origin) return callback(null, true);
          if (
            allowedOrigins.has(origin) ||
            origin.includes('localhost') ||
            origin.includes('127.0.0.1') ||
            origin.endsWith('.onrender.com') ||
            process.env.NODE_ENV === 'development'
          ) {
            return callback(null, true);
          }
          callback(new Error('Not allowed by CORS'));
        },
        credentials: true,
        methods: ['GET', 'POST'],
      },
    });

    // Initialize socket handlers
    initializeSocket(io);

    // Setup Socket.IO connection handlers
    io.on('connection', (socket) => {
      setupSocketHandlers(socket);
    });

    // Start HTTP server immediately on 0.0.0.0 to satisfy cloud health checks instantly
    httpServer.listen(PORT, '0.0.0.0', () => {
      logger.info(`Server running on port ${PORT} (0.0.0.0)`);
      logger.info(`Environment: ${config.server.nodeEnv}`);
      logger.info(`Health check: http://0.0.0.0:${PORT}/health`);
      logger.info(`API base: http://0.0.0.0:${PORT}/api`);
      logger.info(`WebSocket server: ws://0.0.0.0:${PORT}`);
    });

    // Initialize database & background services asynchronously
    (async () => {
      // Connect to MongoDB
      logger.info('Connecting to database...');
      try {
        await connectDB();
        // Ensure primary admin account exists and is synchronized
        try {
          const { bootstrapDefaultAdmin } = await import('./users/user.service.js');
          await bootstrapDefaultAdmin();
        } catch (bootstrapError) {
          logger.warn('[SERVER] Admin bootstrap failed on startup:', bootstrapError.message);
        }

        // Clean up any scans previously abandoned in PROCESSING state
        try {
          const { cleanupStuckScans } = await import('./scans/scan.service.js');
          if (cleanupStuckScans) {
            await cleanupStuckScans();
          }
        } catch (cleanupError) {
          logger.debug('[SERVER] Cleanup stuck scans check:', cleanupError.message);
        }
      } catch (dbError) {
        logger.error('Initial MongoDB connection error (server will continue running and retry):', dbError.message);
      }

      // Initialize cache (optional - gracefully handles if Redis unavailable)
      try {
        const { initializeCache } = await import('./utils/cache.js');
        await initializeCache();
      } catch (error) {
        logger.warn('[SERVER] Failed to initialize cache:', error.message);
        logger.warn('[SERVER] Caching disabled. System will work without cache.');
      }

      // Initialize email service (optional - gracefully handles if SMTP not configured)
      try {
        await initializeEmailService();
      } catch (error) {
        logger.warn('[SERVER] Failed to initialize email service:', error.message);
        logger.warn('[SERVER] Email notifications disabled. System will work without email.');
      }

      // Initialize scan queue and processor (optional - gracefully handles if Redis unavailable)
      try {
        const scanQueue = createScanQueue();
        if (scanQueue) {
          setupScanProcessor(scanQueue);
          logger.info('[SERVER] Scan queue processor initialized');
        } else {
          logger.warn('[SERVER] Scan queue not available (Redis may not be running). Batch processing will use direct processing.');
        }
      } catch (error) {
        logger.warn('[SERVER] Failed to initialize scan queue:', error.message);
        logger.warn('[SERVER] Batch processing will use direct processing as fallback.');
      }

      // Initialize learning scheduler (optional - gracefully handles if Redis unavailable)
      try {
        const { initializeLearningScheduler } = await import('./learning/learning.scheduler.js');
        const learningQueue = await initializeLearningScheduler();
        if (learningQueue) {
          logger.info('[SERVER] Learning scheduler initialized');
        } else {
          logger.warn('[SERVER] Learning scheduler disabled (Redis is not configured).');
        }
      } catch (error) {
        logger.warn('[SERVER] Failed to initialize learning scheduler:', error.message);
        logger.warn('[SERVER] Self-learning will not run automatically.');
      }

      // Initialize ML service health checks (optional - gracefully handles if ML service unavailable)
      try {
        startHealthChecks();
        logger.info('[SERVER] ML service health checks started');
      } catch (error) {
        logger.warn('[SERVER] Failed to start ML service health checks:', error.message);
        logger.warn('[SERVER] ML service integration will use fallback detection.');
      }
    })();

    const server = httpServer;

    // Handle server errors
    server.on('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        logger.error(`Port ${PORT} is already in use!`);
        logger.error(`Please stop the process using port ${PORT} or run: .\\kill-ports.ps1`);
      } else {
        logger.error('Server error:', error);
      }
      process.exit(1);
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
};

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
  logger.error('Unhandled Promise Rejection:', err?.message || err);
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', err?.message || err);
});

// Start the server
startServer();

