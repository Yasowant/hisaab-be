import { EventEmitter } from "node:events";
import { Request, Response, NextFunction } from "express";

/**
 * Live updates: when something changes in a group, everyone with that group
 * open is told to reload. Kept in this server's memory, which is fine for one
 * server. With several servers behind a load balancer, swap this for Redis pub/sub.
 */
const bus = new EventEmitter();
bus.setMaxListeners(0); // one listener per open browser tab

export type GroupEvent = { type: "changed"; by: string; at: string };

export function publish(groupId: string, by: string) {
  bus.emit(groupId, { type: "changed", by, at: new Date().toISOString() } satisfies GroupEvent);
}

/** After any successful change to a group (not reads), tell its open pages. */
export const notifyGroupOnChange = (req: Request, res: Response, next: NextFunction) => {
  if (req.method !== "GET") {
    res.on("finish", () => {
      if (res.statusCode < 300 && req.group && req.user) publish(String(req.group._id), req.user.id);
    });
  }
  next();
};

/** GET /groups/:groupId/events: a Server-Sent Events stream that stays open. */
export function streamGroupEvents(req: Request, res: Response) {
  const groupId = String(req.group!._id);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // stop nginx from buffering the stream
  });
  res.write("retry: 5000\n\n");

  const send = (e: GroupEvent) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  bus.on(groupId, send);

  // A comment line every 25s keeps proxies from closing an idle connection
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);

  req.on("close", () => {
    clearInterval(ping);
    bus.off(groupId, send);
  });
}

// ---- Per-person channel (notifications) ----

export type UserEvent = { type: "notification"; at: string };

/** Tell one person's open tabs that they have a new notification. */
export function publishUser(userId: string) {
  bus.emit(`user:${userId}`, { type: "notification", at: new Date().toISOString() } satisfies UserEvent);
}

/** GET /me/events: Server-Sent Events for the signed-in person. */
export function streamUserEvents(req: Request, res: Response) {
  const channel = `user:${req.user!.id}`;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 5000\n\n");
  const send = (e: UserEvent) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  bus.on(channel, send);
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => {
    clearInterval(ping);
    bus.off(channel, send);
  });
}
