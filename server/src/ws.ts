/**
 * WebSocket hub for the togezer API.
 *
 * Attaches a `WebSocketServer` (from 'ws') to the HTTP server at path `/ws`
 * and tracks the live connections in a Set. `broadcast` is the single sink
 * the API layer and the simulation feed domain events into: each event is
 * JSON-encoded and fanned out to every currently OPEN client. Clients are
 * dropped from the set on error/close (and when a send fails), so a dead
 * socket can never block or break the broadcast loop.
 */

import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { WsEvent } from './types.js';

export interface WsHub {
  /** Fan a domain event out to every currently OPEN client. */
  broadcast(event: WsEvent): void;
  /** Terminate every client and close the WS server. */
  close(): void;
}

export function createWsHub(httpServer: Server): WsHub {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  const clients = new Set<WebSocket>();

  wss.on('connection', (client: WebSocket) => {
    clients.add(client);
    console.log(`[ws] client connected (${clients.size} open)`);
    client.on('close', () => {
      clients.delete(client);
      console.log(`[ws] client disconnected (${clients.size} open)`);
    });
    client.on('error', () => {
      clients.delete(client);
      client.terminate();
    });
  });

  function broadcast(event: WsEvent): void {
    const payload = JSON.stringify(event);
    for (const client of clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      // `error` is null on success (ws invokes the callback with null, not
      // undefined) — treat any truthy error as a dead client.
      client.send(payload, (error) => {
        if (error) clients.delete(client);
      });
    }
  }

  function close(): void {
    for (const client of clients) client.terminate();
    clients.clear();
    wss.close();
  }

  return { broadcast, close };
}
